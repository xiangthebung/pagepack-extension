/**
 * "Export as HTML" writes a file that stands on its own.
 *
 * A single-page save becomes that page with every resource inlined and every
 * script removed; a multi-page save becomes one document that carries all its
 * pages and a list to move between them. In both, nothing may be left that
 * would fetch — the same rule the reader lives by, checked by the same auditor.
 *
 * `substituteResources` is also held to its one-pass promise here, because the
 * reader's old `split().join()` per token is the reason a 30 MB page could not
 * be opened; a resolver that is called once per token occurrence and never
 * re-reads the output is the shape that scales.
 *
 * The multi-page file is then opened from disk in a real Chromium, because an
 * export that "works in any browser" is a claim about a browser: the page list
 * has to switch pages, and a link between two saved pages has to work from the
 * file, with no request leaving it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

import { auditOfflineMarkup } from "../url-surface.js";
import {
  annotateSavedLinks,
  buildExportDocument,
  buildPageExport,
  dataUrlToBlob,
  inertResolver,
  packBytes,
  safeFileName,
  substituteResources,
} from "../pack-render.js";

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const CSS = "data:text/css;base64,Ym9keXtjb2xvcjojMjIyfQ==";

function page(url, title, extra = "") {
  return {
    url,
    title,
    html: `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="__PAGEPACK_RESOURCE_0__"><script src="__PAGEPACK_RESOURCE_2__"></script></head>`
      + `<body onload="track()"><h1>${title}</h1><img src="__PAGEPACK_RESOURCE_1__" alt=""><img src="__PAGEPACK_RESOURCE_9__" alt="missing">`
      + `<div style="background:url(__PAGEPACK_RESOURCE_1__)"></div><script>document.write("no")</script>${extra}</body></html>`,
    resources: [],
    resourceMap: {
      __PAGEPACK_RESOURCE_0__: CSS,
      __PAGEPACK_RESOURCE_1__: PIXEL,
      __PAGEPACK_RESOURCE_2__: "data:text/javascript;base64,YWxlcnQoMSk=",
      __PAGEPACK_RESOURCE_9__: "",
      __PAGEPACK_RESOURCE_8__: "https://site.test/legacy-remote.png",
    },
  };
}

const single = {
  id: "pack_single",
  title: "One page",
  rootUrl: "https://site.test/one",
  savedAt: Date.UTC(2026, 8, 1),
  pages: [page("https://site.test/one", "One page", '<a href="https://site.test/two">elsewhere</a><a href="/one#top">here</a>')],
};

/* ------------------------------------------------------------------ *
 * A single page
 * ------------------------------------------------------------------ */

const one = buildExportDocument(single);
assert.deepEqual(auditOfflineMarkup(one, { allowLazyAttributes: false }), [], `the single-page export still reaches the network:\n${one}`);
assert.doesNotMatch(one, /<script\b/i, "scripts survived into a static export");
assert.doesNotMatch(one, /\bonload=/i, "an event handler attribute survived");
assert.doesNotMatch(one, /__PAGEPACK_RESOURCE_/, "a resource token was left in the export");
assert.match(one, /href="data:text\/css;base64,/);
assert.match(one, /<img src="data:image\/gif;base64,/);
assert.match(one, /<img src="" alt="missing">/, "a failed resource resolves to nothing, not an address");
assert.doesNotMatch(one, /legacy-remote\.png/, "a legacy remote value was written out");
assert.match(one, /^<!-- Saved with PagePack from https:\/\/site\.test\/one on 2026-09-01T00:00:00\.000Z\./);
assert.match(one, /<meta charset="utf-8">/);
// Links to pages outside the save are left as the author wrote them.
assert.match(one, /<a href="https:\/\/site\.test\/two">elsewhere<\/a>/);

/* ------------------------------------------------------------------ *
 * A whole pack
 * ------------------------------------------------------------------ */

const pack = {
  id: "pack_multi",
  title: "A guide",
  rootUrl: "https://site.test/guide",
  savedAt: Date.UTC(2026, 8, 1),
  updatedAt: Date.UTC(2026, 8, 2),
  pages: [
    page("https://site.test/guide", "A guide", '<a href="/guide/water">water</a><a href="https://site.test/guide/maps#fold" target="_blank">maps</a><a href="/elsewhere">out</a>'),
    page("https://site.test/guide/water", "Water", '<a href="/guide">back</a>'),
    page("https://site.test/guide/maps", "Maps & folding", ""),
  ],
};

const whole = buildExportDocument(pack);
assert.match(whole, /<title>A guide<\/title>/);
assert.match(whole, /3 pages · saved/);
// Every page is held inert until shown, in order, with the script terminator escaped.
const holders = [...whole.matchAll(/<script type="text\/pagepack-page" id="page-(\d+)" data-url="([^"]*)">/g)];
assert.deepEqual(holders.map((match) => [match[1], match[2]]), [
  ["0", "https://site.test/guide"],
  ["1", "https://site.test/guide/water"],
  ["2", "https://site.test/guide/maps"],
]);
assert.doesNotMatch(whole.replace(/<script type="text\/pagepack-page"[^>]*>|<\/script>/g, ""), /<\/script/i, "a page's own </script> would end its holder early");
// The page list names each page, escaped.
assert.match(whole, /<strong>Maps &amp; folding<\/strong>/);
// In-pack links become anchors the file can follow; the outside link stays.
assert.match(whole, /<a href="#page-1" target="_top" data-pagepack-saved-link="true" title="Saved in this pack">water<\/a>/);
assert.match(whole, /<a href="#page-2" target="_top" data-pagepack-saved-link="true" title="Saved in this pack">maps<\/a>/);
assert.match(whole, /<a href="\/elsewhere">out<\/a>/);
// And, stripped of its holders, the document itself fetches nothing. The
// auditor reports every `<iframe>`, because a captured page must never carry
// one; the shell's frame is its own, has no `src`, and is only ever given
// `srcdoc` — inline text, no request. That is the one finding, and it is named
// here so anything else the shell grows is still caught.
const shell = whole.replace(/<script type="text\/pagepack-page"[\s\S]*?<\/script>/g, "");
const shellFindings = auditOfflineMarkup(shell);
assert.deepEqual(shellFindings.map((finding) => [finding.construct, finding.element]), [["element", "iframe"]], `the export shell reaches the network: ${JSON.stringify(shellFindings)}`);
assert.doesNotMatch(shellFindings[0].value, /\bsrc\s*=/, "the page frame must not carry a src");
assert.doesNotMatch(shell, /\.src\s*=|setAttribute\("src"/, "the shell's script must only ever assign srcdoc");
for (const [index] of pack.pages.entries()) {
  const inner = buildPageExport(pack, index);
  assert.deepEqual(auditOfflineMarkup(inner, { allowLazyAttributes: false }), [], `page ${index} of the export reaches the network`);
}

/* ------------------------------------------------------------------ *
 * The pieces
 * ------------------------------------------------------------------ */

// One pass: the resolver sees each occurrence exactly once, and a value that
// itself contains a token is not re-expanded.
const calls = [];
const substituted = substituteResources("a __PAGEPACK_RESOURCE_0__ b __PAGEPACK_RESOURCE_1__ c __PAGEPACK_RESOURCE_0__", (token) => {
  calls.push(token);
  return token === "__PAGEPACK_RESOURCE_0__" ? "__PAGEPACK_RESOURCE_1__" : "X";
});
assert.equal(substituted, "a __PAGEPACK_RESOURCE_1__ b X c __PAGEPACK_RESOURCE_1__");
assert.deepEqual(calls, ["__PAGEPACK_RESOURCE_0__", "__PAGEPACK_RESOURCE_1__", "__PAGEPACK_RESOURCE_0__"]);
assert.equal(substituteResources("no tokens here", () => { throw new Error("must not be called"); }), "no tokens here");

// The inert resolver answers only with data: or blob: values.
const resolve = inertResolver({ a: PIXEL, b: "https://x.test/y.png", c: "", d: 42 });
assert.equal(resolve("a"), PIXEL);
assert.equal(resolve("b"), "");
assert.equal(resolve("c"), "");
assert.equal(resolve("d"), "");
assert.equal(resolve("missing"), "");

// Base64 and percent-encoded data URLs both decode; anything else is null.
const gif = dataUrlToBlob(PIXEL);
assert.equal(gif.type, "image/gif");
assert.equal(gif.size, 42);
const text = dataUrlToBlob("data:text/plain,hello%20world");
assert.equal(text.type, "text/plain");
assert.equal(await text.text(), "hello world");
assert.equal(dataUrlToBlob("https://x.test/a.png"), null);
assert.equal(dataUrlToBlob(""), null);

// A page's weight is its markup plus everything inlined.
assert.equal(packBytes({ pages: [{ html: "abc", resourceMap: { t: "12345" } }, { html: "", resourceMap: {} }] }), 8);

// File names are safe on every platform and never empty.
assert.equal(safeFileName('Notes: "water" / <ford>?'), "Notes water ford.html");
assert.equal(safeFileName(""), "saved-page.html");
assert.equal(safeFileName("x".repeat(200)).length, 85);

// Annotation without a rewrite keeps the href.
const annotated = annotateSavedLinks('<a href="/guide/water">w</a><a href="/out">o</a>', pack, "https://site.test/guide");
assert.equal(annotated, '<a href="/guide/water" data-pagepack-saved-link="true" title="Saved in this pack">w</a><a href="/out">o</a>');

/* ------------------------------------------------------------------ *
 * The file, opened from disk
 * ------------------------------------------------------------------ */

const dir = await mkdtemp(join(tmpdir(), "pagepack-export-"));
const file = join(dir, safeFileName(pack.title));
await writeFile(file, whole);
const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  const tab = await browser.newPage();
  const requests = [];
  tab.on("request", (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(pathToFileURL(file).href);
  const frame = () => tab.frames().find((candidate) => candidate !== tab.mainFrame());
  assert.ok(frame(), "the export has no page frame");
  await frame().waitForFunction(() => /A guide/.test(document.body?.innerText || ""), null, { timeout: 5000 });
  assert.equal(await tab.title(), "A guide");
  // The list beside the page switches pages.
  await tab.click('nav a[data-page="1"]');
  await frame().waitForFunction(() => /^Water/.test((document.body?.innerText || "").trim()), null, { timeout: 5000 });
  assert.equal(await tab.evaluate(() => document.querySelector("nav a.is-current")?.getAttribute("data-page")), "1");
  assert.equal(await tab.title(), "Water");
  // And a link between two saved pages works from inside the page itself.
  await frame().click('a[href="#page-0"]');
  await frame().waitForFunction(() => /A guide/.test(document.body?.innerText || ""), null, { timeout: 5000 });
  assert.match(tab.url(), /#page-0$/);
  assert.equal(await tab.evaluate(() => document.querySelector("nav a.is-current")?.getAttribute("data-page")), "0");
  // The inlined image decoded inside the frame, from a data: URL.
  const image = await frame().evaluate(() => {
    const first = document.images[0];
    return { src: first?.src.slice(0, 22), decoded: Boolean(first?.complete && first.naturalWidth > 0) };
  });
  assert.equal(image.src, "data:image/gif;base64,");
  assert.equal(image.decoded, true, "the inlined image did not decode from the file");
  assert.deepEqual(errors, [], `the export threw:\n${errors.join("\n")}`);
  assert.deepEqual(requests, [], `the export reached the network:\n${requests.join("\n")}`);
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log("Export tests passed");

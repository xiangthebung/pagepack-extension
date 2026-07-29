/**
 * `srcset` on a page that was fetched rather than read out of the tab.
 *
 * A page saved as a followed link goes through `extractAndTokenizeResources` in
 * `background.js`, not through `content.js`. It used to rewrite `src`, `href` and
 * `poster` only, so a responsive figure kept its original remote `srcset`; the
 * browser prefers a `srcset` candidate over `src`, so offline the reader asked the
 * network for an image it had already saved and drew a broken one instead.
 *
 * These tests read markup through the real function — with `chrome` stubbed, since
 * importing the service worker registers its listeners — rather than against a
 * copy of its parsing, so they fail if the followed-link path stops tokenising
 * `srcset` again. The last block compares the parser against its twin in
 * `content.js`, which is the one thing a deliberate copy needs a test for.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

// The service worker registers `chrome.runtime`, `chrome.webNavigation` and
// `chrome.tabs` listeners as it loads. A proxy that answers every property with
// itself covers all of them without a stub that has to grow alongside the file.
// `lastError` and `then` return undefined so nothing reads a callback failure or
// mistakes the stub for a promise.
const chromeStub = new Proxy(function () {}, {
  get: (target, property) => (property === "lastError" || property === "then" ? undefined : chromeStub),
  apply: () => undefined,
});
globalThis.chrome = chromeStub;

const { extractAndTokenizeResources } = await import("../background.js");

const PAGE_URL = "https://example.test/notes/water";
const CAPTURE_OPTIONS = { runScripts: true, captureMedia: true };

function tokenize(html, options = {}) {
  return extractAndTokenizeResources(html, PAGE_URL, { ...CAPTURE_OPTIONS, ...options });
}

function srcsetAttribute(html) {
  return html.match(/\ssrcset="([^"]*)"/i)?.[1] ?? null;
}

/* ------------------------------------------------------------------ *
 * Every candidate is tokenised, on both elements that carry a srcset
 * ------------------------------------------------------------------ */

const responsive = tokenize(`<figure>
  <img src="/img/water-0.png" srcset="/img/water-0.png 1x, /img/water-0@2x.png 2x, https://cdn.example.test/water-0@3x.png 3x" alt="">
</figure>`);
// The candidate that repeats `src` is the same resource, so this figure costs three
// files rather than four, and both attributes point at the same saved copy.
assert.deepEqual(responsive.resources.map((resource) => resource.url), [
  "https://example.test/img/water-0.png",
  "https://example.test/img/water-0@2x.png",
  "https://cdn.example.test/water-0@3x.png",
]);
assert.equal(srcsetAttribute(responsive.html), "__PAGEPACK_RESOURCE_0__ 1x, __PAGEPACK_RESOURCE_1__ 2x, __PAGEPACK_RESOURCE_2__ 3x");
assert.match(responsive.html, /\ssrc="__PAGEPACK_RESOURCE_0__"/);
// Nothing addressable is left pointing at the network.
assert.equal(/https?:\/\//.test(responsive.html), false);

const picture = tokenize(`<picture>
  <source media="(min-width: 60em)" srcset="/img/wide.png 1x, /img/wide@2x.png 2x">
  <source srcset="/img/narrow.png">
  <img src="/img/fallback.png" alt="">
</picture>`);
assert.deepEqual(picture.resources.map((resource) => resource.url), [
  "https://example.test/img/wide.png",
  "https://example.test/img/wide@2x.png",
  "https://example.test/img/narrow.png",
  "https://example.test/img/fallback.png",
]);
assert.equal(/https?:\/\//.test(picture.html), false);
// Candidates are collected whether or not media capture is on, because a picture
// source is an image: switching media off must not leave a remote candidate behind.
assert.deepEqual(
  tokenize('<picture><source srcset="/img/wide.png 2x"></picture>', { captureMedia: false }).resources.map((resource) => resource.url),
  ["https://example.test/img/wide.png"],
);

// A preload link is removed whole, so its `imagesrcset` cannot leak a remote URL
// into the saved page. The same is true of the live-tab path, which drops every
// link that is not a stylesheet.
const preload = tokenize('<link rel="preload" as="image" href="/img/hero.png" imagesrcset="/img/hero.png 1x, /img/hero@2x.png 2x">');
assert.equal(preload.html.trim(), "");
assert.deepEqual(preload.resources, []);

/* ------------------------------------------------------------------ *
 * The awkward shapes a srcset can take
 * ------------------------------------------------------------------ */

// A comma inside a URL is part of the URL: only a comma at the end of one ends
// the candidate. Splitting on commas would have asked for "/img/crop" and "600".
const commaInUrl = tokenize('<img srcset="/img/crop,600,400.png 1x, /img/crop,1200,800.png 2x">');
assert.deepEqual(commaInUrl.resources.map((resource) => resource.url), [
  "https://example.test/img/crop,600,400.png",
  "https://example.test/img/crop,1200,800.png",
]);
assert.equal(srcsetAttribute(commaInUrl.html), "__PAGEPACK_RESOURCE_0__ 1x, __PAGEPACK_RESOURCE_1__ 2x");

// No whitespace after the comma, so by the HTML rules this is one URL, not two —
// and the browser will request exactly this one string.
const unspacedComma = tokenize('<img srcset="/img/one.png,/img/two.png">');
assert.deepEqual(unspacedComma.resources.map((resource) => resource.url), ["https://example.test/img/one.png,/img/two.png"]);

// A descriptor ends at the comma, with no space needed after it, and the last
// candidate may have no descriptor at all.
const mixedDescriptors = tokenize('<img srcset="/img/a.png 640w,/img/b.png 320w,/img/c.png">');
assert.deepEqual(mixedDescriptors.resources.map((resource) => resource.url), [
  "https://example.test/img/a.png",
  "https://example.test/img/b.png",
  "https://example.test/img/c.png",
]);
assert.equal(srcsetAttribute(mixedDescriptors.html), "__PAGEPACK_RESOURCE_0__ 640w,__PAGEPACK_RESOURCE_1__ 320w,__PAGEPACK_RESOURCE_2__");

// Whitespace and separators are copied through as written, including the newlines
// of a wrapped attribute and a trailing comma, so only the URLs change.
const wrapped = tokenize('<img srcset="\n      /img/a.png 1x,\n      /img/b.png 2x,\n    ">');
assert.equal(srcsetAttribute(wrapped.html), "\n      __PAGEPACK_RESOURCE_0__ 1x,\n      __PAGEPACK_RESOURCE_1__ 2x,\n    ");

// Repeated separators are legal and must not mint an empty resource.
const emptyCandidates = tokenize('<img srcset=" , , /img/a.png 1x , , ">');
assert.deepEqual(emptyCandidates.resources.map((resource) => resource.url), ["https://example.test/img/a.png"]);
assert.equal(srcsetAttribute(emptyCandidates.html), " , , __PAGEPACK_RESOURCE_0__ 1x , , ");

// Inline data and unresolvable candidates are left exactly as they are: there is
// nothing to fetch, and the data URL's own comma must not be read as a separator.
const inline = tokenize('<img srcset="data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x, /img/a.png 2x">');
assert.deepEqual(inline.resources.map((resource) => resource.url), ["https://example.test/img/a.png"]);
assert.equal(srcsetAttribute(inline.html), "data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x, __PAGEPACK_RESOURCE_0__ 2x");

// The same candidate twice, and once more as another element's `src`, is one
// resource and one token — the saved page must not fetch it three times.
const repeated = tokenize('<img srcset="/img/a.png 1x, /img/a.png 2x"><img src="/img/a.png">');
assert.equal(repeated.resources.length, 1);
assert.equal(srcsetAttribute(repeated.html), "__PAGEPACK_RESOURCE_0__ 1x, __PAGEPACK_RESOURCE_0__ 2x");

// A single-quoted attribute, an uppercase name, and a descriptor holding a comma
// inside parentheses.
const quoting = tokenize("<IMG SRCSET='/img/a.png 1x, /img/b.png (min-width: 10px, 2x)'>");
assert.deepEqual(quoting.resources.map((resource) => resource.url), [
  "https://example.test/img/a.png",
  "https://example.test/img/b.png",
]);
assert.equal(quoting.html.match(/srcset='([^']*)'/i)[1], "__PAGEPACK_RESOURCE_0__ 1x, __PAGEPACK_RESOURCE_1__ (min-width: 10px, 2x)");

// Candidates resolve against the page that was fetched, exactly as `src` does.
const relative = tokenize('<img src="pool.png" srcset="pool.png 1x, ../shared/pool@2x.png 2x">');
assert.deepEqual(relative.resources.map((resource) => resource.url), [
  "https://example.test/notes/pool.png",
  "https://example.test/shared/pool@2x.png",
]);

// An empty attribute stays empty rather than becoming a token.
assert.equal(srcsetAttribute(tokenize('<img srcset="">').html), "");

/* ------------------------------------------------------------------ *
 * The rest of the fetched-page rewrite still works
 * ------------------------------------------------------------------ */

const others = tokenize(`<link rel="stylesheet" href="/style.css">
<video src="/media/clip.mp4" poster="/img/poster.png"></video>
<div style="background-image:url(/img/tile.png)"></div>`);
assert.deepEqual(others.resources.map((resource) => `${resource.kind} ${resource.url}`), [
  "style https://example.test/style.css",
  "media https://example.test/media/clip.mp4",
  "asset https://example.test/img/tile.png",
]);

/* ------------------------------------------------------------------ *
 * The copy in content.js has to agree, candidate for candidate
 * ------------------------------------------------------------------ */

// Line endings are normalised so the comparison is about the code, not about which
// editor last touched each file.
const readSource = async (name) => (await readFile(new URL(`../${name}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const functionPattern = /^function rewriteSrcset\(value, collect, baseUrl\) \{\n[\s\S]*?\n\}$/m;
const contentFunction = (await readSource("content.js")).match(functionPattern)?.[0];
const backgroundFunction = (await readSource("background.js")).match(functionPattern)?.[0];
assert.ok(contentFunction, "content.js no longer defines rewriteSrcset(value, collect, baseUrl)");
assert.ok(backgroundFunction, "background.js no longer defines rewriteSrcset(value, collect, baseUrl)");
// The two files cannot import from each other, so the copy is checked instead:
// a saved page must not depend on which path collected it.
assert.equal(contentFunction, backgroundFunction);

// Run the live-tab copy on its own, against a collector that mints tokens the way
// the service worker's does, and hold it to the output of the fetched-page path.
const { rewriteSrcset } = vm.runInNewContext(`${contentFunction}\n({ rewriteSrcset });`, {}, { filename: "content.js" });
function liveTabCollector() {
  const seen = new Map();
  return (value, kind, baseUrl) => {
    let url;
    try {
      url = new URL(value, baseUrl);
    } catch {
      return null;
    }
    url.hash = "";
    if (!/^https?:$/i.test(url.protocol)) return null;
    const key = `${kind}:${url.href}`;
    if (!seen.has(key)) seen.set(key, `__PAGEPACK_RESOURCE_${seen.size}__`);
    return seen.get(key);
  };
}

for (const value of [
  "/img/water-0.png 1x, /img/water-0@2x.png 2x, https://cdn.example.test/water-0@3x.png 3x",
  "/img/crop,600,400.png 1x, /img/crop,1200,800.png 2x",
  "/img/one.png,/img/two.png",
  "/img/a.png 640w,/img/b.png,/img/c.png 1280w",
  "\n      /img/a.png 1x,\n      /img/b.png 2x,\n    ",
  " , , /img/a.png 1x , , ",
  "data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x, /img/a.png 2x",
  "/img/a.png 1x, /img/a.png 2x",
  "pool.png 1x, ../shared/pool@2x.png 2x",
  "/img/a.png,",
  "/img/a.png (min-width: 10px, 2x)",
  "",
]) {
  const fetched = tokenize(`<img srcset="${value}">`);
  assert.equal(srcsetAttribute(fetched.html), rewriteSrcset(value, liveTabCollector(), PAGE_URL), `srcset disagreed for: ${value}`);
}

console.log("Responsive image (srcset) tokenization tests passed");

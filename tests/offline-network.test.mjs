/**
 * The offline guarantee, measured rather than inspected.
 *
 * `tests/offline-guarantee.test.mjs` reads the saved markup and asserts nothing
 * addressable is left in it. That is necessary and not sufficient: it proves the
 * rewriter's output, not the browser's behaviour. This file opens a real Chromium,
 * renders a real pack through the real `sandbox.html` under the real
 * content-security policy taken from `manifest.json`, and counts requests.
 *
 * The measurement is taken twice, once for each way a page enters a pack:
 *
 *   - the tab you are looking at, captured by `prepareDocument` in `content.js`
 *   - a followed link, fetched and rewritten by `extractAndTokenizeResources`
 *
 * Two origins are served. The *site* origin holds the page being saved and every
 * asset on it; after the save it must receive nothing. The *reader* origin holds
 * `sandbox.html` and stands in for `chrome-extension://…`. Requests are counted
 * twice over — by Playwright, which sees every attempt including ones to hosts
 * that do not resolve, and by the site server itself, which is the ground truth
 * for what actually arrived.
 *
 * Three of the checks below deliberately assert that something *does* reach the
 * network. They are the mutation tests for the two claims this design rests on:
 * that the policy really refuses a subresource capture missed, and that it really
 * does not stop a `<meta http-equiv="refresh">` — which is why that one has to be
 * removed at capture time and cannot be left to the reader.
 *
 * **What this file will not catch on its own, and why that is correct.** Breaking
 * the strip in *one* layer leaves every check here passing, because the other
 * layer still holds: disable it in `extractAndTokenizeResources` and the reader's
 * own pass in `hydrateMarkup` still removes it; disable it in both and the last
 * check fails. That was measured, not assumed. It is the intended shape — a
 * single regression should not be able to reach the user — but it does mean this
 * file is not a regression test for either layer alone.
 * `tests/offline-guarantee.test.mjs` is, and it fails on the capture layer by
 * itself. Run both.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { stripNetworkElements } from "../url-surface.js";

const chromeStub = new Proxy(function () {}, {
  get: (target, property) => (property === "lastError" || property === "then" ? undefined : chromeStub),
  apply: () => undefined,
});
globalThis.chrome = chromeStub;

const { extractAndTokenizeResources } = await import("../background.js");

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const repo = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));

const fixture = await readFile(here("./fixtures/torture-page.html"), "utf8");
const manifest = JSON.parse(await readFile(repo("manifest.json"), "utf8"));
const sandboxHtml = await readFile(repo("sandbox.html"), "utf8");
const sandboxJs = await readFile(repo("sandbox.js"), "utf8");
const contentJs = await readFile(repo("content.js"), "utf8");
const viewerJs = await readFile(repo("viewer.js"), "utf8");

// A 1x1 transparent GIF, the stand-in for every saved asset.
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/* ------------------------------------------------------------------ *
 * The reader's own rules, read from the source rather than restated
 * ------------------------------------------------------------------ */

const SANDBOX_CSP = manifest.content_security_policy.sandbox;
const FRAME_SANDBOX = viewerJs.match(/const FRAME_SANDBOX = "([^"]*)"/)?.[1];
assert.ok(FRAME_SANDBOX, "could not read FRAME_SANDBOX out of viewer.js");

/* The reader hands the sandbox a page with its tokens expanded and nothing else
   that resolves a URL. These two assertions are what let this file rebuild that
   step instead of importing `hydrateMarkup`, which cannot be imported here
   because `viewer.js` pulls in `storage.js` and the extension APIs.

   If either stops holding, the rebuild below is no longer faithful and this test
   would be measuring something the reader does not do. */
/* Comments are stripped before these are checked. The comment in `viewer.js` that
   explains why there is no longer a `<base>` naturally contains the words it is
   warning about, and matching prose instead of code made this assertion fail on a
   correct file. */
const viewerCode = viewerJs
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|\s)\/\/[^\n]*/g, "$1");

assert.equal(
  /<base\b/.test(viewerCode), false,
  "viewer.js injects a <base> again; a missed relative URL would resolve to the live origin and this test would no longer model the reader",
);
assert.match(viewerCode, /markup = stripNetworkElements\(markup\)/, "viewer.js no longer strips network elements from old packs");
assert.equal(/allow-popups/.test(FRAME_SANDBOX), false, "the reader frame allows popups again; a saved script could open the live site");

/* A resource that failed to download must resolve to nothing in the saved page.
   Writing its original address there instead — which is what "keep the original
   URL as a recoverable fallback" did — puts a live URL inside the pack for every
   image that happened to 404 during the save. It cannot be caught by rendering,
   because the policy refuses it, which is exactly why it survived so long. */
const backgroundCode = (await readFile(repo("background.js"), "utf8"))
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|\s)\/\/[^\n]*/g, "$1");
assert.equal(
  /resourceMap\[resource\.token\]\s*=\s*resource\.url/.test(backgroundCode), false,
  "a failed resource is being saved as its original remote URL again",
);

/** Expand resource tokens the way the reader does, and strip what it strips. */
function hydrate(html, resources) {
  let markup = stripNetworkElements(String(html || ""));
  for (const resource of resources) markup = markup.split(resource.token).join(PIXEL);
  return markup;
}

/* ------------------------------------------------------------------ *
 * Two origins
 * ------------------------------------------------------------------ */

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const siteHits = [];
const site = await listen((request, response) => {
  siteHits.push(request.url);
  if (request.url.startsWith("/torture")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixture);
    return;
  }
  if (request.url.endsWith(".css")) {
    response.writeHead(200, { "content-type": "text/css" });
    response.end("body { color: #222; }");
    return;
  }
  if (request.url.endsWith(".js")) {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end("window.__siteScriptRan = true;");
    return;
  }
  response.writeHead(200, { "content-type": "image/gif" });
  response.end(Buffer.from(PIXEL.split(",")[1], "base64"));
});

const reader = await listen((request, response) => {
  if (request.url.startsWith("/sandbox.js")) {
    // The sandbox document's policy applies to the document, not to this file.
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(sandboxJs);
    return;
  }
  if (request.url.startsWith("/sandbox.html")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": SANDBOX_CSP });
    response.end(sandboxHtml);
    return;
  }
  // The harness stands in for viewer.html: it frames the sandbox exactly as the
  // reader does and relays the same messages.
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><meta charset="utf-8"><title>harness</title>
<iframe id="frame" sandbox="${FRAME_SANDBOX}" src="/sandbox.html"></iframe>
<script>
  window.__ready = new Promise((resolve) => {
    window.addEventListener("message", (event) => {
      if (event.data && event.data.source === "pagepack-sandbox" && event.data.type === "ready") resolve();
    });
  });
  window.__rendered = [];
  window.__navigated = null;
  window.addEventListener("message", (event) => {
    if (event.data && event.data.source === "pagepack-sandbox" && event.data.type === "rendered") window.__rendered.push(event.data);
    if (event.data && event.data.source === "pagepack-saved-page") window.__navigated = event.data;
  });
  window.__render = async function (markup, runScripts) {
    const frame = document.getElementById("frame").contentWindow;
    await window.__ready;
    window.__rendered.length = 0;
    frame.postMessage({ source: "pagepack-viewer", type: "load-start", runScripts: runScripts, renderAttempt: 1 }, "*");
    frame.postMessage({ source: "pagepack-viewer", type: "load-chunk", renderAttempt: 1, chunk: markup }, "*");
    frame.postMessage({ source: "pagepack-viewer", type: "load-end", renderAttempt: 1 }, "*");
  };
</script>`);
});

/* ------------------------------------------------------------------ *
 * The measurement
 * ------------------------------------------------------------------ */

const browser = await chromium.launch();

/**
 * Render markup in the real sandbox and report every request that left the
 * reader's own origin.
 */
async function measure(markup, { runScripts = false, settle = 2200 } = {}) {
  const context = await browser.newContext();
  const attempted = [];
  // Every request the browser makes, including ones to a host that cannot
  // resolve — those never reach a server, so a server-side count alone would
  // miss them.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (!url.startsWith(reader.origin)) attempted.push(url);
    route.continue().catch(() => {});
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

  siteHits.length = 0;
  await page.goto(`${reader.origin}/harness`);
  await page.evaluate(([html, scripts]) => window.__render(html, scripts), [markup, runScripts]);
  await page.waitForTimeout(settle);

  const rendered = await page.evaluate(() => window.__rendered);
  const navigated = await page.evaluate(() => window.__navigated);
  const frameUrl = page.frames()[1]?.url() ?? "";
  const text = await page.frames()[1]?.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  await context.close();
  return { attempted, received: [...siteHits], rendered, navigated, frameUrl, text, consoleErrors };
}

const failures = [];
function check(name, run) {
  return run().then(
    () => console.log(`  ok  ${name}`),
    (error) => { failures.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}\n       ${error.message}`); },
  );
}

/* ------------------------------------------------------------------ *
 * 1. A followed link, captured by the service worker
 * ------------------------------------------------------------------ */

await check("a fetched page makes no request off the reader's origin", async () => {
  const captured = extractAndTokenizeResources(fixture, `${site.origin}/torture`, { runScripts: true, captureMedia: true });
  const result = await measure(hydrate(captured.html, captured.resources), { runScripts: true });
  assert.deepEqual(result.attempted, [], `the reader reached the network:\n${result.attempted.join("\n")}`);
  assert.deepEqual(result.received, [], `the site origin was contacted:\n${result.received.join("\n")}`);
  assert.match(result.text, /Torture page/, "the page did not actually render, so the zero above proves nothing");
});

/* ------------------------------------------------------------------ *
 * 2. The live tab, captured by the content script
 * ------------------------------------------------------------------ */

await check("a page captured from the live tab makes no request off the reader's origin", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${site.origin}/torture`, { waitUntil: "load" });
  // `content.js` is an IIFE that ends by registering a `chrome.runtime` listener.
  // Unwrap it to reach `prepareDocument`, which is the function the extension
  // actually runs in the tab, and stub the one API it touches on the way past.
  const captured = await page.evaluate((source) => {
    window.chrome = { runtime: { onMessage: { addListener() {} }, connect() {} } };
    const body = source.replace(/^\(\(\)\s*=>\s*\{/, "").replace(/\}\)\(\);?\s*$/, "");
    // eslint-disable-next-line no-new-func
    const prepareDocument = new Function(`${body}\nreturn prepareDocument;`)();
    return prepareDocument({ runScripts: true, captureMedia: true });
  }, contentJs);
  await context.close();

  assert.ok(captured.resources.length > 10, `the live capture found almost nothing (${captured.resources.length} resources)`);
  const result = await measure(hydrate(captured.html, captured.resources), { runScripts: true });
  assert.deepEqual(result.attempted, [], `the reader reached the network:\n${result.attempted.join("\n")}`);
  assert.deepEqual(result.received, [], `the site origin was contacted:\n${result.received.join("\n")}`);
  assert.match(result.text, /Torture page/, "the page did not actually render, so the zero above proves nothing");
});

/* ------------------------------------------------------------------ *
 * 3. The policy really is a backstop — mutation test
 * ------------------------------------------------------------------ */

await check("the sandbox policy refuses a remote image that capture missed", async () => {
  const result = await measure(`<!doctype html><p>missed</p><img src="${site.origin}/assets/missed.png" alt="">`);
  assert.deepEqual(result.received, [], "the policy let a remote image through; the whole backstop argument fails");
});

await check("the sandbox policy refuses a remote stylesheet, font and fetch()", async () => {
  const result = await measure(`<!doctype html>
    <link rel="stylesheet" href="${site.origin}/assets/missed.css">
    <style>@font-face{font-family:X;src:url(${site.origin}/assets/missed.woff2)}</style>
    <p style="font-family:X">missed</p>
    <script>fetch(${JSON.stringify(`${site.origin}/assets/beacon`)}).catch(function(){});<\/script>`, { runScripts: true });
  assert.deepEqual(result.received, [], `the policy let something through:\n${result.received.join("\n")}`);
});

await check("a saved script promoting data-src to src is refused", async () => {
  // The reason capture leaves `data-src` alone: nothing loads it, and the one
  // thing that can act on it is refused. This measures that rather than assuming.
  const result = await measure(`<!doctype html><p>lazy</p>
    <img id="lazy" data-src="${site.origin}/assets/lazy-promoted.png" alt="">
    <script>var n=document.getElementById('lazy');n.src=n.getAttribute('data-src');<\/script>`, { runScripts: true });
  assert.deepEqual(result.received, [], "a lazy-loaded image reached the network");
});

/* ------------------------------------------------------------------ *
 * 4. The policy is NOT a backstop for navigation — the reason meta
 *    refresh has to be stripped at capture. Mutation test.
 * ------------------------------------------------------------------ */

await check("a meta refresh is NOT stopped by the policy, which is why capture removes it", async () => {
  const result = await measure(`<!doctype html><meta http-equiv="refresh" content="0;url=${site.origin}/refresh-target"><p>refreshing</p>`, { settle: 2500 });
  assert.ok(
    result.received.some((url) => url.includes("refresh-target")) || result.frameUrl.includes("refresh-target"),
    "the meta refresh did not navigate. If a browser has started refusing it, say so in url-surface.js — but do not stop stripping it.",
  );
});

await check("that same page, once captured, does not navigate", async () => {
  const captured = extractAndTokenizeResources(
    `<!doctype html><meta http-equiv="refresh" content="0;url=${site.origin}/refresh-target"><p>refreshing</p>`,
    `${site.origin}/torture`, { runScripts: true, captureMedia: true },
  );
  const result = await measure(hydrate(captured.html, captured.resources), { settle: 2500 });
  assert.deepEqual(result.received, [], "the captured page still navigated to the live site");
  assert.deepEqual(result.attempted, [], "the captured page still reached the network");
});

/* ------------------------------------------------------------------ *
 * 5. Links are intercepted, including target="_blank"
 * ------------------------------------------------------------------ */

await check("a link click is reported to the reader instead of navigating", async () => {
  // The bridge the reader injects, reduced to the part under test.
  const bridge = `<script>(function(){
    var PAGE_URL = ${JSON.stringify(`${site.origin}/torture`)};
    document.addEventListener('click', function(event){
      if (event.button !== 0) return;
      var target = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
      var link = target && target.closest ? target.closest('a[href]') : null;
      if (!link) return;
      var href = link.getAttribute('href');
      if (!href || href.charAt(0) === '#') return;
      event.preventDefault();
      try { parent.postMessage({source:'pagepack-saved-page', type:'link', href:new URL(href, PAGE_URL).href}, '*'); } catch (_) {}
    }, true);
  }());<\/script>`;
  const context = await browser.newContext();
  const attempted = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (!url.startsWith(reader.origin)) attempted.push(url);
    route.continue().catch(() => {});
  });
  const page = await context.newPage();
  siteHits.length = 0;
  await page.goto(`${reader.origin}/harness`);
  await page.evaluate(([html]) => window.__render(html, true), [
    `<!doctype html><a id="blank" href="${site.origin}/elsewhere" target="_blank">open elsewhere</a>${bridge}`,
  ]);
  await page.waitForTimeout(800);
  await page.frames()[1].click("#blank");
  await page.waitForTimeout(800);
  const navigated = await page.evaluate(() => window.__navigated);
  const pages = context.pages().length;
  await context.close();

  assert.ok(navigated, 'a target="_blank" link was not reported to the reader');
  assert.match(navigated.href, /\/elsewhere$/);
  assert.equal(pages, 1, 'a target="_blank" link opened a real tab');
  assert.deepEqual(siteHits, [], "clicking a saved link reached the network");
  assert.deepEqual(attempted, [], "clicking a saved link reached the network");
});

await browser.close();
await site.close();
await reader.close();

if (failures.length) {
  console.error(`\n${failures.length} offline-network check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log("Offline network measurement passed");
}

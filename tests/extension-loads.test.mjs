/**
 * The built extension, loaded into a real Chrome, saving a real page.
 *
 * Everything else in this directory tests a function. This tests the thing the
 * user installs: `dist/` is loaded as an unpacked extension, the service worker
 * has to register, the popup has to render, and then a page is actually saved and
 * actually read back with the network watched.
 *
 * It exists because of a bug nothing else could catch. `viewer.js` builds the
 * reader's link bridge as a template literal, and a comment inside it contained a
 * backtick — which ends the string. The file stopped parsing, so the reader showed
 * "Unexpected identifier" instead of a saved page. Every unit test passed: the
 * tests that exercise the bridge rebuild it rather than importing it, and nothing
 * else imported `viewer.js` at all, because it needs the extension APIs to load.
 * The only way to see it was to open the reader in a browser.
 *
 * That is the general shape worth remembering here — **a file that cannot be
 * imported by the test suite is a file whose syntax nothing checks.** `viewer.js`,
 * `popup.js` and `content.js` are all in that position.
 *
 * `channel: "chromium"` is required. Extensions do not load in the headless shell
 * that Playwright uses by default, and the service worker never registers.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dist = join(repoRoot, "dist");
const fixture = await readFile(join(repoRoot, "tests/fixtures/torture-page.html"), "utf8");

/* This test reads `dist/`, so `dist/` has to exist and has to be current — which
   is why `npm run verify` builds before it tests rather than after. Run against a
   stale build it would quietly pass on yesterday's code, which is the one failure
   mode a test like this must not have. */
await readFile(join(dist, "manifest.json")).catch(() => {
  throw new Error("dist/ has not been built. Run `npm run build` first, or use `npm run verify`.");
});

// A 1x1 transparent GIF, served for every asset the fixture asks for.
const PIXEL = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const failures = [];
async function check(name, run) {
  try {
    await run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * A site to save
 * ------------------------------------------------------------------ */

const siteHits = [];
const server = createServer((request, response) => {
  siteHits.push(request.url);
  if (request.url.startsWith("/torture")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixture);
    return;
  }
  if (request.url.startsWith("/another-page")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Another page</title><h1>Another page</h1><img src='/assets/a.png' alt=''>");
    return;
  }
  if (request.url.endsWith(".css")) {
    response.writeHead(200, { "content-type": "text/css" });
    response.end("body { color: #222; }");
    return;
  }
  if (request.url.endsWith(".js")) {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end("window.__savedScriptRan = true;");
    return;
  }
  response.writeHead(200, { "content-type": "image/gif" });
  response.end(Buffer.from(PIXEL, "base64"));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------------ *
 * Load it
 * ------------------------------------------------------------------ */

const profile = await mkdtemp(join(tmpdir(), "pagepack-test-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

let extensionId = null;
await check("dist/ loads as an unpacked extension and its service worker registers", async () => {
  const worker = context.serviceWorkers()[0]
    || await context.waitForEvent("serviceworker", { timeout: 30000 });
  extensionId = worker.url().split("/")[2];
  assert.match(worker.url(), /background\.js$/);
  // If the worker threw while evaluating its imports it would not answer.
  assert.equal(await worker.evaluate(() => typeof chrome.runtime.id), "string");
});

assert.ok(extensionId, "the extension never loaded; nothing below can run");

await check("the popup renders with no page errors", async () => {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const text = await page.evaluate(() => document.body.innerText);
  assert.deepEqual(errors, [], `the popup logged errors:\n${errors.join("\n")}`);
  assert.match(text, /Save page/, "the popup did not render its primary action");
  assert.match(text, /Library/);
  await page.close();
});

await check("the reader's modules parse and it reports its own empty state", async () => {
  // Opened with no pack. The reader should say so in its own words. Anything
  // about an unexpected token means `viewer.js` failed to parse.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText);
  assert.equal(
    /Unexpected|SyntaxError|is not defined/i.test(text), false,
    `the reader failed to load its own script: ${text.replace(/\s+/g, " ").slice(0, 200)}`,
  );
  assert.match(text, /does not name a saved page/i);
  await page.close();
});

/* ------------------------------------------------------------------ *
 * Save a page, then read it with the network watched
 * ------------------------------------------------------------------ */

await check("a page saved through the extension reads back with no network request", async () => {
  const tab = await context.newPage();
  await tab.goto(`${origin}/torture`, { waitUntil: "load" });

  // An extension page is the only place `chrome.runtime.sendMessage` reaches the
  // worker, so the save is started the same way the popup starts it.
  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/viewer.html`);
  const started = await driver.evaluate(async ([siteOrigin]) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((candidate) => candidate.url && candidate.url.startsWith(siteOrigin));
    if (!target) return { error: "the page to save was not found in any tab" };
    return chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      tabId: target.id,
      pageUrl: target.url,
      pageTitle: target.title,
      // Depth 1 so a followed link goes through `extractAndTokenizeResources`,
      // which is the path that used to keep live references.
      depth: 1,
    });
  }, [origin]);
  assert.ok(started?.accepted, `the save was refused: ${JSON.stringify(started)}`);

  let pack = null;
  for (let attempt = 0; attempt < 90 && !pack; attempt += 1) {
    await driver.waitForTimeout(1000);
    const library = await driver.evaluate(() => chrome.runtime.sendMessage({ type: "LIST_LIBRARY" }));
    pack = (library?.packs || [])[0] || null;
  }
  assert.ok(pack, "the save never produced a pack");
  assert.ok(pack.stats.pages >= 2, `expected the followed link to be saved too, got ${pack.stats.pages} page(s)`);

  // Everything from here is the read. Nothing may leave the extension.
  siteHits.length = 0;
  const attempted = [];
  const reader = await context.newPage();
  await reader.route("**/*", (route) => {
    const url = route.request().url();
    if (!/^(chrome-extension|data|blob|about):/.test(url)) attempted.push(url);
    route.continue().catch(() => {});
  });
  const readerErrors = [];
  reader.on("pageerror", (error) => readerErrors.push(error.message));
  await reader.goto(`chrome-extension://${extensionId}/viewer.html?pack=${pack.id}`, { waitUntil: "domcontentloaded" });
  await reader.waitForTimeout(6000);

  const barText = await reader.evaluate(() => document.body.innerText);
  const frame = reader.frames()[1];
  const savedText = frame ? await frame.evaluate(() => document.body?.innerText || "").catch(() => "") : "";

  assert.deepEqual(readerErrors, [], `the reader threw:\n${readerErrors.join("\n")}`);
  // The zero below only means something if the page actually rendered.
  assert.match(savedText, /Torture page/, `the saved page did not render: ${barText.replace(/\s+/g, " ").slice(0, 200)}`);
  assert.deepEqual(siteHits, [], `the reader contacted the site it was saved from:\n${siteHits.join("\n")}`);
  assert.deepEqual(attempted, [], `the reader made a request outside the extension:\n${attempted.join("\n")}`);

  // And deleting it actually removes it, index rows included. `findSavedUrl` is
  // called through the real storage module rather than a message, because there
  // is no message for it — an earlier version of this assertion went through a
  // message type that does not exist, so it passed without checking anything.
  // `tests/pack-deletion.test.mjs` covers the leak this guards in detail.
  await driver.evaluate((id) => chrome.runtime.sendMessage({ type: "DELETE_PACK", id }), pack.id);
  const after = await driver.evaluate(() => chrome.runtime.sendMessage({ type: "LIST_LIBRARY" }));
  assert.equal((after?.packs || []).length, 0, "the deleted pack is still in the library");
  const stillFound = await driver.evaluate(async (url) => {
    const storage = await import(chrome.runtime.getURL("storage.js"));
    return storage.findSavedUrl(url);
  }, `${origin}/torture`);
  assert.equal(stillFound, null, "a deleted pack is still reachable through the saved-URL index");
});

await context.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
server.close();

if (failures.length) {
  console.error(`\n${failures.length} extension check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log("Extension load and end-to-end save tests passed");
}

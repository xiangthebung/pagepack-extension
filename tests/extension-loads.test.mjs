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
/* Every response is delayed by this much while the badge is being watched.
   Against an instant local server a whole two-page save finishes inside a single
   sampling interval, so the badge would be observed only as "" and a real,
   working count would look like an absent one. A slow site is also the case the
   badge exists for. */
let responseDelayMs = 0;
const server = createServer(async (request, response) => {
  siteHits.push(request.url);
  if (responseDelayMs) await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
  if (request.url.startsWith("/torture")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixture);
    return;
  }
  if (request.url.startsWith("/another-page")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // Links onward, so a depth-2 save has three pages. The badge only *rests* at
    // N while page N+1 is being fetched, so a two-page save shows "2" for barely
    // an instant and a third page is what makes the count observable at all.
    response.end("<!doctype html><title>Another page</title><h1>Another page</h1>"
      + "<img src='/assets/a.png' alt=''><a href='/third-page'>onward</a>");
    return;
  }
  if (request.url.startsWith("/third-page")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Third page</title><h1>Third page</h1>"
      + "<img src='/assets/b.png' alt=''><img src='/assets/c.png' alt=''><img src='/assets/d.png' alt=''>");
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
let serviceWorker = null;
await check("dist/ loads as an unpacked extension and its service worker registers", async () => {
  const worker = context.serviceWorkers()[0]
    || await context.waitForEvent("serviceworker", { timeout: 30000 });
  serviceWorker = worker;
  extensionId = worker.url().split("/")[2];
  assert.match(worker.url(), /background\.js$/);
  // If the worker threw while evaluating its imports it would not answer.
  assert.equal(await worker.evaluate(() => typeof chrome.runtime.id), "string");
});

assert.ok(extensionId, "the extension never loaded; nothing below can run");

await check("the popup renders with no page errors", async () => {
  const page = await context.newPage();
  // At the popup's own size. Anything wider is this document opened as a tab,
  // which lays out as the library page and is the next check.
  await page.setViewportSize({ width: 400, height: 600 });
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

/* The reader's Library button opens this same document in a tab. It used to
   arrive as a 400px panel pinned to the corner of an empty page — `html` kept
   the popup's fixed width — so the width is asserted, not just the content. */
await check("opened in a tab, the popup lays out as a full-width library page", async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1180, height: 820 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  await page.goto(`chrome-extension://${extensionId}/popup.html#library`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const layout = await page.evaluate(() => ({
    width: document.documentElement.getBoundingClientRect().width,
    saveHidden: document.getElementById("save-view").hidden,
    tabs: getComputedStyle(document.querySelector(".tabs")).display,
    sortShown: document.getElementById("library-sort").getBoundingClientRect().width > 0,
    filterShown: document.getElementById("library-filter").getBoundingClientRect().width > 0,
    saveTabsHidden: document.getElementById("library-save-tabs-button").hidden,
    text: document.body.innerText,
  }));
  assert.deepEqual(errors, [], `the library page logged errors:\n${errors.join("\n")}`);
  assert.ok(layout.width > 1000, `the library page is only ${layout.width}px wide`);
  assert.equal(layout.saveHidden, true, "a tab has no page to save, so the Save view must not show");
  assert.equal(layout.tabs, "none", "the Save/Library tab strip must not show on the page");
  assert.ok(layout.sortShown && layout.filterShown, "the sort and filter controls are not showing");
  assert.equal(layout.saveTabsHidden, false, "the page should offer to save all open tabs");
  assert.match(layout.text, /Library/);
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

/** The toolbar badge as the user would see it: text and background colour. */
const readBadge = () => serviceWorker.evaluate(async () => ({
  text: await chrome.action.getBadgeText({}),
  color: await chrome.action.getBadgeBackgroundColor({}),
}));
const badgeSamples = [];

await check("a page saved through the extension reads back with no network request", async () => {
  const tab = await context.newPage();
  await tab.goto(`${origin}/torture`, { waitUntil: "load" });
  // From here the site answers slowly, so the badge has states to observe.
  responseDelayMs = 120;

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
      // Depth 2 so followed links go through `extractAndTokenizeResources`, the
      // path that used to keep live references, and so the badge has a middle
      // state to be observed in.
      depth: 2,
    });
  }, [origin]);
  assert.ok(started?.accepted, `the save was refused: ${JSON.stringify(started)}`);

  /* Sampled while the save runs, so the badge is seen in the state a user with
     the popup closed would see it in.

     The loop waits for the pack *and* for the badge to clear. The pack lands in
     storage before `runCapture` finishes its teardown, so stopping at the pack
     alone opened the reader mid-teardown — which was a real, reproducible flake
     that made the saved page render empty. */
  let pack = null;
  let settled = false;
  for (let attempt = 0; attempt < 1500 && !settled; attempt += 1) {
    await driver.waitForTimeout(60);
    const badge = await readBadge();
    badgeSamples.push(badge);
    if (!pack || attempt % 5 === 0) {
      const library = await driver.evaluate(() => chrome.runtime.sendMessage({ type: "LIST_LIBRARY" }));
      pack = (library?.packs || [])[0] || pack;
    }
    settled = Boolean(pack) && badge.text === "";
  }
  assert.ok(pack, "the save never produced a pack");
  assert.ok(pack.stats.pages >= 3, `expected the followed links to be saved too, got ${pack.stats.pages} page(s)`);

  responseDelayMs = 0;

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
  await reader.close();
  await driver.close();
  await tab.close();
});

/* ------------------------------------------------------------------ *
 * The toolbar badge
 * ------------------------------------------------------------------ */

// #0a84ff, the save colour. Journey mode uses #b85c5c so the two modes stay
// tellable apart by colour, which is the only thing legible at badge size.
const SAVE_BLUE = [10, 132, 255, 255];

await check("a link-following save counts pages on the badge, in the save colour", async () => {
  const texts = badgeSamples.map((sample) => sample.text);
  const counted = badgeSamples.filter((sample) => /^\d+$/.test(sample.text));
  assert.ok(
    counted.length > 0,
    `the badge never showed a page count during a depth-1 save. Saw: ${JSON.stringify([...new Set(texts)])}`,
  );
  // Only ever pages already saved, so it climbs and never reports work remaining.
  const numbers = counted.map((sample) => Number(sample.text));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), `the count went backwards: ${numbers.join(",")}`);
  assert.ok(Math.max(...numbers) >= 2, `the count never got past 1, so it is not really counting: saw ${numbers.join(",")}`);
  assert.deepEqual(counted[0].color, SAVE_BLUE, "the counting badge is not the save colour");
  // A dot first, before any page has landed.
  assert.ok(texts.includes("•"), "the badge never showed the working dot before the first page landed");
  // And it clears when the save is done.
  assert.equal((await readBadge()).text, "", "the badge was left showing something after the save finished");
});

/* This checks that a single-page save shows the dot and finishes cleanly. It does
   NOT check that such a save never shows a count: `pages` reaches 1 only after
   the last asset lands and the badge clears a few milliseconds later, so a build
   that wrongly counted here looked identical to one that did not — measured, by
   mutating the rule and watching this pass anyway. That rule is decided in
   `captureBadgeText` and checked in `tests/badge.test.mjs`. */
await check("a single-page save shows the working dot and clears", async () => {
  responseDelayMs = 120;
  const tab = await context.newPage();
  await tab.goto(`${origin}/another-page`, { waitUntil: "load" });
  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/viewer.html`);
  await driver.evaluate(async ([siteOrigin]) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((candidate) => candidate.url && candidate.url.includes("/another-page"));
    return chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      tabId: target.id,
      pageUrl: target.url,
      pageTitle: target.title,
      depth: 0,
    });
  }, [origin]);

  const seen = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await driver.waitForTimeout(50);
    const badge = await readBadge();
    seen.push(badge.text);
    if (badge.text === "" && seen.some((text) => text === "•")) break;
  }
  assert.ok(seen.includes("•"), `a single-page save should show the working dot. Saw: ${JSON.stringify([...new Set(seen)])}`);
  assert.equal(seen[seen.length - 1], "", "the badge was left set after a single-page save finished");
  // Nothing may be left for the checks below, which count tabs and packs.
  const library = await driver.evaluate(() => chrome.runtime.sendMessage({ type: "LIST_LIBRARY" }));
  for (const pack of library?.packs || []) {
    await driver.evaluate((id) => chrome.runtime.sendMessage({ type: "DELETE_PACK", id }), pack.id);
  }
  await driver.close();
  await tab.close();
});

/* ------------------------------------------------------------------ *
 * The shortcut, the context menu, the pre-flight, duplicates, batches
 * ------------------------------------------------------------------ */

responseDelayMs = 0;
const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
const control = await context.newPage();
await control.goto(`chrome-extension://${extensionId}/viewer.html`);
const ask = (message) => control.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
const libraryNow = async () => (await ask({ type: "LIST_LIBRARY" })) || {};
/** Polls until no save is running, then returns the library. */
async function settledLibrary(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let library = await libraryNow();
  while (Date.now() < deadline) {
    const active = (library.captures || []).some((capture) => ["queued", "reading", "saving", "finishing"].includes(capture.state));
    if (!active && (await readBadge()).text === "") return library;
    await control.waitForTimeout(80);
    library = await libraryNow();
  }
  throw new Error("a save never finished");
}

await check("the shortcut and the context-menu permission are declared, and Chrome registered the command", async () => {
  assert.equal(manifest.commands?.["save-page"]?.suggested_key?.default, "Ctrl+Shift+S");
  assert.ok(manifest.permissions.includes("contextMenus"), "the manifest does not ask for contextMenus");
  const commands = await serviceWorker.evaluate(() => chrome.commands.getAll());
  assert.ok(commands.some((command) => command.name === "save-page"), `Chrome did not register save-page: ${JSON.stringify(commands)}`);
});

let preflightPack = null;
await check("a linked save is pre-flighted: the same-site pages are counted first, and only the ticked ones are saved", async () => {
  const tab = await context.newPage();
  await tab.goto(`${origin}/torture`, { waitUntil: "load" });
  const target = (await control.evaluate(() => chrome.tabs.query({}))).find((candidate) => candidate.url?.endsWith("/torture"));
  const discovery = await ask({ type: "DISCOVER_LINKS", tabId: target.id, pageUrl: target.url, pageTitle: target.title, depth: 2, runScripts: true, maxPages: 250 });
  assert.ok(discovery?.discoveryId, `discovery was refused: ${JSON.stringify(discovery)}`);
  // The fixture links to /another-page on its own site and to a CDN that is not;
  // /another-page links onward to /third-page, which depth 2 reaches.
  assert.deepEqual(
    discovery.pages.map((page) => [page.url.replace(origin, ""), page.level]),
    [["/another-page", 1], ["/third-page", 2]],
    `the wrong pages were found: ${JSON.stringify(discovery.pages)}`,
  );
  assert.equal(discovery.pages[0].title, "Another page", "a discovered page should carry its real title");
  assert.ok(discovery.estimatedBytes > 0, "no size estimate was produced");
  // Only the first level is kept; the save must respect that.
  const started = await ask({
    type: "START_CAPTURE", tabId: target.id, pageUrl: target.url, pageTitle: target.title, depth: 2,
    discoveryId: discovery.discoveryId, selectedUrls: [`${origin}/another-page`],
  });
  assert.ok(started?.accepted, `the pre-flighted save was refused: ${JSON.stringify(started)}`);
  const progress = await libraryNow();
  const record = (progress.captures || []).find((capture) => capture.id === started.requestId);
  assert.equal(record?.pagesTotal, 2, "the capture record should know its page count up front");
  const library = await settledLibrary();
  preflightPack = (library.packs || []).find((pack) => pack.rootUrl === `${origin}/torture`);
  assert.ok(preflightPack, "the pre-flighted save produced no pack");
  assert.deepEqual(preflightPack.pages.map((page) => page.url.replace(origin, "")), ["/torture", "/another-page"], "the unticked page was saved anyway");
  await tab.close();
});

await check("the same address reports as already saved, and Update re-captures it in place", async () => {
  const found = await ask({ type: "FIND_SAVED_URL", url: `${origin}/torture#fragment` });
  assert.equal(found?.match?.packId, preflightPack.id, "the saved copy was not found by its address");
  assert.ok(found.match.savedAt > 0);
  const { folder } = await ask({ type: "CREATE_FOLDER", name: "Kept" });
  await ask({ type: "MOVE_PACK", id: preflightPack.id, folderId: folder.id });
  const libraryBefore = await libraryNow();
  const before = libraryBefore.packs.find((pack) => pack.id === preflightPack.id);
  const update = await ask({ type: "UPDATE_PACK", id: preflightPack.id });
  assert.ok(update?.accepted, `the update was refused: ${JSON.stringify(update)}`);
  const library = await settledLibrary();
  const after = library.packs.find((pack) => pack.id === preflightPack.id);
  assert.ok(after, "the updated pack vanished");
  assert.equal(after.folderId, folder.id, "the update moved the pack out of its folder");
  assert.equal(after.sortOrder, before.sortOrder, "the update changed the pack's position");
  assert.equal(after.savedAt, before.savedAt, "the update should keep the original save date");
  assert.ok(after.updatedAt > before.savedAt, "the update did not record when it happened");
  assert.deepEqual(after.pages.map((page) => page.url), before.pages.map((page) => page.url), "the update changed which pages the save holds");
  assert.equal(library.packs.filter((pack) => pack.rootUrl === `${origin}/torture`).length, 1, "the update created a second pack instead of replacing the first");
  assert.equal(library.packs.length, libraryBefore.packs.length, "the update changed how many saves there are");
});

await check("save all tabs writes one pack per tab, and a link can be saved without opening it", async () => {
  const first = await context.newPage();
  await first.goto(`${origin}/another-page`, { waitUntil: "load" });
  const second = await context.newPage();
  await second.goto(`${origin}/third-page`, { waitUntil: "load" });
  /* The picture of the tab comes from `chrome.tabs.captureVisibleTab`, which
     needs `activeTab` — granted only by a gesture on the extension, which this
     harness cannot make. A real screenshot of the tab stands in for the API's
     answer; everything after it — the active-tab rule, the scaling in the
     worker, the store — is the extension's own. */
  const picture = (await second.screenshot({ type: "jpeg", quality: 70 })).toString("base64");
  await serviceWorker.evaluate((data) => { chrome.tabs.captureVisibleTab = async () => `data:image/jpeg;base64,${data}`; }, picture);
  const tabs = (await control.evaluate(() => chrome.tabs.query({})))
    .filter((candidate) => /\/(another|third)-page$/.test(candidate.url || ""))
    .map((candidate) => ({ tabId: candidate.id, url: candidate.url, title: candidate.title }));
  assert.equal(tabs.length, 2, `expected the two tabs just opened, found ${JSON.stringify(tabs.map((tab) => tab.url))}`);
  const packsBefore = (await libraryNow()).packs.length;
  const batch = await ask({ type: "START_BATCH", tabs, runScripts: true });
  assert.ok(batch?.accepted, `the batch was refused: ${JSON.stringify(batch)}`);
  let library = await settledLibrary();
  const roots = library.packs.map((pack) => pack.rootUrl.replace(origin, "")).sort();
  assert.deepEqual(roots, ["/another-page", "/third-page", "/torture"], "each tab should have become its own save");
  const batched = library.packs.filter((pack) => pack.rootUrl !== `${origin}/torture`);
  assert.ok(batched.every((pack) => pack.stats.pages === 1 && pack.pages.length === 1));
  const { thumbnails } = await ask({ type: "GET_THUMBNAILS", ids: batched.map((pack) => pack.id) });
  const thirdPack = batched.find((pack) => pack.rootUrl === `${origin}/third-page`);
  assert.deepEqual(Object.keys(thumbnails || {}), [thirdPack.id], "only the tab in front should get a picture, and it should get one");
  const size = await control.evaluate((src) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
    image.onerror = () => resolve("did not decode");
    image.src = src;
  }), thumbnails[thirdPack.id]);
  assert.deepEqual(size, [320, 200], `the picture should be scaled for a library row, got ${JSON.stringify(size)}`);
  await first.close();
  await second.close();

  const link = await ask({ type: "SAVE_LINK", url: `${origin}/third-page?from=menu` });
  assert.ok(link?.accepted, `saving a link was refused: ${JSON.stringify(link)}`);
  library = await settledLibrary();
  const fromLink = library.packs.find((pack) => pack.rootUrl === `${origin}/third-page?from=menu`);
  assert.ok(fromLink, "the link was not saved");
  assert.equal(fromLink.title, "Third page", "a link saved without a tab should still be titled from its page");
  assert.equal(library.packs.length, packsBefore + 3, "two tabs and one link should be three more saves");
});

await check("the library index carries the site icon and the reading state answers unread", async () => {
  const library = await libraryNow();
  const withIcon = library.packs.filter((pack) => typeof pack.favicon === "string" && pack.favicon.startsWith("data:image/"));
  // The fixture site answers /favicon.ico with a GIF, like everything else it does not recognise.
  assert.ok(withIcon.length >= 1, "no saved page carried its site icon into the library index");
  assert.deepEqual(library.reading, {}, "nothing has been read yet");
  await ask({ type: "PUT_READING_STATE", packId: preflightPack.id, patch: { pageIndex: 1, scrollTop: 300 } });
  const after = await libraryNow();
  assert.equal(after.reading[preflightPack.id]?.pageIndex, 1);
  assert.equal(after.reading[preflightPack.id]?.scroll?.[1], 300);
});

await check("the reader names its tab after the page and carries the captured site icon", async () => {
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/viewer.html?pack=${preflightPack.id}&page=0`, { waitUntil: "domcontentloaded" });
  await reader.waitForSelector("#reader-main:not([hidden])", { timeout: 20000 });
  assert.equal(await reader.title(), preflightPack.pages[0].title, "the tab is not named after the page");
  const favicon = await reader.evaluate(() => document.getElementById("reader-favicon")?.getAttribute("href") || "");
  assert.match(favicon, /^data:image\//, `the tab icon should be the site's captured icon, got ${favicon.slice(0, 40)}`);
  // The page list beside the reader, and the page it resumes on.
  const sidebar = await reader.evaluate(() => ({
    hidden: document.getElementById("reader-sidebar").hidden,
    titles: [...document.querySelectorAll("#reader-sidebar-list .sidebar-page strong")].map((node) => node.textContent),
  }));
  assert.equal(sidebar.hidden, false, "a two-page save should list its pages beside the reader");
  assert.deepEqual(sidebar.titles, preflightPack.pages.map((page) => page.title));
  await reader.close();
});

await control.close();

await context.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
server.close();

if (failures.length) {
  console.error(`\n${failures.length} extension check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log("Extension load and end-to-end save tests passed");
}

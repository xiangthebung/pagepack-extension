/**
 * A 30 MB page opens in the reader.
 *
 * It used to save and then refuse to open: the reader inlined every resource
 * into the markup with one `split().join()` per token, handed the result to
 * `document.write`, and gave the whole thing 3.5 seconds. Ten megabytes took a
 * third of a second, twenty took over one, thirty never finished — and "Try
 * again" reloaded into the same refusal, on a product that advertises a gigabyte
 * per save.
 *
 * This puts a pack of that size straight into the extension's storage, opens the
 * real reader on it in the real sandbox, and holds it to a budget. The images are
 * real images — SVGs padded out with a comment — so the check that they decoded
 * means something. The same run covers what the reader now remembers: the tab
 * title, the page list beside the page, the arrow keys, and where you were.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dist = join(repoRoot, "dist");
await readFile(join(dist, "manifest.json")).catch(() => {
  throw new Error("dist/ has not been built. Run `npm run build` first, or use `npm run verify`.");
});

const IMAGE_COUNT = 60;
const IMAGE_BYTES = 512 * 1024;
const OPEN_BUDGET_MS = 15000;

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

const profile = await mkdtemp(join(tmpdir(), "pagepack-big-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 30000 });
const extensionId = worker.url().split("/")[2];

/* ------------------------------------------------------------------ *
 * A 30 MB pack, written the way a save writes it
 * ------------------------------------------------------------------ */

const driver = await context.newPage();
await driver.goto(`chrome-extension://${extensionId}/viewer.html`);
const packId = `pack_big_${Date.now()}`;
const written = await driver.evaluate(async ([id, imageCount, imageBytes]) => {
  const storage = await import(chrome.runtime.getURL("storage.js"));
  const padding = "x".repeat(imageBytes);
  const resourceMap = {};
  const resources = [];
  const figures = [];
  for (let index = 0; index < imageCount; index += 1) {
    const hue = (index * 37) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">`
      + `<rect width="800" height="500" fill="hsl(${hue} 60% 70%)"/><circle cx="400" cy="250" r="120" fill="#fff"/>`
      + `<!--${padding}--></svg>`;
    const token = `__PAGEPACK_RESOURCE_${index}__`;
    resourceMap[token] = `data:image/svg+xml;base64,${btoa(svg)}`;
    resources.push({ token, url: `https://big.example/img/${index}.svg`, kind: "image" });
    figures.push(`<figure><img src="${token}" width="800" height="500" alt=""><figcaption>Figure ${index + 1}</figcaption></figure>`);
  }
  const html = `<!doctype html><html><head><title>Sixty figures</title><style>body{font-family:system-ui;max-width:860px;margin:0 auto}img{display:block;max-width:100%;height:auto}</style></head>`
    + `<body><h1>Sixty figures</h1><p>An image-heavy page.</p><a href="/second">the second page</a>${figures.join("")}</body></html>`;
  const pack = {
    id,
    rootUrl: "https://big.example/first",
    title: "Sixty figures",
    savedAt: Date.now(),
    depth: 1,
    runScripts: false,
    scope: "site",
    sortOrder: 0,
    folderId: null,
    limits: { maxPages: 250, maxTotalBytes: 1024 ** 3 },
    pages: [
      { url: "https://big.example/first", title: "Sixty figures", html, resources, resourceMap },
      { url: "https://big.example/second", title: "The second page", html: "<!doctype html><html><head><title>The second page</title></head><body><h1>The second page</h1><p>Small.</p><a href=\"/first\">back</a></body></html>", resources: [], resourceMap: {} },
    ],
    failures: [],
    stats: { pages: 2, bytes: imageCount * imageBytes, resources: imageCount, failed: 0 },
  };
  const started = performance.now();
  await storage.putPack(pack);
  return { bytes: Object.values(resourceMap).reduce((sum, value) => sum + value.length, 0), writeMs: Math.round(performance.now() - started) };
}, [packId, IMAGE_COUNT, IMAGE_BYTES]);
console.log(`  pack of ${(written.bytes / 1048576).toFixed(1)} MB written in ${written.writeMs} ms`);
assert.ok(written.bytes > 30 * 1024 * 1024, `the pack should be over 30 MB, got ${written.bytes}`);

/* ------------------------------------------------------------------ *
 * Opening it
 * ------------------------------------------------------------------ */

const reader = await context.newPage();
const attempted = [];
await reader.route("**/*", (route) => {
  const url = route.request().url();
  if (!/^(chrome-extension|data|blob|about):/.test(url)) attempted.push(url);
  route.continue().catch(() => {});
});
const readerErrors = [];
reader.on("pageerror", (error) => readerErrors.push(error.message));

let openMs = 0;
await check(`a ${(written.bytes / 1048576).toFixed(0)} MB pack opens within ${OPEN_BUDGET_MS / 1000} s, every image decoded`, async () => {
  const started = Date.now();
  await reader.goto(`chrome-extension://${extensionId}/viewer.html?pack=${packId}&page=0`, { waitUntil: "domcontentloaded" });
  await reader.waitForSelector("#reader-main:not([hidden])", { timeout: OPEN_BUDGET_MS });
  openMs = Date.now() - started;
  console.log(`  opened in ${openMs} ms`);
  const frame = reader.frames().find((candidate) => /sandbox\.html/.test(candidate.url()));
  assert.ok(frame, "the reader has no sandbox frame");
  await frame.waitForFunction((count) => document.images.length === count, IMAGE_COUNT, { timeout: 5000 });
  await frame.evaluate(() => Promise.all([...document.images].map((image) => image.decode().catch(() => undefined))));
  const images = await frame.evaluate(() => ({
    total: document.images.length,
    decoded: [...document.images].filter((image) => image.complete && image.naturalWidth > 0).length,
    blob: [...document.images].filter((image) => image.currentSrc.startsWith("blob:")).length,
    tokens: document.documentElement.outerHTML.includes("__PAGEPACK_RESOURCE_"),
  }));
  assert.equal(images.total, IMAGE_COUNT);
  assert.equal(images.decoded, IMAGE_COUNT, `${IMAGE_COUNT - images.decoded} image(s) did not decode`);
  assert.equal(images.blob, IMAGE_COUNT, "the images are not being served from blob: URLs minted in the sandbox");
  assert.equal(images.tokens, false, "a resource token survived into the rendered page");
  assert.deepEqual(readerErrors, [], `the reader threw:\n${readerErrors.join("\n")}`);
  assert.deepEqual(attempted, [], `the reader made a request outside the extension:\n${attempted.join("\n")}`);
  const errorShown = await reader.evaluate(() => !document.getElementById("reader-error").hidden);
  assert.equal(errorShown, false, "the reader showed its error state");
});

await check("the tab is named after the page and the pack's pages are listed beside it", async () => {
  assert.equal(await reader.title(), "Sixty figures");
  const sidebar = await reader.evaluate(() => ({
    hidden: document.getElementById("reader-sidebar").hidden,
    heading: document.querySelector("#reader-sidebar .sidebar-head strong")?.textContent,
    count: document.getElementById("reader-sidebar-count")?.textContent,
    items: [...document.querySelectorAll("#reader-sidebar-list .sidebar-page")].map((node) => ({
      title: node.querySelector("strong")?.textContent,
      current: node.getAttribute("aria-current") === "page",
      read: node.classList.contains("is-read"),
    })),
    favicon: document.getElementById("reader-favicon")?.getAttribute("href"),
  }));
  assert.equal(sidebar.hidden, false, "the sidebar is not showing for a two-page pack");
  assert.equal(sidebar.heading, "In this save");
  assert.equal(sidebar.count, "2 pages");
  assert.deepEqual(sidebar.items.map((item) => item.title), ["Sixty figures", "The second page"]);
  assert.equal(sidebar.items[0].current, true);
  assert.equal(sidebar.items[0].read, true, "the open page is not marked as read");
  assert.equal(sidebar.items[1].read, false);
  assert.match(sidebar.favicon, /icon-32\.png$/, "with no site icon in the pack, the reader falls back to its own");
});

await check("the arrow keys move between pages, and the sidebar can be collapsed", async () => {
  const frame = reader.frames().find((candidate) => /sandbox\.html/.test(candidate.url()));
  await frame.evaluate(() => document.body.focus());
  await reader.keyboard.press("ArrowRight");
  await reader.waitForFunction(() => document.getElementById("reader-title").textContent === "The second page", null, { timeout: 10000 });
  assert.equal(await reader.title(), "The second page");
  assert.match(reader.url(), /page=1$/);
  await reader.keyboard.press("ArrowLeft");
  await reader.waitForFunction(() => document.getElementById("reader-title").textContent === "Sixty figures", null, { timeout: 15000 });
  await reader.click("#reader-sidebar-button");
  assert.equal(await reader.evaluate(() => document.getElementById("reader-sidebar").hidden), true);
  await reader.click("#reader-sidebar-button");
  assert.equal(await reader.evaluate(() => document.getElementById("reader-sidebar").hidden), false);
});

await check("the reader resumes where it was: same page, same scroll position", async () => {
  await reader.waitForSelector("#reader-main:not([hidden])", { timeout: OPEN_BUDGET_MS });
  const frame = reader.frames().find((candidate) => /sandbox\.html/.test(candidate.url()));
  await frame.evaluate(() => Promise.all([...document.images].map((image) => image.decode().catch(() => undefined))));
  await frame.evaluate(() => window.scrollTo(0, 2400));
  // The sandbox reports scroll after 400 ms; the reader writes it 800 ms later.
  await reader.waitForTimeout(1800);
  const state = await driver.evaluate(async (id) => {
    const storage = await import(chrome.runtime.getURL("storage.js"));
    return storage.getReadingState(id);
  }, packId);
  assert.ok(state, "no reading state was written");
  assert.equal(state.pageIndex, 0);
  assert.ok(Math.abs(Number(state.scroll[0]) - 2400) < 40, `the scroll position was recorded as ${state.scroll[0]}`);
  assert.deepEqual(Object.keys(state.opened).sort(), ["0", "1"], "both opened pages should be remembered as read");

  // Reopened by a bare link — no page named — it comes back to the same place.
  await reader.goto(`chrome-extension://${extensionId}/viewer.html?pack=${packId}`, { waitUntil: "domcontentloaded" });
  await reader.waitForSelector("#reader-main:not([hidden])", { timeout: OPEN_BUDGET_MS });
  const resumed = reader.frames().find((candidate) => /sandbox\.html/.test(candidate.url()));
  await resumed.evaluate(() => Promise.all([...document.images].map((image) => image.decode().catch(() => undefined))));
  await reader.waitForTimeout(1700);
  const scrollY = await resumed.evaluate(() => window.scrollY);
  assert.ok(Math.abs(scrollY - 2400) < 40, `expected to resume near 2400, got ${scrollY}`);
  assert.equal(await reader.title(), "Sixty figures");
});

await context.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});

if (failures.length) {
  console.error(`\n${failures.length} big-pack check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(`Big pack reader tests passed (opened in ${openMs} ms)`);
}

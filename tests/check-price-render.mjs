/**
 * One-off check: does the Pro card render the prices the provider reported?
 *
 * `tests/pricing.test.mjs` covers the formatting; this covers the twenty lines of
 * DOM wiring between it and the card, which no unit test can reach. Run the visual
 * server first (`npm run visual`).
 *
 * Playwright is borrowed from a sibling checkout rather than added as a dependency
 * here, so pass its location:
 *   node tests/check-price-render.mjs "../personal-website/node_modules/playwright"
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const where = process.argv[2] ?? "../personal-website/node_modules/playwright";
// Playwright's entry point is CommonJS, so a dynamic import hands back the module
// object under `default`.
const loaded = await import(pathToFileURL(path.resolve(where, "index.js")).href);
const { chromium } = loaded.default ?? loaded;

const BASE = `http://127.0.0.1:${process.env.PAGEPACK_TEST_PORT || 41731}/popup.html`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 700 } });

const problems = [];
page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console: ${message.text()}`);
});

async function readCard(url) {
  await page.goto(url, { waitUntil: "load" });
  await page.locator("#plan-chip").click();
  await page.locator("#pro-price-alt").waitFor({ state: "attached" });
  // The plan state arrives through the mocked sendMessage callback.
  await page.waitForTimeout(400);
  return {
    price: (await page.locator("#pro-price").innerText().catch(() => "")).trim(),
    priceHidden: await page.locator("#pro-price").isHidden(),
    alt: (await page.locator("#pro-price-alt").innerText().catch(() => "")).trim(),
  };
}

const free = await readCard(BASE);
console.log("free  →", JSON.stringify(free));
if (!/1\.99/.test(free.price)) problems.push(`monthly price missing: ${free.price}`);
if (!/9\.99/.test(free.alt)) problems.push(`yearly price missing: ${free.alt}`);
if (!/58% less/.test(free.alt)) problems.push(`computed saving missing: ${free.alt}`);
if (free.priceHidden) problems.push("the price line is hidden on the free plan");

const pro = await readCard(`${BASE}?plan=pro`);
console.log("pro   →", JSON.stringify(pro));
if (!pro.priceHidden) problems.push("the price line is still shown to a paying subscriber");
if (!/Unlimited saves are active/.test(pro.alt)) problems.push(`wrong paid line: ${pro.alt}`);

await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("\nPro card prices render from the provider's plans");

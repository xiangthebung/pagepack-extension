/**
 * Lines the developer's portfolio site copies out of this extension, and the
 * copy the allowance has to use.
 *
 * `personal-website/tests/rendered-html.test.mjs` diffs a handful of lines from
 * `popup.js` and `background.js` against copies it keeps, so its demo of this
 * extension prints the real vocabulary rather than plausible placeholder text.
 * Changing one of them breaks a test in another repository. This file fails
 * first, here, with the line named.
 *
 * The second half is about honesty: the free allowance counts pages, not saves,
 * and every place the popup and the worker describe it has to say so.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (name) => (await readFile(new URL(`../${name}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const popup = await read("popup.js");
const background = await read("background.js");
const flat = (text) => text.replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------------ *
 * Pinned by the portfolio
 * ------------------------------------------------------------------ */

const PINNED_POPUP = [
  'const DEPTH_LABELS = ["Single page", "One level of links", "Two levels of links", "Three levels of links"];',
  'if (!$("#run-scripts").checked) parts.push("no scripts");',
  "if (amount < 1024) return `${amount} B`;",
  "if (amount < 1024 * 1024) return `${Math.round(amount / 1024)} KB`;",
  "if (amount < 1024 * 1024 * 1024) return `${(amount / (1024 * 1024)).toFixed(1)} MB`;",
  "return `${(amount / (1024 * 1024 * 1024)).toFixed(2)} GB`;",
  '? "Cancelling…" : pagesTotal > 1 ? "Saving pages" : "Saving this page";',
  "const determinate = capture.determinate === true && Number(capture.assetsTotal) > 0 && !cancelling;",
];
for (const line of PINNED_POPUP) {
  assert.ok(flat(popup).includes(flat(line)), `popup.js no longer contains the portfolio-pinned line: ${line}`);
}
assert.doesNotMatch(popup, /parts\.push\("scripts on"\)/, "popup.js grew a `scripts on` suffix the portfolio does not know about");

const PINNED_BACKGROUND = `function captureProgressMessage({ phase, pagesDone, pagesTotal, assetsDone, assetsTotal }) {
  if (phase === "reading") return "Reading this page…";
  if (phase === "finishing") return "Finishing up…";
  const files = assetsTotal ? \`\${assetsDone} of \${assetsTotal} files\` : "collecting files";
  if (pagesTotal > 1) return \`Page \${Math.min(pagesDone + 1, pagesTotal)} of \${pagesTotal} · \${files}\`;
  return \`Saving \${files}\`;
}`;
assert.ok(background.includes(PINNED_BACKGROUND), "background.js's captureProgressMessage body has changed; the portfolio copies it verbatim");

/* ------------------------------------------------------------------ *
 * The allowance is counted in pages
 * ------------------------------------------------------------------ */

assert.ok(popup.includes('`${plural(savesLeft(), "page")} left this month`'), "the plan line must count pages left, not saves");
assert.ok(popup.includes('"No free pages left"'), "the exhausted save button must say pages");
assert.match(popup, /free pages this month/, "the exhausted status must say pages");
assert.doesNotMatch(popup, /saves? left|free saves/i, "popup.js still describes the allowance in saves");
assert.doesNotMatch(background, /free saves/i, "background.js still describes the allowance in saves");
assert.match(background, /free pages this month\. Upgrade to Pro to keep saving\./, "the worker's refusal must count pages");

// The pending save's cost is shown before the button is pressed.
assert.match(popup, /Uses 1 of \$\{plural\(remaining, "free page"\)\} left this month/, "the hint under Save must state what one page costs");
assert.match(popup, /function allowanceNote\(count\)/, "the pre-flight sheet must say what a multi-page save costs");

console.log("Portfolio pin and allowance copy tests passed");

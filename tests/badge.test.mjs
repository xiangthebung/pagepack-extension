/**
 * What the toolbar badge says during a save.
 *
 * The badge is the only signal left once the popup closes, and its rules are
 * mostly about what *not* to show. Two of them cannot be checked in a browser:
 *
 *  - A single-page save shows the working dot rather than "1". For such a save
 *    `pages` only reaches 1 after the final asset lands, and the badge clears a
 *    few milliseconds later, so the counting and non-counting versions look
 *    identical to any sampler. An end-to-end assertion about it passed against a
 *    deliberately broken build — vacuous, and therefore worse than nothing.
 *  - The 99+ cap needs a hundred pages to observe.
 *
 * `tests/extension-loads.test.mjs` covers what a browser *can* show: that a
 * link-following save really does count up, in the save colour, and clears.
 */
import assert from "node:assert/strict";

const chromeStub = new Proxy(function () {}, {
  get: (target, property) => (property === "lastError" || property === "then" ? undefined : chromeStub),
  apply: () => undefined,
});
globalThis.chrome = chromeStub;

const { captureBadgeText, CAPTURE_WORKING_BADGE } = await import("../background.js");

/* ------------------------------------------------------------------ *
 * A single-page save never shows a count
 * ------------------------------------------------------------------ */

// "1" would tell nobody anything, and it would appear for one frame at the end of
// the save. The dot means "working", which is the whole of what there is to say.
assert.equal(captureBadgeText({ following: false, pages: 0 }), CAPTURE_WORKING_BADGE);
assert.equal(captureBadgeText({ following: false, pages: 1 }), CAPTURE_WORKING_BADGE);
assert.equal(captureBadgeText({ following: false, pages: 7 }), CAPTURE_WORKING_BADGE);

/* ------------------------------------------------------------------ *
 * A link-following save counts, once it has something to count
 * ------------------------------------------------------------------ */

// Before the first page lands there is no number worth showing, so the dot holds.
assert.equal(captureBadgeText({ following: true, pages: 0 }), CAPTURE_WORKING_BADGE);
assert.equal(captureBadgeText({ following: true, pages: 1 }), "1");
assert.equal(captureBadgeText({ following: true, pages: 7 }), "7");
assert.equal(captureBadgeText({ following: true, pages: 99 }), "99");

// Chrome truncates a badge past about four characters, so the cap is ours to set.
assert.equal(captureBadgeText({ following: true, pages: 100 }), "99+");
assert.equal(captureBadgeText({ following: true, pages: 250 }), "99+");
assert.equal(captureBadgeText({ following: true, pages: 1000 }), "99+");

/* ------------------------------------------------------------------ *
 * Nothing degenerate reaches the badge
 * ------------------------------------------------------------------ */

assert.equal(captureBadgeText({ following: true, pages: undefined }), CAPTURE_WORKING_BADGE);
assert.equal(captureBadgeText({ following: true, pages: null }), CAPTURE_WORKING_BADGE);
assert.equal(captureBadgeText({ following: true, pages: NaN }), CAPTURE_WORKING_BADGE);
assert.equal(captureBadgeText({ following: true, pages: -3 }), CAPTURE_WORKING_BADGE);
assert.equal(captureBadgeText({}), CAPTURE_WORKING_BADGE);

// The count only ever describes pages already saved, so every value it can take
// is a plain positive integer rendered as itself up to the cap.
for (let pages = 1; pages <= 99; pages += 1) {
  assert.equal(captureBadgeText({ following: true, pages }), String(pages));
}

console.log("Badge tests passed");

/**
 * Nothing addressable survives capture.
 *
 * PagePack's one claim is that opening a save makes no network request. This file
 * checks the half of that which can be checked without a browser: that the
 * fetched-page tokeniser leaves no reference behind. The other half — that a real
 * Chromium rendering a real pack makes no request — is measured in
 * `tests/offline-network.test.mjs`.
 *
 * The check is an *audit*, not a list of expected strings. `auditOfflineMarkup`
 * in `url-surface.js` enumerates the constructs that load or navigate and reports
 * any that still point somewhere; it deliberately does not share its expressions
 * with the rewriters, because a scanner built from the same regex as the thing it
 * checks agrees with it by construction and proves nothing.
 *
 * Adding a construct to `url-surface.js` without teaching `classifyResource` about
 * it fails this test. That is the intended way to extend both.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  auditCss,
  auditOfflineMarkup,
  isInertReference,
  NETWORK_ELEMENTS,
  stripNetworkElements,
  URL_ATTRIBUTES,
} from "../url-surface.js";

// The service worker registers listeners as it loads; the same stub the srcset
// tests use covers them.
const chromeStub = new Proxy(function () {}, {
  get: (target, property) => (property === "lastError" || property === "then" ? undefined : chromeStub),
  apply: () => undefined,
});
globalThis.chrome = chromeStub;

const { extractAndTokenizeResources } = await import("../background.js");

const PAGE_URL = "https://site.pagepack-test.invalid/articles/torture";
const fixture = await readFile(fileURLToPath(new URL("./fixtures/torture-page.html", import.meta.url)), "utf8");

function describe(findings) {
  return findings.map((finding) => `${finding.construct} on <${finding.element}> -> ${finding.value}`).join("\n  ");
}

/* ------------------------------------------------------------------ *
 * The auditor is not vacuous
 * ------------------------------------------------------------------ */

/* Checked first and deliberately. An auditor that silently matched nothing would
   make every assertion below pass while proving the opposite of what they claim,
   which is the failure mode this whole file exists to rule out. The raw fixture
   is the known-bad input; it has to light up. */
const rawFindings = auditOfflineMarkup(fixture, { allowLazyAttributes: false });
assert.ok(rawFindings.length > 25, `the untouched fixture should be full of findings, got ${rawFindings.length}`);

const rawConstructs = new Set(rawFindings.map((finding) => finding.construct));
// `attribute:data` is absent on purpose: `data` only ever appears on `<object>`,
// which the audit reports as a removed element before it looks at attributes.
for (const expected of [
  "element", "meta-refresh", "attribute:src", "attribute:href", "attribute:poster",
  "attribute:background", "attribute:xlink:href", "srcset-candidate",
  "css:url()", "css:@import", "css:image-set()", "attribute:data-src",
]) {
  assert.ok(rawConstructs.has(expected), `the fixture should exercise ${expected}; it does not`);
}

// Every element and attribute the module claims to know about is actually in the
// fixture, so the checklist cannot quietly stop covering one.
// `frame`, `frameset`, `portal` and `applet` are stripped but not exercised here:
// the first two are only legal in a frameset document, which this fixture is not,
// and the other two are obsolete or never shipped. `stripNetworkElements` is
// checked against them directly at the end of this file.
const NOT_IN_A_BODY = new Set(["frame", "frameset", "portal", "applet"]);
for (const element of Object.keys(NETWORK_ELEMENTS)) {
  if (NOT_IN_A_BODY.has(element)) continue;
  assert.ok(new RegExp(`<${element}\\b`, "i").test(fixture), `fixture is missing <${element}>`);
}
for (const [attribute, elements] of Object.entries(URL_ATTRIBUTES)) {
  const present = elements.some((element) => new RegExp(`<${element}\\b[^>]*\\b${attribute.replace(":", "\\:")}\\s*=`, "i").test(fixture));
  assert.ok(present, `fixture never uses the ${attribute} attribute`);
}

/* ------------------------------------------------------------------ *
 * A captured page has nothing left to fetch
 * ------------------------------------------------------------------ */

/* Lazy attributes are allowed through here, and that is a considered position
   rather than an oversight. `data-src` and its cousins are conventions, not
   markup: nothing loads them, and a value that is not a URL at all is common. If
   capture rewrote them it would resolve `data-src="lazy"` against the page and
   fetch a URL that never existed, filling the missing-parts report with noise.
   Left alone they cost nothing, because the only thing that can act on one is a
   saved script assigning it to `src` — and the reader's `img-src 'self' data:
   blob:` refuses the result. `tests/offline-network.test.mjs` measures exactly
   that, with a real lazy loader running in a real browser, rather than assuming
   it here. */
for (const captureMedia of [true, false]) {
  for (const runScripts of [true, false]) {
    const captured = extractAndTokenizeResources(fixture, PAGE_URL, { runScripts, captureMedia });
    const findings = auditOfflineMarkup(captured.html, { allowLazyAttributes: true });
    assert.equal(
      findings.length, 0,
      `captured page still reaches the network (runScripts=${runScripts}, captureMedia=${captureMedia}):\n  ${describe(findings)}`,
    );
    // The blunt version of the same claim, and the one a reader can check by eye.
    assert.equal(
      /https?:\/\//i.test(captured.html.replace(/<a\b[^>]*>/gi, "").replace(/<form\b[^>]*>/gi, "")),
      false,
      "an absolute URL survived outside a link or a form",
    );
  }
}

/* ------------------------------------------------------------------ *
 * The elements that navigate are gone, not merely emptied
 * ------------------------------------------------------------------ */

const captured = extractAndTokenizeResources(fixture, PAGE_URL, { runScripts: true, captureMedia: true });

/* The one that matters most. Every other construct here loads a subresource, and
   the reader's sandbox refuses those by policy even when capture misses one. A
   meta refresh navigates instead of loading, and no CSP directive in any shipping
   browser stops a sandboxed frame navigating itself — `navigate-to` was dropped
   from the spec. If one survives, opening the save walks the reader onto the live
   site. `tests/offline-network.test.mjs` measures that in a real browser. */
assert.equal(/http-equiv\s*=\s*["']?refresh/i.test(captured.html), false, "a meta refresh survived capture");
assert.equal(/<base\b/i.test(captured.html), false, "a <base> survived capture and would re-point relative URLs at the live origin");
assert.equal(/<iframe\b/i.test(captured.html), false, "an iframe survived capture");
assert.equal(/<object\b/i.test(captured.html), false, "an object survived capture");
assert.equal(/<embed\b/i.test(captured.html), false, "an embed survived capture");
assert.equal(/<noscript\b/i.test(captured.html), false, "a noscript survived capture, and its pixel would load with scripts off");
// Removing the start tag alone would leave the fallback content and the pixel in it.
assert.equal(/embedded-frame/i.test(captured.html), false, "iframe content survived its element");

/* ------------------------------------------------------------------ *
 * What is deliberately kept
 * ------------------------------------------------------------------ */

// Links stay. The reader intercepts every click and either moves to the saved
// page or offers to open it online, and the "✓ Saved" badge needs the href to
// know which is which.
assert.match(captured.html, /<a href="\/another-page">/);
assert.match(captured.html, /cdn\.pagepack-test\.invalid\/elsewhere/);
// A same-document `<use href="#id">` works offline and must not be dropped along
// with the external ones.
assert.match(captured.html, /<use href="#local-icon"\/>/);
assert.equal(/sprite\.svg/i.test(captured.html), false, "an external <use> reference should be dropped, not saved");

/* ------------------------------------------------------------------ *
 * Resource kinds
 * ------------------------------------------------------------------ */

const saved = new Map(captured.resources.map((resource) => [resource.url.replace(/^https?:\/\/[^/]+/, ""), resource.kind]));
assert.equal(saved.get("/assets/site.css"), "style");
assert.equal(saved.get("/assets/captions.vtt"), "media", "captions are part of the video");
assert.equal(saved.get("/assets/submit-button.png"), "image", "<input type=image> loads a picture");
assert.equal(saved.get("/assets/svg-image.png"), "image");
assert.equal(saved.get("/assets/svg-image-legacy.png"), "image", "xlink:href is still honoured by every browser");
assert.equal(saved.get("/assets/body-background.png"), "image", "the obsolete background attribute still loads");
assert.equal(saved.get("/assets/one.png"), "asset", "image-set() carries URLs with no url() around them");
assert.equal(saved.get("/assets/inline-image-set.png"), "asset");
assert.equal(saved.get("/assets/app.js"), "script");
// A favicon, a preload and a manifest are `<link>`s that are not stylesheets. They
// are removed rather than saved: nothing in the reader can show them.
assert.equal(saved.has("/assets/favicon.ico"), false);
assert.equal(saved.has("/assets/preload.woff2"), false);
assert.equal(saved.has("/assets/app.webmanifest"), false);

/* ------------------------------------------------------------------ *
 * Media capture off means gone, not left pointing at the network
 * ------------------------------------------------------------------ */

const noMedia = extractAndTokenizeResources(fixture, PAGE_URL, { runScripts: true, captureMedia: false });
assert.equal(/clip\.mp4|clip\.webm|sound\.mp3|poster\.jpg/i.test(noMedia.html), false,
  "turning media capture off must delete the attribute, not leave a live address in the pack");

/* ------------------------------------------------------------------ *
 * The pieces the audit is built from
 * ------------------------------------------------------------------ */

assert.equal(isInertReference("__PAGEPACK_RESOURCE_12__"), true);
assert.equal(isInertReference("data:image/png;base64,AAAA"), true);
assert.equal(isInertReference("#anchor"), true);
assert.equal(isInertReference("   "), true);
assert.equal(isInertReference("/assets/thing.png"), false);
assert.equal(isInertReference("https://example.test/thing.png"), false);

// `image-set()` with no `url()` is the case a naive scan misses.
assert.equal(auditCss('a { background: image-set("/x.png" 1x); }').length, 1);
assert.equal(auditCss('a { background: image-set("__PAGEPACK_RESOURCE_0__" 1x); }').length, 0);
// A `url()` inside an `image-set()` is found by the ordinary `url()` rule.
assert.equal(auditCss('a { background: image-set(url("/x.png") 1x); }').length, 1);

// Content goes with the element, and an unclosed start tag still goes.
assert.equal(stripNetworkElements("<p>a</p><iframe src=x><p>fallback</p></iframe><p>b</p>"), "<p>a</p><p>b</p>");
assert.equal(stripNetworkElements('<base href="https://x.test/"><p>a</p>'), "<p>a</p>");
assert.equal(stripNetworkElements('<meta http-equiv="refresh" content="0;url=https://x.test/"><p>a</p>'), "<p>a</p>");
// A meta that is not a refresh stays.
assert.match(stripNetworkElements('<meta charset="utf-8">'), /<meta charset="utf-8">/);

console.log("Offline guarantee tests passed");

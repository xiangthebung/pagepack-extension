/**
 * A fetched stylesheet comes back with nothing left that would load.
 *
 * `fetchResource` in `background.js` inlines what an external stylesheet pulls
 * in: `@import`, `url()`, and — this was the gap — the bare-string form of
 * `image-set()`, which carries a URL with no `url()` around it. Inline styles
 * and `<style>` blocks had that form covered by `rewriteImageSet`; a stylesheet
 * fetched as a file did not, and a remote address survived into the pack.
 *
 * The network is a stub: every URL answers with a known body, and the result is
 * audited by `auditCss` from `url-surface.js`, which does not share expressions
 * with the rewriter.
 */
import assert from "node:assert/strict";

import { auditCss } from "../url-surface.js";

const chromeStub = new Proxy(function () {}, {
  get: (target, property) => (property === "lastError" || property === "then" ? undefined : chromeStub),
  apply: () => undefined,
});
globalThis.chrome = chromeStub;

const requests = [];
const bodies = new Map([
  ["https://site.test/css/site.css", { type: "text/css", body: [
    '@import "theme.css";',
    ".hero { background-image: image-set(\"/img/hero.png\" 1x, '/img/hero@2x.png' 2x); }",
    ".logo { background: -webkit-image-set(url(\"/img/logo.png\") 1x, \"/img/logo@2x.png\" 2x); }",
    ".keep { background: image-set(\"data:image/gif;base64,R0lGODlhAQABAAAAACw=\" 1x); }",
    ".missing { background: image-set(\"/img/missing.png\" 1x); }",
    ".plain { background: url(/img/plain.png); }",
  ].join("\n") }],
  ["https://site.test/css/theme.css", { type: "text/css", body: "body { color: #123; }" }],
  ["https://site.test/img/hero.png", { type: "image/png", body: "HERO" }],
  ["https://site.test/img/hero@2x.png", { type: "image/png", body: "HERO2" }],
  ["https://site.test/img/logo.png", { type: "image/png", body: "LOGO" }],
  ["https://site.test/img/logo@2x.png", { type: "image/png", body: "LOGO2" }],
  ["https://site.test/img/plain.png", { type: "image/png", body: "PLAIN" }],
]);

globalThis.fetch = async (url) => {
  requests.push(String(url));
  const entry = bodies.get(String(url));
  if (!entry) return { ok: false, status: 404, url: String(url), headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
  const bytes = new TextEncoder().encode(entry.body);
  return {
    ok: true,
    status: 200,
    url: String(url),
    headers: new Headers({ "content-type": entry.type, "content-length": String(bytes.byteLength) }),
    arrayBuffer: async () => bytes.buffer,
  };
};

const { fetchResource } = await import("../background.js");

const cache = new Map();
const result = await fetchResource({ url: "https://site.test/css/site.css", kind: "style" }, cache);
const css = Buffer.from(result.dataUrl.split(",")[1], "base64").toString("utf8");

// Nothing addressable is left, by the independent auditor's reckoning.
assert.deepEqual(auditCss(css), [], `the fetched stylesheet still reaches the network:\n${css}`);

// Every bare-string candidate became the bytes it named.
assert.match(css, /image-set\("data:image\/png;base64,SEVSTw==" 1x, 'data:image\/png;base64,SEVSTzI=' 2x\)/, "bare-string image-set() candidates were not inlined");
// The url() form inside an image-set is handled by the url() pass, and the
// bare-string sibling beside it by the image-set pass; both end up inline.
assert.match(css, /-webkit-image-set\(url\("data:image\/png;base64,TE9HTw=="\) 1x, "data:image\/png;base64,TE9HTzI=" 2x\)/);
// A data: candidate is left exactly as it was.
assert.match(css, /image-set\("data:image\/gif;base64,R0lGODlhAQABAAAAACw=" 1x\)/);
// A candidate that could not be fetched becomes an empty string, never an address.
assert.match(css, /\.missing \{ background: image-set\("" 1x\); \}/);
assert.doesNotMatch(css, /\/img\/missing\.png/);
// The import and the plain url() still work as before.
assert.match(css, /@import url\("data:text\/css;base64,/);
assert.match(css, /url\("data:image\/png;base64,UExBSU4="\)/);

// Each image was fetched once, resolved against the stylesheet's own address.
const images = requests.filter((url) => url.includes("/img/")).sort();
assert.deepEqual(images, [
  "https://site.test/img/hero.png",
  "https://site.test/img/hero@2x.png",
  "https://site.test/img/logo.png",
  "https://site.test/img/logo@2x.png",
  "https://site.test/img/missing.png",
  "https://site.test/img/plain.png",
]);

// The stylesheet's byte count includes what it inlined.
assert.ok(result.bytes > "HERO".length + "HERO2".length + "LOGO".length + "LOGO2".length + "PLAIN".length, "inlined image bytes were not counted");

console.log("External stylesheet image-set tests passed");

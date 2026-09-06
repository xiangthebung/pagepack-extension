/**
 * The sandbox's render detection and its two ways of installing a page.
 *
 * A plain snapshot is parsed by `DOMParser` and adopted in one move; a page with
 * its scripts on goes through `document.write`. Both are driven here against a
 * stub document just rich enough to tell whether the body ended up with text,
 * and — the part that matters for large saves — whether the resource tokens were
 * resolved against the Blobs sent separately rather than against the markup.
 * `tests/big-pack.test.mjs` does the same in a real Chromium with a 30 MB pack.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../sandbox.js", import.meta.url), "utf8");

/** A document just deep enough for `substituteTree` and `reportRendered`. */
function makeElement(tag, attributes = {}, text = "") {
  const element = {
    localName: tag,
    tagName: tag.toUpperCase(),
    textContent: text,
    attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
    removeAttribute(name) { element.attributes = element.attributes.filter((attribute) => attribute.name !== name); },
    getAttribute(name) { return element.attributes.find((attribute) => attribute.name === name)?.value ?? null; },
  };
  return element;
}

function makeContext({ visibleText = "", elements = [] } = {}) {
  const events = [];
  const listeners = {};
  const documentListeners = {};
  const body = { innerText: visibleText, querySelectorAll: () => ({ length: 0 }) };
  const documentElement = { tagName: "HTML" };
  const document = {
    body,
    documentElement,
    written: null,
    open() {},
    write(value) {
      document.written = String(value);
      body.innerText = document.written.includes("VISIBLE") ? "A visible saved article" : "";
    },
    close() {},
    adoptNode(node) { return node; },
    replaceChild(node) {
      document.documentElement = node;
      document.body = node.body;
    },
    addEventListener(type, listener) { documentListeners[type] = listener; },
    removeEventListener() {},
  };
  const parsedDocuments = [];
  class DOMParser {
    parseFromString(html) {
      const parsed = {
        html,
        elements,
        body: { innerText: html.includes("VISIBLE") ? "A visible saved article" : "", querySelectorAll: () => ({ length: 0 }) },
        querySelectorAll: () => elements,
      };
      parsed.documentElement = parsed;
      parsedDocuments.push(parsed);
      return parsed;
    }
  }
  const window = {
    parent: { postMessage(message) { events.push(message); } },
    addEventListener(type, listener) { listeners[type] = listener; },
    removeEventListener() {},
    scrollTo() {},
    scrollY: 0,
  };
  class StubURL extends URL {
    static createObjectURL(blob) { return `blob:null/${blob.name}`; }
    static revokeObjectURL() {}
  }
  vm.runInNewContext(source, { window, document, setTimeout, clearTimeout, DOMParser, URL: StubURL }, { filename: "sandbox.js" });
  return { events, listeners, documentListeners, document, parsedDocuments };
}

async function render(markup, { runScripts = false, resources = null, context = {} } = {}) {
  const harness = makeContext(context);
  harness.listeners.message({ data: { source: "pagepack-viewer", type: "load-start", runScripts, renderAttempt: 1, pageUrl: "https://example.test/a" } });
  harness.listeners.message({ data: { source: "pagepack-viewer", type: "load-chunk", renderAttempt: 1, chunk: markup } });
  if (resources) harness.listeners.message({ data: { source: "pagepack-viewer", type: "load-resources", renderAttempt: 1, resources } });
  harness.listeners.message({ data: { source: "pagepack-viewer", type: "load-end", renderAttempt: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 1700));
  return { ...harness, rendered: harness.events.filter((event) => event.type === "rendered") };
}

async function filteredErrorFixture(eventName, payload) {
  const harness = makeContext();
  let prevented = false;
  harness.listeners[eventName]({ ...payload, preventDefault() { prevented = true; } });
  return prevented;
}

/* ------------------------------------------------------------------ *
 * Content detection, on both paths
 * ------------------------------------------------------------------ */

const visible = await render("<html><body>VISIBLE</body></html>");
assert.equal(visible.rendered.at(-1).phase, "settled");
assert.equal(visible.rendered.at(-1).hasContent, true);
assert.equal(visible.document.written, null, "a plain snapshot must not go through document.write");
assert.equal(visible.parsedDocuments.length, 1, "a plain snapshot is parsed once by DOMParser");

const blank = await render("<html><body></body></html>");
assert.equal(blank.rendered.at(-1).phase, "settled");
assert.equal(blank.rendered.at(-1).hasContent, false);

const interactive = await render("<html><body>VISIBLE</body></html>", { runScripts: true });
assert.equal(interactive.rendered.at(-1).hasContent, true);
assert.ok(interactive.document.written?.includes("VISIBLE"), "a page with scripts on is written so its inline scripts land in place");
assert.equal(interactive.parsedDocuments.length, 0);

/* ------------------------------------------------------------------ *
 * Tokens are resolved after parsing, against Blobs
 * ------------------------------------------------------------------ */

const img = makeElement("img", { src: "__PAGEPACK_RESOURCE_0__", srcset: "__PAGEPACK_RESOURCE_0__ 1x, __PAGEPACK_RESOURCE_1__ 2x", alt: "x" });
const missing = makeElement("img", { src: "__PAGEPACK_RESOURCE_9__" });
const style = makeElement("style", {}, "body{background:url(__PAGEPACK_RESOURCE_1__)}");
const inline = makeElement("div", { style: "background:url(__PAGEPACK_RESOURCE_0__)" });
const tokenised = await render("<html><body>VISIBLE</body></html>", {
  resources: { __PAGEPACK_RESOURCE_0__: { name: "one" }, __PAGEPACK_RESOURCE_1__: { name: "two" } },
  context: { elements: [img, missing, style, inline] },
});
assert.equal(tokenised.rendered.at(-1).hasContent, true);
assert.equal(img.getAttribute("src"), "blob:null/one");
assert.equal(img.getAttribute("srcset"), "blob:null/one 1x, blob:null/two 2x");
assert.equal(img.getAttribute("alt"), "x", "attributes without tokens are untouched");
assert.equal(missing.getAttribute("src"), null, "a token with no resource is removed, never left as an address");
assert.equal(style.textContent, "body{background:url(blob:null/two)}");
assert.equal(inline.getAttribute("style"), "background:url(blob:null/one)");

// The same Blob resolves to one URL however many times it is referenced.
const twice = makeElement("img", { src: "__PAGEPACK_RESOURCE_0__", "data-poster": "__PAGEPACK_RESOURCE_0__" });
await render("<html><body>VISIBLE</body></html>", {
  resources: { __PAGEPACK_RESOURCE_0__: { name: "same" } },
  context: { elements: [twice] },
});
assert.equal(twice.getAttribute("src"), twice.getAttribute("data-poster"));

// With scripts on the substitution happens in the string, still in one pass.
const written = await render('<html><body><img src="__PAGEPACK_RESOURCE_0__">VISIBLE</body></html>', {
  runScripts: true,
  resources: { __PAGEPACK_RESOURCE_0__: { name: "w" } },
});
assert.match(written.document.written, /src="blob:null\/w"/);
assert.doesNotMatch(written.document.written, /__PAGEPACK_RESOURCE_/);

/* ------------------------------------------------------------------ *
 * The bridge and the expected-offline filters
 * ------------------------------------------------------------------ */

const bridged = await render("<html><body>VISIBLE</body></html>");
assert.equal(typeof bridged.documentListeners.click, "function", "the link bridge is installed by the sandbox itself");
let reported = null;
const link = { nodeType: 1, closest: () => ({ getAttribute: () => "/next" }) };
bridged.documentListeners.click({ button: 0, target: link, preventDefault() { reported = "prevented"; } });
const linkEvent = bridged.events.find((event) => event.source === "pagepack-saved-page" && event.type === "link");
assert.equal(reported, "prevented");
assert.equal(linkEvent?.href, "https://example.test/next", "a relative link resolves against the page's own address");

assert.equal(await filteredErrorFixture("error", { message: "Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag." }), true);
assert.equal(await filteredErrorFixture("unhandledrejection", { reason: new Error("Failed to resolve module specifier \"./chunk.js\". Invalid relative url or base scheme isn't hierarchical.") }), true);
assert.equal(await filteredErrorFixture("error", { target: { tagName: "IMG" } }), true);
assert.equal(await filteredErrorFixture("securitypolicyviolation", { blockedURI: "https://maps.gstatic.com/tactile/basepage/loader_beige_2x.gif" }), true);

console.log("Sandbox render detection tests passed");

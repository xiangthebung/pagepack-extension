import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../sandbox.js", import.meta.url), "utf8");

async function renderFixture(markup) {
  const events = [];
  const listeners = {};
  const body = {
    innerText: "",
    querySelectorAll: () => ({ length: 0 }),
  };
  const document = {
    body,
    open() {},
    write(value) {
      body.innerText = String(value).includes("VISIBLE") ? "A visible saved article" : "";
    },
    close() {},
  };
  const window = {
    parent: { postMessage(message) { events.push(message); } },
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  vm.runInNewContext(source, { window, document, setTimeout, clearTimeout }, { filename: "sandbox.js" });
  listeners.message({ data: { source: "pagepack-viewer", type: "load-start" } });
  listeners.message({ data: { source: "pagepack-viewer", type: "load-chunk", chunk: markup } });
  listeners.message({ data: { source: "pagepack-viewer", type: "load-end" } });
  await new Promise((resolve) => setTimeout(resolve, 1700));
  return events.filter((event) => event.type === "rendered");
}

async function filteredErrorFixture(eventName, payload) {
  const listeners = {};
  const window = {
    parent: { postMessage() {} },
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  vm.runInNewContext(source, {
    window,
    document: { body: { innerText: "", querySelectorAll: () => ({ length: 0 }) } },
    setTimeout,
    clearTimeout,
  }, { filename: "sandbox.js" });
  let prevented = false;
  listeners[eventName]({ ...payload, preventDefault() { prevented = true; } });
  return prevented;
}

const visible = await renderFixture("<html><body>VISIBLE</body></html>");
assert.equal(visible.at(-1).phase, "settled");
assert.equal(visible.at(-1).hasContent, true);

const blank = await renderFixture("<html><body></body></html>");
assert.equal(blank.at(-1).phase, "settled");
assert.equal(blank.at(-1).hasContent, false);

assert.equal(await filteredErrorFixture("error", { message: "Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag." }), true);
assert.equal(await filteredErrorFixture("unhandledrejection", { reason: new Error("Failed to resolve module specifier \"./chunk.js\". Invalid relative url or base scheme isn't hierarchical.") }), true);
assert.equal(await filteredErrorFixture("error", { target: { tagName: "IMG" } }), true);
assert.equal(await filteredErrorFixture("securitypolicyviolation", { blockedURI: "https://maps.gstatic.com/tactile/basepage/loader_beige_2x.gif" }), true);

console.log("Sandbox render detection tests passed");

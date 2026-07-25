import assert from "node:assert/strict";
import { ignoreAllPackIssues, ignorePackIssue, retryPackIssue } from "../retry.js";

function makePack(overrides = {}) {
  return {
    id: "pack_test",
    rootUrl: "https://example.test/start",
    runScripts: false,
    pages: [{ url: "https://example.test/start", title: "Start", html: "<html></html>", resources: [], resourceMap: {} }],
    failures: [],
    visits: [],
    stats: { pages: 1, bytes: 10, resources: 0, failed: 0 },
    ...overrides,
  };
}

const savedPacks = [];
const putPack = async (pack) => savedPacks.push(JSON.parse(JSON.stringify(pack)));

const pagePack = makePack({
  failures: [{ type: "page", url: "https://example.test/missing", pageUrl: "https://example.test/start", message: "HTTP 404" }],
});
const pageRetry = await retryPackIssue(pagePack, 0, {
  putPack,
  maxTotalBytes: 1000,
  async fetchPageSource(url, options) {
    assert.equal(url, "https://example.test/missing");
    assert.equal(options.captureMedia, true);
    return { url, title: "Recovered", html: "<html>Recovered</html>", resources: [{ token: "img", url: "https://example.test/image.png", kind: "media" }] };
  },
  async hydrateResources(page, resourceCache) {
    page.resourceMap.img = "data:image/png;base64,recovered";
    resourceCache.set("media:https://example.test/image.png", { dataUrl: page.resourceMap.img, bytes: 50 });
    return { bytes: 50, failures: [] };
  },
});
assert.equal(pageRetry.pages.length, 2);
assert.equal(pageRetry.pages[1].title, "Recovered");
assert.equal(pageRetry.failures.length, 0);
assert.deepEqual(pageRetry.stats, { pages: 2, bytes: 60, resources: 1, failed: 0 });
assert.equal(pageRetry.visits.at(-1).pageUrl, "https://example.test/missing");

const retryWithNewErrorPack = makePack({
  failures: [{ type: "page", url: "https://example.test/retry", message: "HTTP 404" }],
});
const retryWithNewError = await retryPackIssue(retryWithNewErrorPack, 0, {
  putPack,
  async fetchPageSource(url) { return { url, title: "Retry", html: "<html></html>", resources: [] }; },
  async hydrateResources() {
    return { bytes: 0, failures: [{ url: "https://example.test/new-file.css", kind: "style", message: "HTTP 500" }] };
  },
});
assert.equal(retryWithNewError.pages.length, 2);
assert.equal(retryWithNewError.failures[0].type, "resource");
assert.equal(retryWithNewError.failures[0].message, "HTTP 500");

const failedRetryPack = makePack({
  failures: [{ type: "page", url: "https://example.test/still-missing", message: "HTTP 404" }],
});
await assert.rejects(
  retryPackIssue(failedRetryPack, 0, {
    putPack,
    async fetchPageSource() { throw new Error("HTTP 503"); },
    async hydrateResources() { return { bytes: 0, failures: [] }; },
  }),
  /HTTP 503/
);
assert.equal(failedRetryPack.failures[0].message, "HTTP 503");
assert.equal(failedRetryPack.failures[0].retryCount, 1);

const resourcePack = makePack({
  failures: [{ type: "resource", url: "https://example.test/app.js", pageUrl: "https://example.test/start", kind: "script", message: "HTTP 404" }],
  pages: [{
    url: "https://example.test/start",
    title: "Start",
    html: "<html></html>",
    resources: [{ token: "script", url: "https://example.test/app.js", kind: "script" }],
    resourceMap: { script: "https://example.test/app.js" },
  }],
});
const resourceRetry = await retryPackIssue(resourcePack, 0, {
  putPack,
  async fetchResource(resource, resourceCache) {
    assert.equal(resource.kind, "script");
    resourceCache.set(`${resource.kind}:${resource.url}`, { dataUrl: "data:text/javascript;base64,ok", bytes: 7 });
    return { dataUrl: "data:text/javascript;base64,ok", bytes: 7 };
  },
});
assert.equal(resourceRetry.pages[0].resourceMap.script, "data:text/javascript;base64,ok");
assert.equal(resourceRetry.failures.length, 0);
assert.equal(resourceRetry.stats.bytes, 17);
assert.equal(resourceRetry.stats.resources, 1);

const failedResourcePack = makePack({
  failures: [{ type: "resource", url: "https://example.test/broken.css", pageUrl: "https://example.test/start", kind: "style", message: "HTTP 404" }],
  pages: [{
    url: "https://example.test/start",
    resources: [{ token: "style", url: "https://example.test/broken.css", kind: "style" }],
    resourceMap: { style: "https://example.test/broken.css" },
  }],
});
await assert.rejects(
  retryPackIssue(failedResourcePack, 0, {
    putPack,
    async fetchResource() { throw new Error("HTTP 503"); },
  }),
  /HTTP 503/
);
assert.equal(failedResourcePack.failures[0].message, "HTTP 503");
assert.equal(failedResourcePack.failures[0].retryCount, 1);

const ignoredPack = makePack({ failures: [{ type: "page", url: "https://example.test/ignored", message: "HTTP 404" }] });
await ignorePackIssue(ignoredPack, 0, putPack);
assert.equal(ignoredPack.failures.length, 0);
assert.equal(ignoredPack.stats.failed, 0);

const ignoredAllPack = makePack({ failures: [
  { type: "page", url: "https://example.test/one", message: "HTTP 404" },
  { type: "resource", url: "https://example.test/two.js", pageUrl: "https://example.test/start", message: "HTTP 404" },
] });
await ignoreAllPackIssues(ignoredAllPack, putPack);
assert.equal(ignoredAllPack.failures.length, 0);
assert.equal(ignoredAllPack.stats.failed, 0);

console.log("Retry behavior tests passed");

import assert from "node:assert/strict";
import { removePackPageFromPack } from "../pack-page.js";

const pack = {
  pages: [
    { url: "https://example.test/start#top", bytes: 10, resourceCount: 2 },
    { url: "https://example.test/second", bytes: 20, resourceCount: 3 },
  ],
  failures: [
    { type: "resource", pageUrl: "https://example.test/second", url: "https://example.test/broken.css" },
    { type: "page", url: "https://example.test/other", message: "HTTP 404" },
  ],
  visits: [
    { pageUrl: "https://example.test/start", parentUrl: null },
    { pageUrl: "https://example.test/second", parentUrl: "https://example.test/start" },
  ],
  stats: { pages: 2, bytes: 30, resources: 5, failed: 2 },
};

removePackPageFromPack(pack, 1);
assert.deepEqual(pack.pages.map((page) => page.url), ["https://example.test/start#top"]);
assert.equal(pack.failures.length, 1);
assert.equal(pack.failures[0].url, "https://example.test/other");
assert.equal(pack.visits.length, 1);
assert.deepEqual(pack.stats, { pages: 1, bytes: 10, resources: 2, failed: 1 });

assert.throws(
  () => removePackPageFromPack({ pages: [{ url: "https://example.test/only" }] }, 0),
  /Keep at least one page/
);

const legacyPack = {
  pages: [{ url: "https://example.test/legacy-start" }, { url: "https://example.test/legacy-second" }],
  stats: { pages: 2, bytes: 80, resources: 6, failed: 0 },
};
removePackPageFromPack(legacyPack, 0);
assert.deepEqual(legacyPack.stats, { pages: 1, bytes: 80, resources: 6, failed: 0 });

console.log("Captured page removal tests passed");

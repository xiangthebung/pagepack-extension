/**
 * What the reader remembers, and what the library shows because of it.
 *
 * Reading state lives in its own store, one small row per pack: the page the
 * reader was on, how far down each page, and which pages have been opened.
 * Keeping it beside the pack rather than inside it is the whole point — a
 * scroll position that rewrote a 30 MB record would be the wrong shape — so
 * the first assertion is that opening a page writes nothing to `packs`.
 *
 * Thumbnails follow the same rule, and both go with the pack when it is deleted.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { indexedDB, IDBKeyRange, IDBObjectStore } = require("fake-indexeddb");
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const puts = [];
const originalPut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function countedPut(value, key) {
  puts.push(this.name);
  return originalPut.call(this, value, key);
};

const {
  deletePack, findSavedUrl, getReadingState, getThumbnails, listReadingStates, makePackId, putPack, putReadingState, putThumbnail,
} = await import("../storage.js");

function samplePack(id, urls) {
  return {
    id,
    rootUrl: urls[0],
    title: "A saved thing",
    savedAt: 1000,
    depth: 1,
    runScripts: true,
    scope: "site",
    sortOrder: 0,
    folderId: null,
    favicon: "data:image/png;base64,AAAA",
    limits: { maxPages: 250, maxTotalBytes: 1024 ** 3 },
    pages: urls.map((url, index) => ({ url, title: `Page ${index}`, html: "<p>hi</p>", resources: [], resourceMap: {} })),
    failures: [],
    stats: { pages: urls.length, bytes: 10, resources: 0, failed: 0 },
  };
}

const id = makePackId();
await putPack(samplePack(id, ["https://example.test/one", "https://example.test/two", "https://example.test/three"]));

/* ------------------------------------------------------------------ *
 * Nothing until opened; then a small row, and never the pack
 * ------------------------------------------------------------------ */

assert.equal(await getReadingState(id), null, "an unopened pack has no reading state, which is what 'unread' means");
assert.deepEqual(await listReadingStates(), {});

puts.length = 0;
await putReadingState(id, { pageIndex: 1 });
assert.deepEqual(puts, ["reading"], "opening a page wrote somewhere other than the reading store");

let state = await getReadingState(id);
assert.equal(state.pageIndex, 1);
assert.deepEqual(state.opened, { 1: true });
assert.ok(state.lastOpenedAt > 0);
assert.deepEqual(state.scroll, {});

// A scroll position is kept per page and does not disturb the other pages'.
await putReadingState(id, { pageIndex: 1, scrollTop: 1234.6 });
await putReadingState(id, { pageIndex: 2, scrollTop: 40 });
state = await getReadingState(id);
assert.equal(state.pageIndex, 2, "the reader resumes on the page last opened");
assert.deepEqual(state.scroll, { 1: 1235, 2: 40 });
assert.deepEqual(state.opened, { 1: true, 2: true });

// A patch without a page keeps the current one; a negative scroll is clamped.
await putReadingState(id, { scrollTop: -5 });
state = await getReadingState(id);
assert.equal(state.pageIndex, 2);
assert.equal(state.scroll[2], 0);

const listed = await listReadingStates();
assert.deepEqual(Object.keys(listed), [id]);
assert.equal(listed[id].pageIndex, 2);

/* ------------------------------------------------------------------ *
 * Thumbnails: their own store, keyed by pack
 * ------------------------------------------------------------------ */

await putThumbnail(id, "data:image/jpeg;base64,/9j/");
await putThumbnail(id, "not a picture");
await putThumbnail("someone-else", "data:image/jpeg;base64,/9j/x");
assert.deepEqual(await getThumbnails([id, "missing"]), { [id]: "data:image/jpeg;base64,/9j/" });
assert.deepEqual(await getThumbnails([]), {});

/* ------------------------------------------------------------------ *
 * The library index carries the icon and the update time
 * ------------------------------------------------------------------ */

const { listPacks } = await import("../storage.js");
let [summary] = await listPacks();
assert.equal(summary.favicon, "data:image/png;base64,AAAA");
assert.equal(summary.updatedAt, null);

// An update keeps the save date for ordering and records when the copy changed;
// the URL index ranks the copy by the later of the two.
await putPack({ ...samplePack(id, ["https://example.test/one", "https://example.test/two"]), updatedAt: 5000 });
[summary] = await listPacks();
assert.equal(summary.savedAt, 1000);
assert.equal(summary.updatedAt, 5000);
assert.equal((await findSavedUrl("https://example.test/one")).savedAt, 5000);
// A page dropped by the update is no longer findable.
assert.equal(await findSavedUrl("https://example.test/three"), null, "a URL removed by an update stayed in the index");

/* ------------------------------------------------------------------ *
 * Deleting the pack takes its reading state and its thumbnail
 * ------------------------------------------------------------------ */

await deletePack(id);
assert.equal(await getReadingState(id), null);
assert.deepEqual(await getThumbnails([id]), {});
assert.deepEqual(await getThumbnails(["someone-else"]), { "someone-else": "data:image/jpeg;base64,/9j/x" }, "deleting one pack removed another's thumbnail");

IDBObjectStore.prototype.put = originalPut;
console.log("Reading state tests passed");

/**
 * Deleting a pack takes its index rows with it.
 *
 * A pack's bytes all live in one `packs` row, so deleting that row reclaims the
 * space. The rows that used to be left behind were in `urlIndex` — one per saved
 * page, the thing that answers "have I saved this already?".
 *
 * `deletePack` derived those keys from `pack.pages`, which only works while the
 * pack is still readable. When it was not — a second delete of the same id, which
 * the library makes reachable by removing the row optimistically and then
 * reloading — `getPack` returned undefined, the loop over `pack?.pages || []` ran
 * zero times, and the delete reported success having removed nothing from
 * `urlIndex`. Nothing could find those rows afterwards: the store is keyed by URL
 * and indexed by URL, with no index on the pack and no sweep anywhere.
 *
 * The visible symptom was a save that would not go away. `findSavedUrl` kept
 * matching, so the page still showed as saved, and opening it led to a reader
 * page for a pack that no longer existed.
 *
 * The second case below is the one that matters; the first would pass against the
 * old implementation too.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const { deletePack, findSavedUrl, getPack, listPacks, makePackId, putPack } = await import("../storage.js");

function samplePack(id, urls) {
  return {
    id,
    rootUrl: urls[0],
    title: "A saved thing",
    savedAt: Date.now(),
    depth: 1,
    runScripts: true,
    scope: "site",
    sortOrder: 0,
    folderId: null,
    limits: { maxPages: 250, maxTotalBytes: 1024 ** 3 },
    pages: urls.map((url, index) => ({ url, title: `Page ${index}`, html: "<p>hi</p>", resources: [], resourceMap: {} })),
    failures: [],
    stats: { pages: urls.length, bytes: 10, resources: 0, failed: 0 },
  };
}

/** Every `urlIndex` row, read straight out of the database. */
function urlIndexRows() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("pagepack-db");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("urlIndex", "readonly").objectStore("urlIndex").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}

/** Delete only the `packs` row, leaving the index rows orphaned. */
function deleteOnlyThePackRow(id) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("pagepack-db");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("packs", "readwrite");
      transaction.objectStore("packs").delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

/* ------------------------------------------------------------------ *
 * The ordinary delete
 * ------------------------------------------------------------------ */

const first = makePackId();
await putPack(samplePack(first, ["https://example.test/one", "https://example.test/two"]));

assert.equal((await listPacks()).length, 1);
assert.ok(await findSavedUrl("https://example.test/two"), "the saved URL should be findable before the delete");
assert.equal((await urlIndexRows()).length, 2);

await deletePack(first);

assert.equal(await getPack(first), undefined);
assert.equal((await listPacks()).length, 0);
assert.equal(await findSavedUrl("https://example.test/one"), null);
assert.equal(await findSavedUrl("https://example.test/two"), null);
assert.deepEqual(await urlIndexRows(), [], "the URL index still holds rows for a deleted pack");

/* ------------------------------------------------------------------ *
 * The delete that finds no pack — the case that used to leak
 * ------------------------------------------------------------------ */

const second = makePackId();
await putPack(samplePack(second, ["https://example.test/three", "https://example.test/four"]));
assert.equal((await urlIndexRows()).length, 2);

// Stand in for the race: the pack row is gone, its index rows are not.
await deleteOnlyThePackRow(second);
assert.equal(await getPack(second), undefined, "the pack row should be gone for this case to mean anything");
assert.equal((await urlIndexRows()).length, 2, "the index rows should still be there before the delete");

await deletePack(second);

assert.deepEqual(
  await urlIndexRows(), [],
  "deleting a pack whose row was already gone left its URL index rows behind, and nothing can ever find them again",
);
assert.equal(await findSavedUrl("https://example.test/three"), null, "a deleted pack is still reported as saved");

/* ------------------------------------------------------------------ *
 * Deleting one pack leaves the others alone
 * ------------------------------------------------------------------ */

const keep = makePackId();
const drop = makePackId();
await putPack(samplePack(keep, ["https://example.test/keep-a", "https://example.test/keep-b"]));
await putPack(samplePack(drop, ["https://example.test/drop-a"]));
assert.equal((await urlIndexRows()).length, 3);

await deletePack(drop);

assert.equal((await urlIndexRows()).length, 2, "deleting one pack removed another pack's index rows");
assert.ok(await findSavedUrl("https://example.test/keep-a"));
assert.equal(await findSavedUrl("https://example.test/drop-a"), null);

console.log("Pack deletion tests passed");

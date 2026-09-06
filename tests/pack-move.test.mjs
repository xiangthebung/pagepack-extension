/**
 * Moving a pack touches the pack that moved, and nothing else.
 *
 * `movePack` and `moveAndReorderPack` used to renumber both folders and write
 * every pack in each — read the whole row, put the whole row — to change one
 * field on one of them. A library of large saves paid for that on every drag.
 * Now a moved pack takes a sort value between its new neighbours, so its row is
 * the only one written; the folder is only renumbered when the neighbours have
 * no room left between them, and even then only rows whose value changes go
 * back to the store.
 *
 * Writes are counted at the IndexedDB boundary, by wrapping `put` on the object
 * store, so the assertion is about what reaches disk rather than what the code
 * intended.
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
  puts.push({ store: this.name, id: value?.id ?? value?.key ?? key });
  return originalPut.call(this, value, key);
};
const packWrites = () => puts.filter((entry) => entry.store === "packs").map((entry) => entry.id);

const { getPack, listPacks, makePackId, moveAndReorderPack, movePack, putPack } = await import("../storage.js");

function samplePack(id, folderId, sortOrder, title) {
  return {
    id,
    rootUrl: `https://example.test/${id}`,
    title,
    savedAt: Date.now(),
    depth: 0,
    runScripts: true,
    scope: "site",
    sortOrder,
    folderId,
    limits: { maxPages: 250, maxTotalBytes: 1024 ** 3 },
    pages: [{ url: `https://example.test/${id}`, title, html: `<p>${title}</p>`, resources: [], resourceMap: {} }],
    failures: [],
    stats: { pages: 1, bytes: 10, resources: 0, failed: 0 },
  };
}

async function orderIn(folderId) {
  const summaries = await listPacks();
  return summaries
    .filter((pack) => (pack.folderId || null) === (folderId || null))
    .sort((a, b) => a.sortOrder - b.sortOrder || b.savedAt - a.savedAt)
    .map((pack) => pack.id);
}

const root = ["r0", "r1", "r2"].map((id) => makePackId());
const research = ["f0", "f1", "f2"].map((id) => makePackId());
for (const [index, id] of root.entries()) await putPack(samplePack(id, null, index, `Root ${index}`));
for (const [index, id] of research.entries()) await putPack(samplePack(id, "folder_research", index, `Research ${index}`));

/* ------------------------------------------------------------------ *
 * Into another folder: one row
 * ------------------------------------------------------------------ */

puts.length = 0;
await movePack(root[1], "folder_research");
assert.deepEqual(packWrites(), [root[1]], "moving into a folder wrote more than the moved pack");
assert.deepEqual(await orderIn("folder_research"), [root[1], ...research], "the moved pack goes to the top of its new folder");
assert.deepEqual(await orderIn(null), [root[0], root[2]], "the rest of the source folder kept its order");
const moved = await getPack(root[1]);
assert.equal(moved.folderId, "folder_research");
assert.deepEqual(moved.pages.map((page) => page.title), ["Root 1"], "the pack row still holds its pages");

// Moving to where it already is writes nothing.
puts.length = 0;
await movePack(root[1], "folder_research");
assert.deepEqual(packWrites(), []);

/* ------------------------------------------------------------------ *
 * Reordering within a folder: one row, between its neighbours
 * ------------------------------------------------------------------ */

// The folder is [root1, f0, f1, f2]; drag f2 up between root1 and f0.
puts.length = 0;
await moveAndReorderPack(research[2], "folder_research", [root[1], research[2], research[0], research[1]]);
assert.deepEqual(packWrites(), [research[2]], "reordering wrote more than the dragged pack");
assert.deepEqual(await orderIn("folder_research"), [root[1], research[2], research[0], research[1]]);

// And to the very end.
puts.length = 0;
await moveAndReorderPack(root[1], "folder_research", [research[2], research[0], research[1], root[1]]);
assert.deepEqual(packWrites(), [root[1]]);
assert.deepEqual(await orderIn("folder_research"), [research[2], research[0], research[1], root[1]]);

// Dropping into the same slot changes nothing and writes nothing.
puts.length = 0;
await moveAndReorderPack(research[0], "folder_research", [research[2], research[0], research[1], root[1]]);
assert.deepEqual(packWrites(), []);

/* ------------------------------------------------------------------ *
 * Across folders with a position: still one row
 * ------------------------------------------------------------------ */

puts.length = 0;
await moveAndReorderPack(research[1], null, [root[0], research[1], root[2]]);
assert.deepEqual(packWrites(), [research[1]]);
assert.deepEqual(await orderIn(null), [root[0], research[1], root[2]]);
assert.deepEqual(await orderIn("folder_research"), [research[2], research[0], root[1]]);

/* ------------------------------------------------------------------ *
 * The gap runs out: the folder is renumbered, and only changed rows are written
 * ------------------------------------------------------------------ */

// Dropping the same pack into the same slot between two fixed neighbours halves
// the gap each time. Sixty drops is far past the point the code gives up
// splitting and renumbers instead.
const [first, second, third] = await orderIn("folder_research");
let renumbered = false;
for (let round = 0; round < 60; round += 1) {
  puts.length = 0;
  const target = round % 2 === 0 ? [first, third, second] : [first, second, third];
  await moveAndReorderPack(round % 2 === 0 ? third : second, "folder_research", target);
  if (packWrites().length > 1) {
    renumbered = true;
    const values = (await listPacks()).filter((pack) => pack.folderId === "folder_research").map((pack) => pack.sortOrder).sort((a, b) => a - b);
    assert.deepEqual(values, [0, 1, 2], "a renumbered folder counts from zero in whole numbers");
    break;
  }
}
assert.ok(renumbered, "the gap between neighbours never ran out, which means the fractional placement is not being used");
assert.deepEqual((await orderIn("folder_research")).length, 3);

IDBObjectStore.prototype.put = originalPut;
console.log("Pack move tests passed");

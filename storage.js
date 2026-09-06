import { removePackPageFromPack } from "./pack-page.js";
import { journeyQueueSummary } from "./journey-queue.js";

const PAGEPACK_DB = "pagepack-db";
// 10 adds two small stores beside the packs: `reading`, one row per pack holding
// where the reader got to, and `thumbnails`, a picture of the tab at the moment
// it was saved. Both are kept out of the pack row on purpose — a scroll position
// that rewrote a 30 MB record every second would be the wrong shape entirely.
const PAGEPACK_DB_VERSION = 10;
const LEGACY_ROOT_FOLDER_ID = "unfiled";
// Bounded per page so the library index stays small enough to read and search
// quickly. Enough text to match a title, headings, and the opening paragraphs.
const SEARCH_TEXT_LIMIT = 4000;
/* Two placed neighbours whose sort values are this close have run out of room
   between them, and the folder is renumbered instead of splitting the gap again.
   Reached only after a few dozen consecutive drops into the same slot. */
const MIN_SORT_GAP = 1e-6;
export const DEFAULT_FOLDER_ID = null;
export const FOLDER_NAME_LIMIT = 60;

function normalizeFolderId(folderId) {
  return folderId === LEGACY_ROOT_FOLDER_ID || folderId === "folder_unfiled" || !folderId ? DEFAULT_FOLDER_ID : folderId;
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function folderSortValue(folder) {
  const order = Number(folder?.sortOrder);
  return Number.isFinite(order) ? order : Number(folder?.createdAt || 0);
}

function packSortValue(pack) {
  const order = Number(pack?.sortOrder);
  return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

/** When the copy in the pack was last captured: the update if there was one, else the save. */
function packCapturedAt(pack) {
  return Number(pack?.updatedAt) || Number(pack?.savedAt) || 0;
}

function completeKnownOrder(requestedIds, existingIds) {
  const existing = [...new Set(existingIds)];
  const existingSet = new Set(existing);
  const requested = [];
  const seen = new Set();
  for (const id of Array.isArray(requestedIds) ? requestedIds : []) {
    if (!existingSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    requested.push(id);
  }
  if (!requested.length) return existing;
  let requestedIndex = 0;
  return existing.map((id) => seen.has(id) ? requested[requestedIndex++] : id);
}

function orderedPacksFor(summaries, folderId) {
  const normalizedFolderId = normalizeFolderId(folderId);
  return summaries
    .filter((pack) => normalizeFolderId(pack.folderId) === normalizedFolderId)
    .sort((a, b) => packSortValue(a) - packSortValue(b) || Number(b.savedAt || 0) - Number(a.savedAt || 0));
}

function orderedPackIdsFor(summaries, folderId) {
  return orderedPacksFor(summaries, folderId).map((pack) => pack.id);
}

function searchableText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_TEXT_LIMIT)
    .toLowerCase();
}

/** The site icon the library shows for a pack: the root page's, or the first page that has one. */
function packFavicon(pack) {
  if (typeof pack.favicon === "string" && pack.favicon.startsWith("data:")) return pack.favicon;
  const page = (pack.pages || []).find((candidate) => typeof candidate.favicon === "string" && candidate.favicon.startsWith("data:"));
  return page ? page.favicon : null;
}

function packSummary(pack) {
  return {
    id: pack.id,
    rootUrl: pack.rootUrl,
    title: pack.title || pack.rootUrl,
    savedAt: pack.savedAt,
    updatedAt: Number(pack.updatedAt) || null,
    depth: pack.depth,
    runScripts: pack.runScripts !== false,
    captureMode: pack.captureMode || (pack.scope === "journey" ? "journey" : "page"),
    folderId: normalizeFolderId(pack.folderId),
    sortOrder: pack.sortOrder,
    favicon: packFavicon(pack),
    stats: pack.stats || { pages: pack.pages?.length || 0, bytes: 0, resources: 0 },
    failures: Array.isArray(pack.failures) ? pack.failures.slice(0, 500) : [],
    pages: (pack.pages || []).map((page) => ({
      url: page.url,
      title: page.title,
      searchText: searchableText(page.html)
    }))
  };
}

function urlIndexRow(pack, page, pageIndex) {
  const url = canonicalUrl(page.url);
  return {
    key: `${url}|${pack.id}`,
    url,
    packId: pack.id,
    pageUrl: url,
    pageIndex,
    savedAt: packCapturedAt(pack)
  };
}

function openPagePackDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PAGEPACK_DB, PAGEPACK_DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const transaction = request.transaction;
      if (!db.objectStoreNames.contains("packs")) db.createObjectStore("packs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("folders")) db.createObjectStore("folders", { keyPath: "id" });
      if (!db.objectStoreNames.contains("packIndex")) db.createObjectStore("packIndex", { keyPath: "id" });
      if (!db.objectStoreNames.contains("urlIndex")) {
        const urlIndex = db.createObjectStore("urlIndex", { keyPath: "key" });
        urlIndex.createIndex("byUrl", "url", { unique: false });
      }
      if (!db.objectStoreNames.contains("captures")) db.createObjectStore("captures", { keyPath: "id" });
      if (!db.objectStoreNames.contains("journeys")) db.createObjectStore("journeys", { keyPath: "id" });
      if (!db.objectStoreNames.contains("reading")) db.createObjectStore("reading", { keyPath: "packId" });
      if (!db.objectStoreNames.contains("thumbnails")) db.createObjectStore("thumbnails", { keyPath: "id" });

      const folders = transaction.objectStore("folders");
      if (event.oldVersion < 4) folders.delete(LEGACY_ROOT_FOLDER_ID);
      if (event.oldVersion < 5) {
        const folderRequest = folders.getAll();
        folderRequest.onsuccess = () => {
          folderRequest.result
            .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0) || a.name.localeCompare(b.name))
            .forEach((folder, index) => folders.put({ ...folder, sortOrder: index }));
        };
      }

      const packOrderById = new Map();
      if (transaction.objectStoreNames?.contains("packs")) {
        const packs = transaction.objectStore("packs");
        const packIndex = transaction.objectStore("packIndex");
        const urlIndex = transaction.objectStore("urlIndex");
        if (event.oldVersion < 8) urlIndex.clear();
        if (event.oldVersion < 6) {
          const packOrderRequest = packs.getAll();
          packOrderRequest.onsuccess = () => {
            const groups = new Map();
            packOrderRequest.result.forEach((pack) => {
              const folderId = normalizeFolderId(pack.folderId) || "";
              if (!groups.has(folderId)) groups.set(folderId, []);
              groups.get(folderId).push(pack);
            });
            groups.forEach((group) => {
              group
                .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0))
                .forEach((pack, index) => packOrderById.set(pack.id, index));
            });
          };
        }
        /* The index is rebuilt on every upgrade, because its shape is what upgrades
           change. The pack row itself is only rewritten when a field on it actually
           changes: a library of large saves must not be copied in full to add a
           column the packs do not carry. */
        packs.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          const pack = cursor.value;
          const folderId = normalizeFolderId(pack.folderId);
          const sortOrder = packOrderById.has(pack.id) ? packOrderById.get(pack.id) : pack.sortOrder;
          if (folderId !== pack.folderId || sortOrder !== pack.sortOrder) {
            pack.folderId = folderId;
            pack.sortOrder = sortOrder;
            cursor.update(pack);
          }
          packIndex.put(packSummary(pack));
          for (const [pageIndex, page] of (pack.pages || []).entries()) {
            urlIndex.put(urlIndexRow(pack, page, pageIndex));
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runStoreRequest(storeName, mode, operation) {
  return openPagePackDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    /* The transaction can fail without the individual request ever failing, and
       running out of disk is exactly that case: IndexedDB aborts at commit time.
       Without this handler the promise simply never settled — `putJourney` is the
       biggest write in the extension, so a full disk during "Save as I browse"
       left the queue waiting on a promise that could not resolve, with no error
       and nothing in the interface to say so. `runTransaction` below always had
       this; this function did not. */
    transaction.onabort = () => reject(transaction.error || new Error("Storage transaction was aborted."));
  }));
}

function runTransaction(storeNames, mode, operation) {
  return openPagePackDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    try {
      operation(transaction);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Storage transaction was aborted."));
  }));
}

export function putPack(pack) {
  const normalizedPack = {
    ...pack,
    folderId: normalizeFolderId(pack.folderId),
    sortOrder: Number.isFinite(Number(pack.sortOrder)) ? Number(pack.sortOrder) : 0,
  };
  const summary = packSummary(normalizedPack);
  return runTransaction(["packs", "packIndex", "urlIndex"], "readwrite", (transaction) => {
    transaction.objectStore("packs").put(normalizedPack);
    transaction.objectStore("packIndex").put(summary);
    const urlIndex = transaction.objectStore("urlIndex");
    // An update can drop a page, so rows for this pack are cleared before being
    // written again; otherwise a URL removed from the pack would stay findable.
    urlIndex.openCursor().onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        for (const [pageIndex, page] of (normalizedPack.pages || []).entries()) {
          urlIndex.put(urlIndexRow(normalizedPack, page, pageIndex));
        }
        return;
      }
      if (cursor.value?.packId === normalizedPack.id) cursor.delete();
      cursor.continue();
    };
  });
}

export function getPack(id) {
  return runStoreRequest("packs", "readonly", (store) => store.get(id));
}

function readPackIndex() {
  return runStoreRequest("packIndex", "readonly", (store) => store.getAll())
    .then((packs) => (Array.isArray(packs) ? packs : []).sort((a, b) => b.savedAt - a.savedAt));
}

/**
 * Compact library listing. Page text and the per-issue detail stay in the
 * database so a listing never has to travel through extension messaging;
 * `searchPackText` and `getPackIssues` read them on demand instead.
 */
export function listPacks() {
  return readPackIndex().then((packs) => packs.map(({ failures, pages, ...pack }) => ({
    ...pack,
    pages: (pages || []).map((page) => ({ url: page.url, title: page.title })),
  })));
}

export function getPackIssues(id) {
  return runStoreRequest("packIndex", "readonly", (store) => store.get(id))
    .then((summary) => (Array.isArray(summary?.failures) ? summary.failures : []));
}

/** Pack ids whose captured page text contains every whitespace-separated term. */
export function searchPackText(query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return Promise.resolve([]);
  return readPackIndex().then((packs) => packs
    .filter((pack) => (pack.pages || []).some((page) => {
      const haystack = `${String(page.title || "").toLowerCase()} ${page.searchText || ""}`;
      return terms.every((term) => haystack.includes(term));
    }))
    .map((pack) => pack.id));
}

/**
 * Delete a pack and everything that points at it.
 *
 * The `urlIndex` rows are found by walking the store rather than by deriving keys
 * from `pack.pages`. Deriving them looks simpler and was what this did, but it
 * only works when the pack is still readable and its page list still matches what
 * was written: a second delete of the same id — reachable because the library
 * removes the row optimistically and then reloads — found no pack, quietly skipped
 * the loop, and left every URL row behind while reporting success. Nothing could
 * find them afterwards, because the store is keyed by URL and indexed by URL, not
 * by pack. The symptom was a save that still claimed to exist: "already saved"
 * kept resolving, and its Open led to a reader page for a pack that was gone.
 */
export function deletePack(id) {
  return runTransaction(["packs", "packIndex", "urlIndex", "reading", "thumbnails"], "readwrite", (transaction) => {
    transaction.objectStore("packs").delete(id);
    transaction.objectStore("packIndex").delete(id);
    transaction.objectStore("reading").delete(id);
    transaction.objectStore("thumbnails").delete(id);
    const urlIndex = transaction.objectStore("urlIndex");
    urlIndex.openCursor().onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      if (cursor.value?.packId === id) cursor.delete();
      cursor.continue();
    };
  });
}

export function removePackPage(id, pageIndex) {
  return getPack(id).then((pack) => {
    if (!pack) throw new Error("The saved pack could not be found.");
    const { removedPage } = removePackPageFromPack(pack, pageIndex);
    const normalizedPack = {
      ...pack,
      folderId: normalizeFolderId(pack.folderId),
      sortOrder: Number.isFinite(Number(pack.sortOrder)) ? Number(pack.sortOrder) : 0,
    };
    const summary = packSummary(normalizedPack);
    const removedUrl = canonicalUrl(removedPage.url);
    const stillPresent = (normalizedPack.pages || []).some((page) => canonicalUrl(page.url) === removedUrl);
    return runTransaction(["packs", "packIndex", "urlIndex"], "readwrite", (transaction) => {
      transaction.objectStore("packs").put(normalizedPack);
      transaction.objectStore("packIndex").put(summary);
      const urlIndex = transaction.objectStore("urlIndex");
      if (!stillPresent) urlIndex.delete(`${removedUrl}|${id}`);
      for (const [pageIndex, page] of (normalizedPack.pages || []).entries()) {
        urlIndex.put(urlIndexRow(normalizedPack, page, pageIndex));
      }
    }).then(() => normalizedPack);
  });
}

export function findSavedUrl(value) {
  const url = canonicalUrl(value);
  return runStoreRequest("urlIndex", "readonly", (store) => store.index("byUrl").getAll(url))
    .then((matches) => matches.sort((a, b) => b.savedAt - a.savedAt)[0] || null);
}

/** Every saved copy of each of the given URLs, newest first, keyed by canonical URL. */
export function findSavedUrls(values) {
  const urls = [...new Set((Array.isArray(values) ? values : []).map(canonicalUrl))];
  return Promise.all(urls.map((url) => findSavedUrl(url).then((match) => [url, match])))
    .then((pairs) => Object.fromEntries(pairs.filter(([, match]) => match)));
}

export function listFolders() {
  return runStoreRequest("folders", "readonly", (store) => store.getAll())
    .then((folders) => folders
      .filter((folder) => folder.id !== LEGACY_ROOT_FOLDER_ID)
      .sort((a, b) => folderSortValue(a) - folderSortValue(b) || a.name.localeCompare(b.name)));
}

export function putFolder(folder) {
  return runStoreRequest("folders", "readwrite", (store) => store.put(folder));
}

export function renameFolder(id, name) {
  const nextName = String(name || "").trim().slice(0, FOLDER_NAME_LIMIT);
  if (!nextName) return Promise.reject(new Error("Give the folder a name."));
  return runStoreRequest("folders", "readonly", (store) => store.get(id)).then((folder) => {
    if (!folder) throw new Error("That folder no longer exists.");
    if (folder.name === nextName) return folder;
    const renamed = { ...folder, name: nextName };
    return putFolder(renamed).then(() => renamed);
  });
}

export function deleteFolder(id) {
  return listPacks()
    .then((summaries) => {
      const deletions = (Array.isArray(summaries) ? summaries : [])
        .filter((pack) => pack.folderId === id)
        .map((summary) => deletePack(summary.id));
      return Promise.all(deletions);
    })
    .then(() => runStoreRequest("folders", "readwrite", (store) => store.delete(id)));
}

export function reorderFolders(folderIds) {
  return listFolders().then((existingFolders) => {
    const foldersById = new Map(existingFolders.map((folder) => [folder.id, folder]));
    const orderedIds = completeKnownOrder(folderIds, existingFolders.map((folder) => folder.id));
    return runTransaction(["folders"], "readwrite", (transaction) => {
      const store = transaction.objectStore("folders");
      orderedIds.forEach((id, index) => {
        const folder = foldersById.get(id);
        if (folder) store.put({ ...folder, sortOrder: index });
      });
    });
  });
}

/**
 * Write new placements for exactly the packs named, and nothing else.
 *
 * Each pack row is read and put inside the one transaction, and the index entry
 * is patched from the row that is already there rather than rebuilt — the search
 * text of a fifty-page save does not change when the save is dragged one slot.
 */
function placePacks(placements) {
  if (!placements.length) return Promise.resolve();
  return runTransaction(["packs", "packIndex"], "readwrite", (transaction) => {
    const packStore = transaction.objectStore("packs");
    const packIndexStore = transaction.objectStore("packIndex");
    for (const { id, folderId, sortOrder } of placements) {
      packStore.get(id).onsuccess = (event) => {
        const pack = event.target.result;
        if (!pack) return;
        packStore.put({ ...pack, folderId, sortOrder });
      };
      packIndexStore.get(id).onsuccess = (event) => {
        const summary = event.target.result;
        if (summary) packIndexStore.put({ ...summary, folderId, sortOrder });
      };
    }
  });
}

/** Renumber a whole folder 0..n-1 in the given order, writing only rows that change. */
function renumberPlacements(orderedPacks, folderId) {
  return orderedPacks
    .map((pack, index) => ({ id: pack.id, folderId, sortOrder: index }))
    .filter((placement, index) => {
      const pack = orderedPacks[index];
      return normalizeFolderId(pack.folderId) !== folderId || packSortValue(pack) !== placement.sortOrder;
    });
}

/**
 * Move a pack to the top of another folder.
 *
 * One row changes: the pack takes a sort value just below the folder's current
 * first item, so the rest of the folder keeps the numbers it has. This used to
 * renumber both folders and write every pack in each — for a move between two
 * folders of large saves that was hundreds of megabytes copied to change one
 * field on one row.
 */
export function movePack(id, folderId) {
  const targetFolderId = normalizeFolderId(folderId);
  return listPacks().then((summaries) => {
    const sourceSummary = summaries.find((pack) => pack.id === id);
    if (!sourceSummary) throw new Error("Saved pack not found.");
    if (normalizeFolderId(sourceSummary.folderId) === targetFolderId) return;
    const [first] = orderedPacksFor(summaries, targetFolderId).filter((pack) => pack.id !== id);
    const sortOrder = first ? Math.min(packSortValue(first), 0) - 1 : 0;
    return placePacks([{ id, folderId: targetFolderId, sortOrder }]);
  });
}

/**
 * Drop a pack at a position in a folder, given the folder's intended order.
 *
 * When only the dropped pack has moved — which is what a drag produces — it takes
 * a sort value between its two new neighbours and is the only row written. If the
 * requested order differs elsewhere, or the neighbours have no room between them,
 * the folder is renumbered, still writing only the rows whose value changes.
 */
export function moveAndReorderPack(id, folderId, orderedIds) {
  const targetFolderId = normalizeFolderId(folderId);
  return listPacks().then((summaries) => {
    const sourceSummary = summaries.find((pack) => pack.id === id);
    if (!sourceSummary) throw new Error("Saved pack not found.");
    const byId = new Map(summaries.map((pack) => [pack.id, pack]));
    const targetExisting = orderedPacksFor(summaries, targetFolderId).filter((pack) => pack.id !== id);
    const targetExistingIds = [id, ...targetExisting.map((pack) => pack.id)];
    const requestedIds = Array.isArray(orderedIds) && orderedIds.includes(id)
      ? orderedIds
      : [id, ...(Array.isArray(orderedIds) ? orderedIds : [])];
    const targetIds = completeKnownOrder(requestedIds, targetExistingIds);
    const others = targetIds.filter((packId) => packId !== id);
    const onlyThisMoved = others.every((packId, index) => packId === targetExisting[index]?.id);
    const position = targetIds.indexOf(id);
    if (onlyThisMoved) {
      const before = position > 0 ? byId.get(targetIds[position - 1]) : null;
      const after = position < targetIds.length - 1 ? byId.get(targetIds[position + 1]) : null;
      const lower = before ? packSortValue(before) : null;
      const upper = after ? packSortValue(after) : null;
      let sortOrder = null;
      if (lower === null && upper === null) sortOrder = 0;
      else if (lower === null) sortOrder = Math.min(upper, 0) - 1;
      else if (upper === null) sortOrder = lower + 1;
      else if (upper - lower > MIN_SORT_GAP) sortOrder = lower + (upper - lower) / 2;
      if (sortOrder !== null && Number.isFinite(sortOrder)) {
        // Dropped back where it already was: the value it has already sits
        // between its neighbours, so there is nothing to write.
        const current = packSortValue(sourceSummary);
        const alreadyPlaced = normalizeFolderId(sourceSummary.folderId) === targetFolderId
          && (lower === null || current > lower) && (upper === null || current < upper);
        return alreadyPlaced ? undefined : placePacks([{ id, folderId: targetFolderId, sortOrder }]);
      }
    }
    const orderedPacks = targetIds.map((packId) => byId.get(packId)).filter(Boolean);
    return placePacks(renumberPlacements(orderedPacks, targetFolderId));
  });
}

export function putCapture(capture) {
  return runStoreRequest("captures", "readwrite", (store) => store.put(capture));
}

export function getCapture(id) {
  return runStoreRequest("captures", "readonly", (store) => store.get(id));
}

export function listCaptures() {
  return runStoreRequest("captures", "readonly", (store) => store.getAll())
    .then((captures) => (Array.isArray(captures) ? captures : []).sort((a, b) => b.updatedAt - a.updatedAt));
}

export function deleteCapture(id) {
  return runStoreRequest("captures", "readwrite", (store) => store.delete(id));
}

/* ------------------------------------------------------------------ *
 * Reading state and thumbnails
 * ------------------------------------------------------------------ */

function normalizeReadingState(packId, state) {
  return {
    packId,
    lastOpenedAt: Number(state?.lastOpenedAt) || 0,
    pageIndex: Math.max(0, Number(state?.pageIndex) || 0),
    scroll: state?.scroll && typeof state.scroll === "object" ? state.scroll : {},
    opened: state?.opened && typeof state.opened === "object" ? state.opened : {},
  };
}

export function getReadingState(packId) {
  return runStoreRequest("reading", "readonly", (store) => store.get(packId))
    .then((state) => (state ? normalizeReadingState(packId, state) : null));
}

/**
 * Merge a change into a pack's reading state. `pageIndex` is where the reader is,
 * `scrollTop` is how far down that page, and both are kept per page so coming
 * back to any page of a save lands where it was left.
 */
export function putReadingState(packId, patch = {}) {
  return runTransaction(["reading"], "readwrite", (transaction) => {
    const store = transaction.objectStore("reading");
    store.get(packId).onsuccess = (event) => {
      const current = normalizeReadingState(packId, event.target.result);
      const pageIndex = Number.isInteger(patch.pageIndex) ? patch.pageIndex : current.pageIndex;
      const next = {
        ...current,
        pageIndex,
        lastOpenedAt: Number(patch.lastOpenedAt) || Date.now(),
        opened: { ...current.opened, [pageIndex]: true },
        scroll: { ...current.scroll },
      };
      if (Number.isFinite(Number(patch.scrollTop))) next.scroll[pageIndex] = Math.max(0, Math.round(Number(patch.scrollTop)));
      store.put(next);
    };
  });
}

/** Every pack's reading state, keyed by pack id. Small: one short row per pack ever opened. */
export function listReadingStates() {
  return runStoreRequest("reading", "readonly", (store) => store.getAll())
    .then((states) => Object.fromEntries((Array.isArray(states) ? states : [])
      .map((state) => [state.packId, normalizeReadingState(state.packId, state)])));
}

export function putThumbnail(id, dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return Promise.resolve();
  return runStoreRequest("thumbnails", "readwrite", (store) => store.put({ id, dataUrl, capturedAt: Date.now() }));
}

/** Thumbnails for the given pack ids, keyed by id; packs without one are absent. */
export function getThumbnails(ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
  return Promise.all(wanted.map((id) => runStoreRequest("thumbnails", "readonly", (store) => store.get(id))))
    .then((rows) => Object.fromEntries(rows.filter(Boolean).map((row) => [row.id, row.dataUrl])));
}

/* ------------------------------------------------------------------ *
 * Journeys and settings
 * ------------------------------------------------------------------ */

function journeySummary(journey) {
  const queueState = journeyQueueSummary(journey);
  return {
    id: journey.id,
    state: journey.state,
    rootUrl: journey.rootUrl,
    title: journey.title || journey.rootUrl,
    folderId: normalizeFolderId(journey.folderId),
    startedAt: journey.startedAt,
    updatedAt: journey.updatedAt,
    pageCount: queueState.pageCount,
    savedCount: queueState.savedCount,
    queuedCount: queueState.queuedCount,
    pendingCount: queueState.pendingCount,
    failedCount: queueState.failedCount,
    totalBytes: Number(journey.totalBytes) || 0,
    failed: Array.isArray(journey.failures) ? journey.failures.length : Number(journey.failed) || 0,
    message: journey.message || "",
    captureMedia: Boolean(journey.captureMedia),
    runScripts: Boolean(journey.runScripts),
    trackedTabIds: Array.isArray(journey.trackedTabIds) ? journey.trackedTabIds : [],
    pageTitles: queueState.pageTitles,
  };
}

export function putJourney(journey) {
  const normalizedJourney = {
    ...journey,
    folderId: normalizeFolderId(journey.folderId),
    updatedAt: Number(journey.updatedAt) || Date.now(),
  };
  return runStoreRequest("journeys", "readwrite", (store) => store.put(normalizedJourney));
}

export function getJourney(id) {
  return runStoreRequest("journeys", "readonly", (store) => store.get(id));
}

export function listJourneySummaries() {
  return runStoreRequest("journeys", "readonly", (store) => store.getAll())
    .then((journeys) => (Array.isArray(journeys) ? journeys : [])
      .map(journeySummary)
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)));
}

export function deleteJourney(id) {
  return runStoreRequest("journeys", "readwrite", (store) => store.delete(id));
}

export function getSetting(key, fallback) {
  return runStoreRequest("settings", "readonly", (store) => store.get(key))
    .then((setting) => setting ? setting.value : fallback);
}

export function setSetting(key, value) {
  return runStoreRequest("settings", "readwrite", (store) => store.put({ key, value }));
}

export function makePackId() {
  const suffix = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `pack_${Date.now()}_${suffix}`;
}

export function makeFolderId() {
  const suffix = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `folder_${Date.now()}_${suffix}`;
}

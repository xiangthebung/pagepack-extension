import { removePackPageFromPack } from "./pack-page.js";
import { journeyQueueSummary } from "./journey-queue.js";

const PAGEPACK_DB = "pagepack-db";
const PAGEPACK_DB_VERSION = 8;
const LEGACY_ROOT_FOLDER_ID = "unfiled";
export const DEFAULT_FOLDER_ID = null;

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

function orderedPackIdsFor(summaries, folderId) {
  const normalizedFolderId = normalizeFolderId(folderId);
  return summaries
    .filter((pack) => normalizeFolderId(pack.folderId) === normalizedFolderId)
    .sort((a, b) => packSortValue(a) - packSortValue(b) || Number(b.savedAt || 0) - Number(a.savedAt || 0))
    .map((pack) => pack.id);
}

function searchableText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100000);
}

function packSummary(pack) {
  return {
    id: pack.id,
    rootUrl: pack.rootUrl,
    title: pack.title || pack.rootUrl,
    savedAt: pack.savedAt,
    depth: pack.depth,
    captureMode: pack.captureMode || (pack.scope === "journey" ? "journey" : "page"),
    folderId: normalizeFolderId(pack.folderId),
    sortOrder: pack.sortOrder,
    stats: pack.stats || { pages: pack.pages?.length || 0, bytes: 0, resources: 0 },
    failures: Array.isArray(pack.failures) ? pack.failures.slice(0, 500) : [],
    pages: (pack.pages || []).map((page) => ({
      url: page.url,
      title: page.title,
      searchText: searchableText(page.html)
    }))
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
        packs.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          const pack = cursor.value;
          pack.folderId = normalizeFolderId(pack.folderId);
          if (packOrderById.has(pack.id)) pack.sortOrder = packOrderById.get(pack.id);
          cursor.update(pack);
          packIndex.put(packSummary(pack));
          for (const [pageIndex, page] of (pack.pages || []).entries()) {
            const url = canonicalUrl(page.url);
            urlIndex.put({
              key: `${url}|${pack.id}`,
              url,
              packId: pack.id,
              pageUrl: url,
              pageIndex,
              savedAt: pack.savedAt
            });
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
    for (const [pageIndex, page] of (normalizedPack.pages || []).entries()) {
      const url = canonicalUrl(page.url);
      urlIndex.put({
        key: `${url}|${normalizedPack.id}`,
        url,
        packId: normalizedPack.id,
        pageUrl: url,
        pageIndex,
        savedAt: normalizedPack.savedAt
      });
    }
  });
}

export function getPack(id) {
  return runStoreRequest("packs", "readonly", (store) => store.get(id));
}

export function listPacks() {
  return runStoreRequest("packIndex", "readonly", (store) => store.getAll())
    .then((packs) => (Array.isArray(packs) ? packs : []).sort((a, b) => b.savedAt - a.savedAt));
}

export function deletePack(id) {
  return getPack(id).then((pack) => runTransaction(["packs", "packIndex", "urlIndex"], "readwrite", (transaction) => {
    transaction.objectStore("packs").delete(id);
    transaction.objectStore("packIndex").delete(id);
    for (const page of pack?.pages || []) {
      transaction.objectStore("urlIndex").delete(`${canonicalUrl(page.url)}|${id}`);
    }
  }));
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
        const url = canonicalUrl(page.url);
        urlIndex.put({
          key: `${url}|${id}`,
          url,
          packId: id,
          pageUrl: url,
          pageIndex,
          savedAt: normalizedPack.savedAt,
        });
      }
    }).then(() => normalizedPack);
  });
}

export function findSavedUrl(value) {
  const url = canonicalUrl(value);
  return runStoreRequest("urlIndex", "readonly", (store) => store.index("byUrl").getAll(url))
    .then((matches) => matches.sort((a, b) => b.savedAt - a.savedAt)[0] || null);
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

export function movePack(id, folderId) {
  const targetFolderId = normalizeFolderId(folderId);
  return listPacks().then((summaries) => {
    const sourceSummary = summaries.find((pack) => pack.id === id);
    if (!sourceSummary) throw new Error("Saved pack not found.");
    const sourceFolderId = normalizeFolderId(sourceSummary.folderId);
    if (sourceFolderId === targetFolderId) return;

    const targetIds = [id, ...orderedPackIdsFor(summaries, targetFolderId).filter((packId) => packId !== id)];
    const sourceIds = orderedPackIdsFor(summaries, sourceFolderId).filter((packId) => packId !== id);
    const affectedIds = [...new Set([...targetIds, ...sourceIds])];
    return Promise.all(affectedIds.map((packId) => getPack(packId))).then((packs) => {
      const packsById = new Map(packs.filter(Boolean).map((pack) => [pack.id, pack]));
      if (!packsById.has(id)) throw new Error("Saved pack not found.");
      const targetOrder = new Map(targetIds.map((packId, index) => [packId, index]));
      const sourceOrder = new Map(sourceIds.map((packId, index) => [packId, index]));
      return runTransaction(["packs", "packIndex"], "readwrite", (transaction) => {
        const packStore = transaction.objectStore("packs");
        const packIndexStore = transaction.objectStore("packIndex");
        affectedIds.forEach((packId) => {
          const pack = packsById.get(packId);
          if (!pack) return;
          const updatedPack = targetOrder.has(packId)
            ? { ...pack, folderId: targetFolderId, sortOrder: targetOrder.get(packId) }
            : { ...pack, folderId: sourceFolderId, sortOrder: sourceOrder.get(packId) };
          packStore.put(updatedPack);
          packIndexStore.put(packSummary(updatedPack));
        });
      });
    });
  });
}

export function moveAndReorderPack(id, folderId, orderedIds) {
  const targetFolderId = normalizeFolderId(folderId);
  return listPacks().then((summaries) => {
    const sourceSummary = summaries.find((pack) => pack.id === id);
    if (!sourceSummary) throw new Error("Saved pack not found.");
    const sourceFolderId = normalizeFolderId(sourceSummary.folderId);
    const targetExistingIds = orderedPackIdsFor(summaries, targetFolderId);
    if (!targetExistingIds.includes(id)) targetExistingIds.unshift(id);
    const requestedIds = Array.isArray(orderedIds) && orderedIds.includes(id)
      ? orderedIds
      : [id, ...(Array.isArray(orderedIds) ? orderedIds : [])];
    const targetIds = completeKnownOrder(requestedIds, targetExistingIds);
    const sourceIds = sourceFolderId === targetFolderId
      ? []
      : orderedPackIdsFor(summaries, sourceFolderId).filter((packId) => packId !== id);
    const affectedIds = [...new Set([...targetIds, ...sourceIds])];

    return Promise.all(affectedIds.map((packId) => getPack(packId))).then((packs) => {
      const packsById = new Map(packs.filter(Boolean).map((pack) => [pack.id, pack]));
      if (!packsById.has(id)) throw new Error("Saved pack not found.");
      const targetOrder = new Map(targetIds.map((packId, index) => [packId, index]));
      const sourceOrder = new Map(sourceIds.map((packId, index) => [packId, index]));
      return runTransaction(["packs", "packIndex"], "readwrite", (transaction) => {
        const packStore = transaction.objectStore("packs");
        const packIndexStore = transaction.objectStore("packIndex");
        affectedIds.forEach((packId) => {
          const pack = packsById.get(packId);
          if (!pack) return;
          const updatedPack = targetOrder.has(packId)
            ? { ...pack, folderId: targetFolderId, sortOrder: targetOrder.get(packId) }
            : { ...pack, folderId: sourceFolderId, sortOrder: sourceOrder.get(packId) };
          packStore.put(updatedPack);
          packIndexStore.put(packSummary(updatedPack));
        });
      });
    });
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

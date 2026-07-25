import { removePackPageFromPack } from "./pack-page.js";
import { DEFAULT_PACK_LIMITS, normalizePackLimits } from "./monetization.js";

const $ = (selector) => document.querySelector(selector);
const ROOT_DIRECTORY = "__root__";
const ACTIVE_CAPTURE_STATES = new Set(["queued", "reading", "saving", "finishing"]);

let activeTab = null;
let allPacks = [];
let folders = [];
let captures = [];
let journeys = [];
let monetizationState = null;
let currentFolderId = ROOT_DIRECTORY;
let proOverlayRestoreFocus = null;
let issuesOverlayRestoreFocus = null;
let issueReportPack = null;
let journeyReviewRestoreFocus = null;
let journeyReviewId = null;
let journeySaveInFlight = false;
let ignoreAllArmed = false;
let ignoreAllTimer = null;
const expandedPackIds = new Set();
let pendingDeleteAction = null;
let pendingDeleteTimer = null;
let discardJourneyId = null;
let discardJourneyArmed = false;
let cancelInFlightRequestId = null;
let dragSession = null;
let dropTargetEntry = null;
let autoScrollFrame = 0;
const reorderAnimations = new Map();
let libraryMutationInFlight = false;
let captureMode = "page";
let capturePreferencesReady = false;
let capturePreferencesWrite = Promise.resolve();

const DRAG_START_DISTANCE = 5;
const AUTO_SCROLL_EDGE = 56;
const AUTO_SCROLL_MAX_SPEED = 14;

const MOVEABLE_ADAPTERS = Object.freeze({
  pack: {
    label: "website",
    selector: '.library-item[data-item-kind="pack"]',
    canDropIntoFolder: true,
    readOrder() {
      return [...$("#library-list").querySelectorAll(this.selector)].map((entry) => entry.dataset.itemId);
    },
    applyLocalOrder(orderedIds) {
      const folderId = currentFolderId === ROOT_DIRECTORY ? null : folderById(currentFolderId).id;
      const indexById = new Map(orderedIds.map((id, index) => [id, index]));
      allPacks = allPacks.map((pack) => indexById.has(pack.id)
        ? { ...pack, folderId, sortOrder: indexById.get(pack.id) }
        : pack);
    },
    persist(sourceId, orderedIds) {
      const folderId = currentFolderId === ROOT_DIRECTORY ? null : folderById(currentFolderId).id;
      return sendMessage({ type: "MOVE_AND_REORDER_PACK", id: sourceId, folderId, orderedIds });
    },
    moveIntoFolder(sourceId, folderId) {
      return movePackToFolder(sourceId, folderId);
    },
  },
  folder: {
    label: "folder",
    selector: '.library-item[data-item-kind="folder"]',
    canDropIntoFolder: false,
    readOrder() {
      return [...$("#library-list").querySelectorAll(this.selector)].map((entry) => entry.dataset.itemId);
    },
    applyLocalOrder(orderedIds) {
      const indexById = new Map(orderedIds.map((id, index) => [id, index]));
      folders = folders.map((folder) => indexById.has(folder.id)
        ? { ...folder, sortOrder: indexById.get(folder.id) }
        : folder);
    },
    persist(sourceId, orderedIds) {
      return sendMessage({ type: "REORDER_FOLDERS", folderIds: orderedIds });
    },
  },
});

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response || {});
    });
  });
}

function setButtonBusy(button, busy) {
  if (!button) return;
  button.classList.toggle("is-loading", Boolean(busy));
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

function formatBytes(bytes) {
  const amount = Number(bytes || 0);
  if (amount < 1024) return `${amount} B`;
  if (amount < 1024 * 1024) return `${(amount / 1024).toFixed(1)} KB`;
  if (amount < 1024 * 1024 * 1024) return `${(amount / (1024 * 1024)).toFixed(1)} MB`;
  return `${(amount / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(value);
  } catch {
    return "";
  }
}

function setStatus(message, isError = false) {
  const node = $("#save-status");
  node.textContent = message || "";
  node.classList.toggle("is-error", isError);
}

function scrollToSaveNote() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const scroller = document.scrollingElement || document.documentElement;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }));
}

function setProStatus(message, isError = false) {
  const node = $("#pro-status");
  node.textContent = message || "";
  node.classList.toggle("is-error", isError);
}

function folderById(id) {
  return folders.find((folder) => folder.id === id) || { id: "", name: "—", libraryRoot: true };
}

function packFolder(pack) {
  return folderById(pack.folderId);
}

function folderDisplayName(folder) {
  return folder.libraryRoot ? "Library" : folder.name;
}

function capturePreferencesSnapshot() {
  const depthOutput = $("#depth-value");
  const packLimits = normalizePackLimits({
    maxPages: $("#max-pages-per-pack")?.value,
    maxTotalBytes: $("#max-bytes-per-pack")?.value,
  });
  return {
    depth: Math.max(0, Math.min(5, Number(depthOutput?.value || depthOutput?.textContent || 0))),
    runScripts: Boolean($("#run-scripts")?.checked),
    captureMode,
    folderId: $("#save-folder")?.value || null,
    ...packLimits,
  };
}

function persistCapturePreferences() {
  if (!capturePreferencesReady) return;
  const preferences = capturePreferencesSnapshot();
  capturePreferencesWrite = capturePreferencesWrite
    .catch(() => {})
    .then(() => sendMessage({ type: "SET_CAPTURE_PREFERENCES", preferences }))
    .catch(() => {});
}

async function loadCapturePreferences() {
  try {
    const response = await sendMessage({ type: "GET_CAPTURE_PREFERENCES" });
    const preferences = response.preferences || {};
    const depth = Math.max(0, Math.min(5, Number(preferences.depth) || 0));
    const depthOutput = $("#depth-value");
    depthOutput.value = String(depth);
    depthOutput.textContent = String(depth);
    $("#run-scripts").checked = preferences.runScripts !== false;
    $("#save-folder").value = typeof preferences.folderId === "string" ? preferences.folderId : "";
    const packLimits = normalizePackLimits(preferences);
    $("#max-pages-per-pack").value = String(packLimits.maxPages || DEFAULT_PACK_LIMITS.maxPages);
    $("#max-bytes-per-pack").value = String(packLimits.maxTotalBytes || DEFAULT_PACK_LIMITS.maxTotalBytes);
    setCaptureMode(preferences.captureMode === "journey" ? "journey" : "page");
  } catch {
    setCaptureMode(captureMode);
  } finally {
    capturePreferencesReady = true;
  }
}

function sortedFolders() {
  return [...folders].sort((a, b) => {
    const aOrder = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number(a.createdAt || 0);
    const bOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number(b.createdAt || 0);
    return aOrder - bOrder || a.name.localeCompare(b.name);
  });
}

function setSelectedFolder(id, closeMenu = true) {
  const input = $("#save-folder");
  const folder = folderById(id);
  input.value = folder.id || "";
  $("#save-folder-label").textContent = folderDisplayName(folder);
  document.querySelectorAll(".folder-option").forEach((option) => {
    const isSelected = option.dataset.folderId === (folder.id || "");
    option.classList.toggle("is-selected", isSelected);
    option.setAttribute("aria-selected", String(isSelected));
  });
  if (closeMenu) closeFolderMenu();
  persistCapturePreferences();
}

function closeFolderMenu() {
  const trigger = $("#save-folder-trigger");
  const menu = $("#save-folder-menu");
  menu.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
}

function toggleFolderMenu(force) {
  const trigger = $("#save-folder-trigger");
  const menu = $("#save-folder-menu");
  const open = typeof force === "boolean" ? force : menu.hidden;
  menu.hidden = !open;
  trigger.setAttribute("aria-expanded", String(open));
  if (open) menu.querySelector(".folder-option.is-selected")?.focus();
}

function renderFolders() {
  const input = $("#save-folder");
  const menu = $("#save-folder-menu");
  const selected = input.value;
  const root = { id: "", name: "—", libraryRoot: true };
  const available = [root, ...sortedFolders()];
  menu.replaceChildren(...available.map((folder) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "folder-option";
    option.dataset.folderId = folder.id || "";
    option.setAttribute("role", "option");
    const name = document.createElement("span");
    name.className = "folder-option-name";
    name.textContent = folderDisplayName(folder);
    const check = document.createElement("span");
    check.className = "folder-option-check";
    check.textContent = "✓";
    option.append(name, check);
    return option;
  }));
  const nextSelected = available.some((folder) => (folder.id || "") === selected) ? selected : "";
  setSelectedFolder(nextSelected, false);
}

function textNode(value, className) {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = value || "";
  return node;
}

function makeEntry({ icon, title, meta, action, actionLabel, detailsAction, detailsLabel, detailsText, secondaryAction, secondaryLabel }) {
  const entry = document.createElement("article");
  entry.className = "library-entry";
  entry.dataset.action = action;
  entry.setAttribute("role", "button");
  entry.setAttribute("aria-label", actionLabel);
  entry.tabIndex = 0;

  const iconNode = makeLibraryIcon(icon);
  if (icon === "journey") iconNode.title = "Journey capture";
  else if (icon === "page") iconNode.title = "Page capture";
  const copy = document.createElement("div");
  copy.className = "entry-copy";
  copy.append(textNode(title, "entry-title"), textNode(meta, "entry-meta"));
  const actions = document.createElement("div");
  actions.className = "entry-actions";

  if (detailsAction) {
    const details = document.createElement("button");
    details.type = "button";
    details.dataset.action = detailsAction;
    details.className = "issue-details-button";
    details.setAttribute("aria-label", detailsLabel || "View save errors");
    details.title = detailsLabel || "View save errors";
    details.textContent = detailsText || "View";
    actions.append(details);
  }

  if (secondaryAction) {
    const isPending = pendingDeleteAction === secondaryAction;
    entry.classList.toggle("is-delete-confirming", isPending);
    if (isPending) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.dataset.action = `cancel:${secondaryAction}`;
      cancel.className = "delete-button delete-cancel";
      cancel.setAttribute("aria-label", "Cancel delete");
      cancel.title = "Cancel";
      cancel.textContent = "Cancel";

      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.dataset.action = secondaryAction;
      confirm.className = "delete-button is-confirming";
      confirm.setAttribute("aria-label", secondaryLabel);
      confirm.title = secondaryLabel;
      confirm.textContent = "Delete";
      actions.append(confirm, cancel);
    } else {
      const secondary = document.createElement("button");
      secondary.type = "button";
      secondary.dataset.action = secondaryAction;
      secondary.className = "delete-button";
      secondary.setAttribute("aria-label", secondaryLabel);
      secondary.title = secondaryLabel;
      secondary.append(makeTrashIcon());
      actions.append(secondary);
    }
  }
  entry.append(iconNode, copy, actions);
  entry.addEventListener("keydown", (event) => {
    if (event.target !== entry || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    handleLibraryAction(action).catch((error) => setStatus(error.message, true));
  });
  return entry;
}

function makeLibraryIcon(kind) {
  const node = document.createElement("div");
  node.className = "entry-icon";
  node.setAttribute("aria-hidden", "true");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  const artwork = {
    page: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/>',
    journey: '<circle cx="6" cy="17.5" r="2"/><circle cx="12" cy="11.5" r="2"/><circle cx="18" cy="5.5" r="2"/><path d="m7.5 16 3-3m3-3 3-3"/>',
    folder: '<path d="M3.5 7.5h7l2-2h8v14h-17z"/>',
    back: '<path d="M10 6 4 12l6 6M5 12h14"/>',
  };
  icon.innerHTML = artwork[kind] || artwork.page;
  node.append(icon);
  return node;
}

function makeTrashIcon() {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = "<path d=\"M4 7h16M10 4h4M7 7h10l-1 13H8L7 7ZM10 11v5M14 11v5\"/>";
  return icon;
}

function searchValue() {
  return $("#library-search").value.trim().toLowerCase();
}

function matchesPack(pack, query) {
  if (!query) return true;
  const values = [pack.title, pack.rootUrl, packFolder(pack).name];
  (pack.pages || []).forEach((page) => values.push(page.title, page.url, page.searchText));
  return values.some((value) => String(value || "").toLowerCase().includes(query));
}

function resetDeleteConfirmation() {
  pendingDeleteAction = null;
  clearTimeout(pendingDeleteTimer);
  pendingDeleteTimer = null;
}

function armDeleteConfirmation(action) {
  pendingDeleteAction = action;
  clearTimeout(pendingDeleteTimer);
  pendingDeleteTimer = setTimeout(() => {
    resetDeleteConfirmation();
    renderLibrary();
  }, 5000);
}

function setEmpty(visible, title, help) {
  $("#library-empty").hidden = !visible;
  $("#empty-title").textContent = title;
  $("#empty-help").textContent = help;
}

function packMeta(pack) {
  const stats = pack.stats || {};
  return `${formatBytes(stats.bytes)} · ${formatDate(pack.savedAt)}`;
}

function sortedPacksFor(folderId) {
  return allPacks
    .filter((pack) => (pack.folderId || null) === (folderId || null))
    .sort((a, b) => {
      const aOrder = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
      const bOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder || Number(b.savedAt || 0) - Number(a.savedAt || 0);
    });
}

function appendLibraryEntry(list, item, allowReorder = true) {
  const moveable = MOVEABLE_ADAPTERS[item.kind];
  const entry = makeEntry(item);
  const handle = document.createElement(allowReorder ? "button" : "span");
  handle.className = "entry-handle";
  if (allowReorder) {
    handle.type = "button";
    handle.dataset.reorderEnabled = "true";
    handle.title = "Drag to reorder, or press Space and use the arrow keys";
    handle.setAttribute("aria-label", `Reorder ${moveable?.label || item.kind}: ${item.title}`);
    handle.setAttribute("aria-keyshortcuts", "Space ArrowUp ArrowDown Home End Escape");
  } else {
    handle.title = "Clear search to reorder";
    handle.setAttribute("aria-hidden", "true");
  }
  entry.prepend(handle);
  entry.classList.add("library-item", "moveable", `${item.kind}-entry`);
  entry.dataset.itemKind = item.kind;
  entry.dataset.itemId = item.id;
  list.append(entry);
  return entry;
}

function appendPackEntry(list, pack, allowReorder = true) {
  const issueCount = Number(pack.stats?.failed || pack.failures?.length || 0);
  const pageCount = pack.pages?.length || 0;
  const expanded = expandedPackIds.has(pack.id);
  const deleting = pendingDeleteAction === `delete-pack:${pack.id}`;
  const entry = appendLibraryEntry(list, {
    kind: "pack",
    id: pack.id,
    icon: pack.captureMode === "journey" ? "journey" : "page",
    title: pack.title || pack.rootUrl,
    meta: packMeta(pack),
    action: `open-pack:${pack.id}`,
    actionLabel: "Open saved page",
    detailsAction: issueCount ? `show-issues:${pack.id}` : null,
    detailsLabel: issueCount ? `Errors: ${issueCount}` : "",
    detailsText: issueCount ? "Errors" : "",
    secondaryAction: `delete-pack:${pack.id}`,
    secondaryLabel: "Delete saved page",
  }, allowReorder);
  const expandButton = document.createElement("button");
  expandButton.type = "button";
  expandButton.className = "pack-expand-button";
  expandButton.dataset.action = `toggle-pack-pages:${pack.id}`;
  expandButton.setAttribute("aria-controls", `pack-pages-${pack.id}`);
  expandButton.setAttribute("aria-expanded", String(expanded));
  expandButton.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} ${pageCount} captured ${pageCount === 1 ? "page" : "pages"}`);
  expandButton.title = expanded ? "Hide captured pages" : "Show captured pages";
  expandButton.textContent = expanded ? "Hide" : `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
  entry.classList.toggle("is-delete-mode", deleting);
  entry.classList.toggle("is-expanded", expanded && !deleting);
  if (!deleting) {
    entry.querySelector(".entry-actions")?.prepend(expandButton);
    if (expanded) appendCapturedPages(entry, pack);
  }
}

function appendCapturedPages(entry, pack) {
  const panel = document.createElement("div");
  panel.className = "pack-pages-panel";
  panel.id = `pack-pages-${pack.id}`;
  const heading = document.createElement("div");
  heading.className = "pack-pages-heading";
  heading.textContent = `${pack.pages?.length || 0} captured ${(pack.pages?.length || 0) === 1 ? "page" : "pages"}`;
  panel.append(heading);
  (pack.pages || []).forEach((page, index) => {
    const button = document.createElement("div");
    button.className = "pack-page-row";
    button.dataset.action = `open-pack-page:${pack.id}:${index}`;
    button.setAttribute("role", "button");
    button.tabIndex = 0;
    button.title = page.title || page.url || "Open captured page";
    const number = document.createElement("span");
    number.className = "pack-page-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("span");
    copy.className = "pack-page-copy";
    const title = document.createElement("strong");
    title.textContent = page.title || page.url || "Captured page";
    const url = document.createElement("span");
    url.textContent = shortLibraryUrl(page.url);
    copy.append(title, url);
    button.append(number, copy);
    if (index > 0) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pack-page-remove";
      remove.dataset.action = `remove-pack-page:${pack.id}:${index}`;
      remove.setAttribute("aria-label", `Remove ${page.title || page.url || "captured page"}`);
      remove.title = "Remove captured page";
      remove.textContent = "×";
      button.append(remove);
    }
    button.addEventListener("keydown", (event) => {
      if (event.target !== button || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      openViewer(pack.id, index);
    });
    panel.append(button);
  });
  entry.append(panel);
}

function shortLibraryUrl(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}${url.search}`.replace(/\/$/, "") || url.hostname;
  } catch {
    return String(value || "");
  }
}

function appendFolderEntry(list, folder, allowReorder = true) {
  const count = allPacks.filter((pack) => pack.folderId === folder.id).length;
  appendLibraryEntry(list, {
    kind: "folder",
    id: folder.id,
    icon: "folder",
    title: folderDisplayName(folder),
    meta: count ? `${count} saved ${count === 1 ? "page" : "pages"}` : "Empty",
    action: `open-folder:${folder.id}`,
    actionLabel: "Open folder",
    secondaryAction: `delete-folder:${folder.id}`,
    secondaryLabel: "Delete folder and contents",
  }, allowReorder);
}

function appendParentFolderEntry(list) {
  appendLibraryEntry(list, {
    kind: "folder",
    id: "",
    icon: "back",
    title: "..",
    meta: "Back to Saved pages",
    action: "go-root",
    actionLabel: "Back to Saved pages",
  }, false);
  list.lastElementChild.classList.add("parent-folder-entry", "no-reorder-handle");
}

function clearDropTarget() {
  dropTargetEntry?.classList.remove("is-drop-target");
  dropTargetEntry = null;
}

function announceReorder(message) {
  const status = $("#reorder-status");
  if (!status) return;
  status.textContent = "";
  requestAnimationFrame(() => { status.textContent = message || ""; });
}

function reportLibraryMutationError(error) {
  const message = error?.message || "The library could not be updated.";
  $("#header-status").textContent = "Couldn’t update";
  announceReorder(message);
  setStatus(message, true);
}

function setFolderDropTarget(entry) {
  if (dropTargetEntry === entry) return;
  clearDropTarget();
  if (!entry) return;
  entry.classList.add("is-drop-target");
  dropTargetEntry = entry;
}

function cancelReorderAnimations() {
  reorderAnimations.forEach((animation) => animation.cancel());
  reorderAnimations.clear();
}

function animateListMutation(move) {
  const entries = [...$("#library-list").querySelectorAll(".library-item")];
  const before = new Map(entries.map((entry) => [entry, entry.getBoundingClientRect()]));
  cancelReorderAnimations();
  move();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  entries.forEach((entry) => {
    if (!entry.isConnected || typeof entry.animate !== "function") return;
    const from = before.get(entry);
    const to = entry.getBoundingClientRect();
    const deltaX = from.left - to.left;
    const deltaY = from.top - to.top;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
    const animation = entry.animate([
      { transform: `translate(${deltaX}px, ${deltaY}px)` },
      { transform: "translate(0, 0)" },
    ], { duration: 140, easing: "cubic-bezier(.2,.8,.2,1)" });
    reorderAnimations.set(entry, animation);
    animation.onfinish = animation.oncancel = () => {
      if (reorderAnimations.get(entry) === animation) reorderAnimations.delete(entry);
    };
  });
}

function insertNodeBefore(list, node, reference) {
  const alreadyThere = reference ? node.nextElementSibling === reference : node === list.lastElementChild;
  if (alreadyThere) return;
  animateListMutation(() => list.insertBefore(node, reference));
}

function itemName(entry) {
  return entry.querySelector(".entry-title")?.textContent || "Item";
}

function sameOrder(first, second) {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

function orderedIdsFromEntries(entries, kind) {
  return entries
    .filter((entry) => entry.dataset.itemKind === kind)
    .map((entry) => entry.dataset.itemId);
}

function positionGhost(session) {
  const left = session.lastX - session.offsetX;
  const top = session.lastY - session.offsetY;
  session.sourceEntry.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

function placePlaceholderAtPointer(session) {
  const list = $("#library-list");
  const moveable = MOVEABLE_ADAPTERS[session.sourceItem.kind];
  const siblings = [...list.querySelectorAll(moveable.selector)];
  const target = siblings.find((entry) => {
    const rect = entry.getBoundingClientRect();
    return session.lastY < rect.top + rect.height / 2;
  });
  const reference = target || (session.sourceItem.kind === "pack"
    ? list.querySelector('.library-item[data-item-kind="folder"]:not(.parent-folder-entry)')
    : null);
  insertNodeBefore(list, session.placeholder, reference);
}

function pointerEntryAt(x, y) {
  const element = document.elementFromPoint(x, y);
  const entry = element?.closest?.(".library-item");
  return entry && $("#library-list").contains(entry) ? entry : null;
}

function updatePointerDropTarget(session) {
  const list = $("#library-list");
  const targetEntry = pointerEntryAt(session.lastX, session.lastY);
  const targetKind = targetEntry?.dataset.itemKind;
  if (session.sourceItem.kind === "pack" && targetKind === "folder") {
    setFolderDropTarget(targetEntry);
    session.folderTarget = targetEntry;
    session.validDrop = true;
    session.sourceEntry.classList.remove("is-invalid-drop");
    if (session.lastAnnouncedTarget !== targetEntry.dataset.itemId) {
      session.lastAnnouncedTarget = targetEntry.dataset.itemId;
      announceReorder(`Move into ${itemName(targetEntry)}`);
    }
    return;
  }

  setFolderDropTarget(null);
  session.folderTarget = null;
  session.lastAnnouncedTarget = null;
  const rect = list.getBoundingClientRect();
  const insideList = session.lastX >= rect.left - 12
    && session.lastX <= rect.right + 12
    && session.lastY >= rect.top - 20
    && session.lastY <= rect.bottom + 20;
  const overIncompatibleItem = targetEntry && targetKind !== session.sourceItem.kind;
  session.validDrop = insideList && !overIncompatibleItem;
  session.sourceEntry.classList.toggle("is-invalid-drop", !session.validDrop);
  if (session.validDrop) placePlaceholderAtPointer(session);
}

function scrollSpeedAt(clientY) {
  if (clientY < AUTO_SCROLL_EDGE) {
    return -AUTO_SCROLL_MAX_SPEED * (1 - Math.max(0, clientY) / AUTO_SCROLL_EDGE);
  }
  if (clientY > window.innerHeight - AUTO_SCROLL_EDGE) {
    return AUTO_SCROLL_MAX_SPEED * (1 - Math.max(0, window.innerHeight - clientY) / AUTO_SCROLL_EDGE);
  }
  return 0;
}

function stopAutoScroll() {
  if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
  autoScrollFrame = 0;
}

function continueAutoScroll() {
  if (autoScrollFrame || dragSession?.mode !== "pointer" || dragSession.phase !== "active") return;
  const tick = () => {
    autoScrollFrame = 0;
    const session = dragSession;
    if (!session || session.mode !== "pointer" || session.phase !== "active") return;
    const speed = scrollSpeedAt(session.lastY);
    if (!speed) return;
    window.scrollBy(0, speed);
    updatePointerDropTarget(session);
    autoScrollFrame = requestAnimationFrame(tick);
  };
  if (scrollSpeedAt(dragSession.lastY)) autoScrollFrame = requestAnimationFrame(tick);
}

function beginPointerDrag(session) {
  const rect = session.sourceEntry.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = `library-entry reorder-placeholder ${session.sourceItem.kind}-entry`;
  placeholder.style.height = `${rect.height}px`;
  placeholder.setAttribute("aria-hidden", "true");
  session.placeholder = placeholder;
  session.offsetX = session.startX - rect.left;
  session.offsetY = session.startY - rect.top;
  session.phase = "active";
  session.validDrop = true;
  session.sourceEntry.replaceWith(placeholder);
  document.body.append(session.sourceEntry);
  session.sourceEntry.classList.add("is-dragging", "drag-ghost");
  session.sourceEntry.style.width = `${rect.width}px`;
  session.sourceEntry.style.height = `${rect.height}px`;
  session.sourceEntry.setAttribute("aria-grabbed", "true");
  document.body.classList.add("is-reordering");
  positionGhost(session);
  updatePointerDropTarget(session);
  announceReorder(`Moving ${itemName(session.sourceEntry)}`);
}

function releasePointer(session) {
  try {
    if (session.handle.hasPointerCapture?.(session.pointerId)) session.handle.releasePointerCapture(session.pointerId);
  } catch {
    // The browser can release capture first when the pointer leaves the popup.
  }
}

function resetPointerVisuals(session, restoreOrder) {
  stopAutoScroll();
  cancelReorderAnimations();
  setFolderDropTarget(null);
  session.sourceEntry.classList.remove("is-dragging", "drag-ghost", "is-invalid-drop");
  session.sourceEntry.removeAttribute("aria-grabbed");
  session.sourceEntry.style.removeProperty("width");
  session.sourceEntry.style.removeProperty("height");
  session.sourceEntry.style.removeProperty("transform");
  if (session.placeholder?.isConnected) session.placeholder.replaceWith(session.sourceEntry);
  if (restoreOrder) session.startOrder.forEach((entry) => $("#library-list").append(entry));
  document.body.classList.remove("is-reordering");
  releasePointer(session);
}

function cancelPointerDrag(message = "Reorder cancelled") {
  const session = dragSession;
  if (!session || session.mode !== "pointer") return;
  dragSession = null;
  if (session.phase === "active") resetPointerVisuals(session, true);
  else releasePointer(session);
  announceReorder(message);
}

function finishPointerDrag() {
  const session = dragSession;
  if (!session || session.mode !== "pointer") return;
  if (session.phase !== "active") {
    dragSession = null;
    releasePointer(session);
    return;
  }
  if (!session.validDrop) {
    cancelPointerDrag();
    return;
  }

  const folderId = session.folderTarget?.dataset.itemId || null;
  const sourceItem = session.sourceItem;
  dragSession = null;
  resetPointerVisuals(session, false);
  if (folderId) {
    announceReorder(`Moved ${itemName(session.sourceEntry)} into ${itemName(session.folderTarget)}`);
    MOVEABLE_ADAPTERS.pack.moveIntoFolder(sourceItem.id, folderId)
      .catch(reportLibraryMutationError);
    return;
  }

  const moveable = MOVEABLE_ADAPTERS[sourceItem.kind];
  const orderedIds = moveable.readOrder();
  const originalIds = orderedIdsFromEntries(session.startOrder, sourceItem.kind);
  if (sameOrder(orderedIds, originalIds)) {
    announceReorder("Order unchanged");
    return;
  }
  announceReorder(`${itemName(session.sourceEntry)} reordered`);
  persistMoveableOrder(sourceItem, orderedIds).catch(reportLibraryMutationError);
}

function handleReorderPointerDown(event) {
  const handle = event.target.closest('.entry-handle[data-reorder-enabled="true"]');
  if (!handle || libraryMutationInFlight || event.button !== 0 || event.isPrimary === false) return;
  if (dragSession?.mode === "keyboard") cancelKeyboardDrag();
  if (dragSession) return;
  const sourceEntry = handle.closest(".library-item");
  dragSession = {
    mode: "pointer",
    phase: "pending",
    pointerId: event.pointerId,
    handle,
    sourceEntry,
    sourceItem: { kind: sourceEntry.dataset.itemKind, id: sourceEntry.dataset.itemId },
    startOrder: [...$("#library-list").querySelectorAll(".library-item")],
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
  };
  try { handle.setPointerCapture(event.pointerId); } catch {}
  event.preventDefault();
}

function handleReorderPointerMove(event) {
  const session = dragSession;
  if (!session || session.mode !== "pointer" || event.pointerId !== session.pointerId) return;
  session.lastX = event.clientX;
  session.lastY = event.clientY;
  if (session.phase === "pending") {
    const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (distance < DRAG_START_DISTANCE) return;
    beginPointerDrag(session);
  } else {
    positionGhost(session);
    updatePointerDropTarget(session);
  }
  continueAutoScroll();
  event.preventDefault();
}

function handleReorderPointerUp(event) {
  const session = dragSession;
  if (!session || session.mode !== "pointer" || event.pointerId !== session.pointerId) return;
  session.lastX = event.clientX;
  session.lastY = event.clientY;
  if (session.phase === "active") updatePointerDropTarget(session);
  finishPointerDrag();
  event.preventDefault();
}

function handleReorderPointerCancel(event) {
  if (dragSession?.mode === "pointer" && event.pointerId === dragSession.pointerId) cancelPointerDrag();
}

function keyboardPositionMessage(session) {
  const entries = [...$("#library-list").querySelectorAll(MOVEABLE_ADAPTERS[session.sourceItem.kind].selector)];
  return `${itemName(session.sourceEntry)}, position ${entries.indexOf(session.sourceEntry) + 1} of ${entries.length}`;
}

function startKeyboardDrag(handle) {
  const sourceEntry = handle.closest(".library-item");
  dragSession = {
    mode: "keyboard",
    handle,
    sourceEntry,
    sourceItem: { kind: sourceEntry.dataset.itemKind, id: sourceEntry.dataset.itemId },
    startOrder: [...$("#library-list").querySelectorAll(".library-item")],
  };
  sourceEntry.classList.add("is-dragging");
  handle.setAttribute("aria-pressed", "true");
  $("#header-status").textContent = "Reordering";
  announceReorder(`Picked up ${keyboardPositionMessage(dragSession)}. Use arrow keys to move, Space to save, or Escape to cancel.`);
}

function moveKeyboardDrag(key) {
  const session = dragSession;
  const list = $("#library-list");
  const entries = [...list.querySelectorAll(MOVEABLE_ADAPTERS[session.sourceItem.kind].selector)];
  const index = entries.indexOf(session.sourceEntry);
  let reference;
  if (key === "ArrowUp" && index > 0) reference = entries[index - 1];
  else if (key === "ArrowDown" && index < entries.length - 1) reference = entries[index + 1].nextElementSibling;
  else if (key === "Home" && index > 0) reference = entries[0];
  else if (key === "End" && index < entries.length - 1) reference = entries.at(-1).nextElementSibling;
  else return;
  insertNodeBefore(list, session.sourceEntry, reference || null);
  announceReorder(keyboardPositionMessage(session));
}

function clearKeyboardVisuals(session) {
  session.sourceEntry.classList.remove("is-dragging");
  session.handle.removeAttribute("aria-pressed");
}

function focusReorderHandle(itemId) {
  requestAnimationFrame(() => {
    $("#library-list").querySelector(`.library-item[data-item-id="${CSS.escape(itemId)}"] .entry-handle`)?.focus();
  });
}

function commitKeyboardDrag() {
  const session = dragSession;
  if (!session || session.mode !== "keyboard") return;
  const moveable = MOVEABLE_ADAPTERS[session.sourceItem.kind];
  const orderedIds = moveable.readOrder();
  const originalIds = orderedIdsFromEntries(session.startOrder, session.sourceItem.kind);
  dragSession = null;
  clearKeyboardVisuals(session);
  if (sameOrder(orderedIds, originalIds)) {
    $("#header-status").textContent = "Ready";
    announceReorder("Order unchanged");
    return;
  }
  announceReorder(`${itemName(session.sourceEntry)} reordered`);
  persistMoveableOrder(session.sourceItem, orderedIds, true).catch(reportLibraryMutationError);
}

function cancelKeyboardDrag() {
  const session = dragSession;
  if (!session || session.mode !== "keyboard") return;
  dragSession = null;
  animateListMutation(() => session.startOrder.forEach((entry) => $("#library-list").append(entry)));
  clearKeyboardVisuals(session);
  $("#header-status").textContent = "Ready";
  announceReorder("Reorder cancelled");
  session.handle.focus();
}

function handleReorderKeyDown(event) {
  const handle = event.target.closest('.entry-handle[data-reorder-enabled="true"]');
  if (!handle) return;
  const activeKeyboardDrag = dragSession?.mode === "keyboard" && dragSession.handle === handle;
  if (!activeKeyboardDrag && [" ", "Enter"].includes(event.key)) {
    if (libraryMutationInFlight || dragSession) return;
    event.preventDefault();
    startKeyboardDrag(handle);
    return;
  }
  if (!activeKeyboardDrag) return;
  if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    moveKeyboardDrag(event.key);
    return;
  }
  if ([" ", "Enter"].includes(event.key)) {
    event.preventDefault();
    commitKeyboardDrag();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    cancelKeyboardDrag();
  }
}

async function movePackToFolder(packId, folderId) {
  const pack = allPacks.find((item) => item.id === packId);
  const previousFolderId = pack?.folderId || null;
  if (!pack || previousFolderId === folderId) return;
  const folder = folderById(folderId);
  const previousPacks = [...allPacks];
  const sourceOrder = new Map(sortedPacksFor(previousFolderId)
    .filter((item) => item.id !== packId)
    .map((item, index) => [item.id, index]));
  const targetOrder = new Map([pack, ...sortedPacksFor(folderId)]
    .map((item, index) => [item.id, index]));
  allPacks = allPacks.map((item) => {
    if (targetOrder.has(item.id)) return { ...item, folderId, sortOrder: targetOrder.get(item.id) };
    if (sourceOrder.has(item.id)) return { ...item, sortOrder: sourceOrder.get(item.id) };
    return item;
  });
  libraryMutationInFlight = true;
  renderLibrary();
  $("#header-status").textContent = "Moved";
  setStatus(`Moved to ${folderId ? folderDisplayName(folder) : "Saved pages"}.`);
  try {
    await sendMessage({ type: "MOVE_PACK", id: packId, folderId });
  } catch (error) {
    allPacks = previousPacks;
    renderLibrary();
    throw error;
  } finally {
    libraryMutationInFlight = false;
  }
}

async function persistMoveableOrder(sourceItem, requestedOrder, restoreFocus = false) {
  const moveable = MOVEABLE_ADAPTERS[sourceItem.kind];
  if (!moveable) return;
  const orderedIds = requestedOrder || moveable.readOrder();
  if (!orderedIds.length) return;

  const previousPacks = [...allPacks];
  const previousFolders = [...folders];
  moveable.applyLocalOrder(orderedIds);
  libraryMutationInFlight = true;
  if (sourceItem.kind === "folder") renderFolders();
  renderLibrary();
  if (restoreFocus) focusReorderHandle(sourceItem.id);
  $("#header-status").textContent = "Reordered";
  try {
    await moveable.persist(sourceItem.id, orderedIds);
  } catch (error) {
    allPacks = previousPacks;
    folders = previousFolders;
    renderFolders();
    renderLibrary();
    if (restoreFocus) focusReorderHandle(sourceItem.id);
    throw error;
  } finally {
    libraryMutationInFlight = false;
  }
}

function renderLibrary() {
  const list = $("#library-list");
  list.replaceChildren();
  const query = searchValue();
  const folder = currentFolderId === ROOT_DIRECTORY ? null : folderById(currentFolderId);

  $("#library-title").textContent = folder ? folderDisplayName(folder) : "Saved pages";
  $("#new-folder-button").hidden = Boolean(folder);
  $("#library-search").placeholder = folder ? "Search folder" : "Search saved pages";

  let visibleCount = 0;
  if (folder) {
    appendParentFolderEntry(list);
    sortedPacksFor(folder.id)
      .filter((pack) => matchesPack(pack, query))
      .forEach((pack) => {
        appendPackEntry(list, pack, !query);
        visibleCount += 1;
      });
  } else {
    sortedPacksFor(null)
      .filter((pack) => matchesPack(pack, query))
      .forEach((pack) => {
        appendPackEntry(list, pack, !query);
        visibleCount += 1;
      });
    sortedFolders()
      .filter((folderItem) => !query || folderItem.name.toLowerCase().includes(query))
      .forEach((folderItem) => {
        appendFolderEntry(list, folderItem, !query);
        visibleCount += 1;
      });
  }

  if (!visibleCount) {
    const isSearch = Boolean(query);
    setEmpty(true, isSearch ? "Nothing matches here." : folder ? "This folder is empty." : "No saved pages yet.", isSearch ? "Try a different search." : "Saved pages will stay on this device.");
  } else {
    setEmpty(false, "", "");
  }
  $("#clear-search").hidden = !query;
}

function activeJourney() {
  return journeys.find((journey) => ["recording", "finishing"].includes(journey.state)) || null;
}

function resetDiscardJourneyConfirmation() {
  discardJourneyId = null;
  discardJourneyArmed = false;
}

function armDiscardJourneyConfirmation(journeyId) {
  discardJourneyId = journeyId;
  discardJourneyArmed = true;
}

function renderJourneyState() {
  const journey = activeJourney();
  const active = $("#journey-active");
  const modeOptions = $("#capture-mode-options");
  const startButton = $("#capture-start-button");
  const finishButton = $("#journey-finish-button");
  const discardButton = $("#journey-discard-button");
  const discardConfirmation = $("#journey-discard-confirmation");
  if (!journey) {
    resetDiscardJourneyConfirmation();
    discardButton.hidden = false;
    discardConfirmation.hidden = true;
    active.hidden = true;
    modeOptions.hidden = false;
    startButton.hidden = false;
    finishButton.hidden = true;
    $("#journey-progress").hidden = true;
    active.classList.remove("is-finishing");
    setCaptureMode(captureMode);
    return;
  }
  if (discardJourneyId && discardJourneyId !== journey.id) resetDiscardJourneyConfirmation();
  setCaptureMode("journey");
  modeOptions.hidden = false;
  active.hidden = false;
  startButton.hidden = true;
  finishButton.hidden = false;
  const count = Number(journey.pageCount) || 0;
  $("#journey-count").textContent = `${count} ${count === 1 ? "page" : "pages"}`;
  const savedCount = Number(journey.savedCount) || 0;
  const queuedCount = Number(journey.queuedCount) || 0;
  const failedCount = Number(journey.failedCount) || 0;
  const progress = `${savedCount} saved${queuedCount - failedCount > 0 ? ` · ${queuedCount - failedCount} waiting` : ""}${failedCount ? ` · ${failedCount} failed` : ""}`;
  $("#journey-status").textContent = journeySaveInFlight ? "Saving journey…" : journey.message || progress || "Collecting…";
  if (!journeySaveInFlight && failedCount && /could not save|reached its (page|pack) limit/i.test(journey.message || "")) {
    setStatus(journey.message, true);
  }
  const journeyFinishing = journey.state === "finishing" || journeySaveInFlight;
  const progressBar = $("#journey-progress");
  progressBar.hidden = !journeyFinishing;
  progressBar.setAttribute("aria-valuetext", journeyFinishing ? "Saving journey" : "Collecting journey");
  active.classList.toggle("is-finishing", journeyFinishing);
  finishButton.disabled = journeyFinishing || journeySaveInFlight;
  const discardArmed = discardJourneyArmed && discardJourneyId === journey.id;
  discardButton.hidden = discardArmed;
  discardButton.disabled = journeyFinishing || journeySaveInFlight;
  discardConfirmation.hidden = !discardArmed;
  $("#confirm-discard-journey").disabled = journeyFinishing || journeySaveInFlight;
  $("#cancel-discard-journey").disabled = journeyFinishing || journeySaveInFlight;
  finishButton.textContent = journeyFinishing ? "Saving…" : "Done";
  setButtonBusy(finishButton, journeyFinishing || journeySaveInFlight);
  const list = $("#journey-pages");
  list.replaceChildren();
  (journey.pageTitles || []).slice(-12).forEach((page) => {
    const row = document.createElement("div");
    row.className = "journey-page-row";
    const mark = document.createElement("span");
    mark.className = "journey-page-mark";
    const state = page.state || "saved";
    if (["queued", "saving", "retrying"].includes(state)) {
      mark.classList.add("is-loading");
      mark.setAttribute("aria-label", state === "saving" ? "Saving" : state === "retrying" ? "Retrying" : "Waiting to be saved");
    } else {
      mark.textContent = state === "failed" ? "!" : "✓";
      mark.classList.toggle("is-failed", state === "failed");
    }
    const copy = document.createElement("span");
    copy.className = "journey-page-copy";
    const title = document.createElement("span");
    title.textContent = page.title || page.url;
    const stateLabel = document.createElement("small");
    stateLabel.className = "journey-page-state";
    stateLabel.textContent = state === "failed"
      ? "Couldn’t save"
      : state === "saving"
        ? "Saving…"
        : state === "retrying"
          ? "Retrying…"
          : state === "queued"
            ? "Waiting"
            : "Saved";
    copy.append(title, stateLabel);
    row.append(mark, copy);
    list.append(row);
  });
  if ((journey.pageCount || 0) > 12) {
    const more = document.createElement("div");
    more.className = "journey-page-more";
    more.textContent = `${journey.pageCount - 12} earlier pages`;
    list.prepend(more);
  }
}

function renderCaptureState() {
  const capture = captures[0];
  const button = $("#capture-start-button");
  if (!capture) {
    $("#header-status").textContent = navigator.onLine === false ? "Offline" : "Ready";
    updateSaveAvailability();
    return;
  }
  if (ACTIVE_CAPTURE_STATES.has(capture.state)) {
    button.disabled = true;
    $("#header-status").textContent = "Saving";
    setStatus(cancelInFlightRequestId === capture.id ? "Cancelling save…" : capture.message || "Saving…");
    updateSaveAvailability();
    return;
  }
  cancelInFlightRequestId = null;
  $("#header-status").textContent = capture.state === "interrupted" ? "Save stopped" : "Needs attention";
  setStatus(capture.message || capture.error || "The page could not be saved.", true);
  updateSaveAvailability();
}

function updateSaveAvailability() {
  const button = $("#capture-start-button");
  const cancelButton = $("#cancel-save-button");
  const offline = navigator.onLine === false;
  const activeCapture = captures.find((capture) => ACTIVE_CAPTURE_STATES.has(capture.state));
  const journey = activeJourney();
  const quotaReached = monetizationState
    && !monetizationState.entitlement?.paid
    && Number(monetizationState.remaining) < 1;
  const captureInProgress = Boolean(activeCapture) || Boolean(journey);
  const backgroundSaveNote = $("#save-background-note");
  if (backgroundSaveNote) backgroundSaveNote.hidden = !captureInProgress;
  const isPaid = Boolean(monetizationState?.entitlement?.paid);
  button.disabled = offline || Boolean(activeCapture) || Boolean(journey) || Boolean(quotaReached);
  button.textContent = activeCapture
    ? "Saving…"
    : offline
      ? "Offline"
      : quotaReached
        ? "Monthly limit reached"
        : captureMode === "journey" ? "Start journey" : "Save page";
  setButtonBusy(button, Boolean(activeCapture));
  cancelButton.hidden = !activeCapture;
  cancelButton.disabled = !activeCapture || cancelInFlightRequestId === activeCapture.id;
  cancelButton.textContent = cancelInFlightRequestId === activeCapture?.id ? "Cancelling…" : "Cancel save";
  setButtonBusy(cancelButton, cancelInFlightRequestId === activeCapture?.id);
  $("#capture-settings")?.classList.toggle("is-depth-disabled", captureMode !== "page");
  const folderTrigger = $("#save-folder-trigger");
  if (folderTrigger) folderTrigger.disabled = captureInProgress;
  $("#run-scripts").disabled = captureInProgress;
  const packLimits = $("#pro-pack-limits");
  const packLimitFields = $("#pro-pack-limit-fields");
  const packLimitLocked = !isPaid || captureInProgress;
  if (packLimits) packLimits.classList.toggle("is-locked", !isPaid);
  if (packLimitFields) packLimitFields.setAttribute("aria-disabled", String(packLimitLocked));
  [$("#max-pages-per-pack"), $("#max-bytes-per-pack")].forEach((control) => {
    if (control) control.disabled = packLimitLocked;
  });
  const packLimitNote = $("#pro-pack-limits-note");
  if (packLimitNote) packLimitNote.textContent = isPaid
    ? "Higher limits use more local storage."
    : "Upgrade to Pro to increase pack limits.";
  document.querySelectorAll("[data-capture-mode]").forEach((option) => { option.classList.toggle("is-disabled", captureInProgress); });
  document.querySelectorAll('input[name="capture-mode"]').forEach((input) => { input.disabled = captureInProgress; });
  document.querySelectorAll("[data-depth-step]").forEach((stepButton) => { stepButton.disabled = captureInProgress || captureMode !== "page"; });
  if (captureInProgress) closeFolderMenu();
}

function renderMonetization() {
  if (!monetizationState) {
    $("#quota-count").textContent = "Loading…";
    return;
  }
  const { entitlement = {}, pricing = {}, remaining } = monetizationState;
  const isPaid = Boolean(entitlement.paid);
  const freeLimit = Number(pricing.freePagesPerMonth || 25);
  $("#plan-chip").textContent = isPaid ? "Pro" : "Free";
  $("#plan-chip").classList.toggle("is-pro", isPaid);
  const quotaCount = $("#quota-count");
  quotaCount.classList.remove("is-loading");
  quotaCount.textContent = isPaid ? "Unlimited saves" : `${remaining} saves left`;
  quotaCount.title = isPaid
    ? "PagePack Pro: unlimited page saves"
    : `${Math.max(0, Number(remaining) || 0)} of ${freeLimit} free page saves left this month`;

  $("#pro-title").textContent = isPaid ? "You’re on Pro" : "Unlimited monthly saves";
  $("#pro-price").hidden = isPaid;
  $("#pro-price-alt").textContent = isPaid
    ? "Your unlimited page allowance is active."
    : `or ${pricing.yearlyPrice || "CAD $9.99/year"} — over half off`;
  $("#upgrade-button").hidden = isPaid;
  $("#manage-button").hidden = !isPaid;
  $("#restore-button").hidden = isPaid;
  const providerReady = monetizationState.payment?.configured !== false;
  if (!isPaid && !providerReady) {
    setProStatus("Checkout is not connected yet. Register the PagePack merchant account before selling Pro.");
  }
  updateSaveAvailability();
}

async function refreshMonetization(refresh = false, triggerButton = null) {
  setButtonBusy(triggerButton, true);
  if (triggerButton) triggerButton.disabled = true;
  try {
    const response = await sendMessage({ type: "GET_MONETIZATION", refresh });
    monetizationState = response.state;
    renderMonetization();
    if (refresh) {
      const paymentNotConnected = monetizationState.payment?.configured === false;
      setProStatus(paymentNotConnected
        ? "Checkout is not connected yet. Register the PagePack merchant account before selling Pro."
        : monetizationState.entitlement?.paid ? "Pro is active on this browser." : "Plan status is up to date.");
    }
  } catch (error) {
    const quotaCount = $("#quota-count");
    quotaCount.classList.remove("is-loading");
    if (!monetizationState) quotaCount.textContent = "Plan unavailable";
    setProStatus(error.message, true);
  } finally {
    setButtonBusy(triggerButton, false);
    if (triggerButton) triggerButton.disabled = false;
  }
}

async function openProPage(mode = "checkout", triggerButton = null) {
  setProStatus(mode === "login" ? "Opening sign in…" : "Opening secure checkout…");
  setButtonBusy(triggerButton, true);
  if (triggerButton) triggerButton.disabled = true;
  try {
    await sendMessage({ type: "OPEN_PRO_PAGE", mode });
  } catch (error) {
    setProStatus(error.message, true);
  } finally {
    setButtonBusy(triggerButton, false);
    if (triggerButton) triggerButton.disabled = false;
  }
}

function openProOverlay() {
  proOverlayRestoreFocus = document.activeElement;
  $("#pro-overlay").hidden = false;
  document.body.classList.add("is-pro-open");
  requestAnimationFrame(() => $("#close-pro-button").focus());
}

function closeProOverlay() {
  $("#pro-overlay").hidden = true;
  document.body.classList.remove("is-pro-open");
  if (proOverlayRestoreFocus?.focus) proOverlayRestoreFocus.focus();
  proOverlayRestoreFocus = null;
}

function shortIssueUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "No URL recorded";
  try {
    const url = new URL(raw);
    const path = `${url.pathname || "/"}${url.search || ""}`;
    return `${url.hostname}${path.length > 56 ? `${path.slice(0, 53)}…` : path}`;
  } catch {
    return raw.length > 72 ? `${raw.slice(0, 69)}…` : raw;
  }
}

function issueTypeLabel(issue) {
  if (issue?.type === "page-limit") return "Safety limit";
  if (issue?.type === "pack-limit") return "Pack limit";
  if (issue?.type === "page") return "Page";
  if (issue?.type === "resource") {
    const kind = String(issue.kind || "resource").toLowerCase();
    return kind === "style" ? "Stylesheet" : kind === "script" ? "Script" : kind === "media" ? "Media" : "File";
  }
  return "Saved item";
}

function issueReason(issue) {
  const message = String(issue?.message || "").trim();
  if (issue?.type === "page-limit") return message || "The pack reached its page safety limit.";
  if (/HTTP\s+(401|403)\b/i.test(message)) return "The server denied access to this item.";
  if (/HTTP\s+\d{3}/i.test(message)) return `The server returned ${message.match(/HTTP\s+\d{3}/i)?.[0] || "an HTTP error"}.`;
  if (/not an HTML page/i.test(message)) return "This link was not an HTML page.";
  if (/failed to fetch|network|timed out|timeout|name not resolved|connection/i.test(message)) {
    return "The item did not respond or was blocked by the site.";
  }
  if (/blocked|cannot access|permission|protected/i.test(message)) return "Chrome or the site blocked access to this item.";
  return message || "This item could not be saved.";
}

function renderIssueReport(pack) {
  const failures = Array.isArray(pack?.failures) ? pack.failures : [];
  const count = failures.length || Number(pack?.stats?.failed || 0);
  const label = count === 1 ? "error" : "errors";
  $("#issues-title").textContent = count ? `${count} ${label}` : "Errors";
  $("#issues-summary").textContent = count ? "The saved pack is available, but some pages or files may be missing." : "Detailed error information is unavailable for this older save.";
  const ignoreAllButton = $("#ignore-all-issues-button");
  clearTimeout(ignoreAllTimer);
  ignoreAllArmed = false;
  ignoreAllButton.textContent = "Ignore all";
  ignoreAllButton.classList.remove("is-confirming");
  ignoreAllButton.hidden = !failures.length;
  ignoreAllButton.disabled = false;
  const list = $("#issues-list");
  list.replaceChildren();

  if (!failures.length) {
    const empty = document.createElement("div");
    empty.className = "issue-row issue-row-empty";
    empty.textContent = "No individual errors were recorded for this older save.";
    list.append(empty);
  } else {
    failures.slice(0, 120).forEach((issue, issueIndex) => {
      const row = document.createElement("article");
      row.className = "issue-row";
      const heading = document.createElement("div");
      heading.className = "issue-row-heading";
      const type = document.createElement("span");
      type.className = "issue-type";
      type.textContent = issueTypeLabel(issue);
      const target = document.createElement("strong");
      target.className = "issue-target";
      target.textContent = issue.type === "page-limit" ? "Pack page limit" : shortIssueUrl(issue.url || issue.pageUrl);
      heading.append(type, target);
      const reason = document.createElement("p");
      reason.className = "issue-reason";
      reason.textContent = issueReason(issue);
      row.append(heading, reason);
      const actions = document.createElement("div");
      actions.className = "issue-actions";
      if ((issue.type === "page" && /^https?:\/\//i.test(String(issue.url || "")))
        || (issue.type === "resource" && /^https?:\/\//i.test(String(issue.url || "")) && /^https?:\/\//i.test(String(issue.pageUrl || "")))) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "issue-retry-button";
        retry.dataset.issueAction = `retry:${issueIndex}`;
        retry.textContent = issue.type === "resource" ? "Retry file" : "Retry page";
        actions.append(retry);
      }
      const ignore = document.createElement("button");
      ignore.type = "button";
      ignore.className = "issue-ignore-button";
      ignore.dataset.issueAction = `ignore:${issueIndex}`;
      ignore.textContent = "Ignore";
      actions.append(ignore);
      row.append(actions);
      list.append(row);
    });
    if (failures.length > 120) {
      const more = document.createElement("p");
      more.className = "issues-more";
      more.textContent = `${failures.length - 120} more issues are not shown here.`;
      list.append(more);
    }
  }

}

function openIssuesOverlay(packId) {
  const pack = allPacks.find((item) => item.id === packId);
  if (!pack) return setStatus("The saved pack could not be found.", true);
  issueReportPack = pack;
  issuesOverlayRestoreFocus = document.activeElement;
  renderIssueReport(pack);
  $("#issues-overlay").hidden = false;
  requestAnimationFrame(() => $("#close-issues-button").focus());
}

function closeIssuesOverlay() {
  $("#issues-overlay").hidden = true;
  if (issuesOverlayRestoreFocus?.focus) issuesOverlayRestoreFocus.focus();
  issuesOverlayRestoreFocus = null;
  issueReportPack = null;
}

async function handleIssueAction(action, button) {
  const [kind, indexValue] = String(action || "").split(":");
  const issueIndex = Number(indexValue);
  const packId = issueReportPack?.id;
  if (!packId || !Number.isInteger(issueIndex)) return;
  button.disabled = true;
  setButtonBusy(button, true);
  try {
    const response = await sendMessage({
      type: kind === "retry" ? "RETRY_PACK_ISSUE" : "IGNORE_PACK_ISSUE",
      packId,
      issueIndex,
    });
    if (response.error) throw new Error(response.error);
    await loadLibraryData();
    const updated = allPacks.find((pack) => pack.id === packId);
    if (updated) {
      issueReportPack = updated;
      renderIssueReport(updated);
    }
    setStatus(kind === "retry" ? "Retry complete." : "Error ignored.");
  } catch (error) {
    button.disabled = false;
    await loadLibraryData();
    const updated = allPacks.find((pack) => pack.id === packId);
    if (updated) {
      issueReportPack = updated;
      renderIssueReport(updated);
    }
    setStatus(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function ignoreAllIssues() {
  const packId = issueReportPack?.id;
  const count = issueReportPack?.failures?.length || 0;
  if (!packId || !count) return;
  const button = $("#ignore-all-issues-button");
  if (!ignoreAllArmed) {
    ignoreAllArmed = true;
    button.textContent = `Confirm ignore ${count === 1 ? "error" : "all"}`;
    button.classList.add("is-confirming");
    ignoreAllTimer = setTimeout(() => {
      ignoreAllArmed = false;
      button.textContent = "Ignore all";
      button.classList.remove("is-confirming");
    }, 5000);
    setStatus("Click again to ignore all errors.");
    return;
  }
  clearTimeout(ignoreAllTimer);
  ignoreAllArmed = false;
  button.disabled = true;
  setButtonBusy(button, true);
  try {
    const response = await sendMessage({ type: "IGNORE_ALL_PACK_ISSUES", packId });
    if (response.error) throw new Error(response.error);
    await loadLibraryData();
    const updated = allPacks.find((pack) => pack.id === packId);
    if (updated) {
      if (updated.failures?.length) {
        issueReportPack = updated;
        renderIssueReport(updated);
      } else {
        closeIssuesOverlay();
      }
    }
    setStatus("All errors ignored.");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Ignore all";
    button.classList.remove("is-confirming");
    setStatus(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function loadLibraryData() {
  try {
    const result = await sendMessage({ type: "LIST_LIBRARY" });
    if (dragSession || libraryMutationInFlight) return;
    allPacks = Array.isArray(result.packs) ? result.packs : [];
    folders = Array.isArray(result.folders) ? result.folders : [];
    captures = Array.isArray(result.captures) ? result.captures : [];
    journeys = Array.isArray(result.journeys) ? result.journeys : [];
    renderFolders();
    renderLibrary();
    renderJourneyState();
    renderCaptureState();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function showView(name) {
  if (dragSession?.mode === "keyboard") cancelKeyboardDrag();
  if (dragSession?.mode === "pointer") cancelPointerDrag();
  const saveActive = name === "save";
  const libraryActive = name === "library";
  const saveView = $("#save-view");
  const libraryView = $("#library-view");
  saveView.hidden = !saveActive;
  libraryView.hidden = !libraryActive;
  saveView.setAttribute("aria-hidden", String(!saveActive));
  libraryView.setAttribute("aria-hidden", String(!libraryActive));
  $("#save-tab").classList.toggle("is-active", saveActive);
  $("#library-tab").classList.toggle("is-active", libraryActive);
  if (libraryActive) renderLibrary();
}

function updateDepth(delta) {
  const output = $("#depth-value");
  const value = Math.max(0, Math.min(5, Number(output.value || output.textContent || 0) + delta));
  output.value = String(value);
  output.textContent = String(value);
  persistCapturePreferences();
}

function setCaptureMode(mode) {
  captureMode = mode === "journey" ? "journey" : "page";
  document.querySelectorAll("[data-capture-mode]").forEach((option) => {
    const selected = option.dataset.captureMode === captureMode;
    option.classList.toggle("is-selected", selected);
    option.setAttribute("aria-checked", String(selected));
  });
  document.querySelectorAll('input[name="capture-mode"]').forEach((input) => {
    input.checked = input.value === captureMode;
  });
  $("#capture-settings")?.classList.toggle("is-depth-disabled", captureMode !== "page");
  updateSaveAvailability();
}

function startSelectedCapture() {
  return captureMode === "journey" ? startJourney() : savePage();
}

function openViewer(packId, pageIndex = 0) {
  const url = chrome.runtime.getURL(`viewer.html?pack=${encodeURIComponent(packId)}&page=${Math.max(0, Number(pageIndex) || 0)}`);
  chrome.tabs.create({ url });
  window.close();
}

async function savePage() {
  const button = $("#capture-start-button");
  if (navigator.onLine === false) {
    showView("library");
    setStatus("You’re offline. Your saved pages are in Library.");
    return;
  }
  if (!activeTab || !Number.isInteger(activeTab.id)) {
    setStatus("The current tab is unavailable. Reopen the popup and try again.", true);
    return;
  }
  if (!/^https?:\/\//i.test(activeTab.url || "")) {
    setStatus("This page cannot be saved from the browser’s internal pages.", true);
    return;
  }
  const depth = Number($("#depth-value").value || $("#depth-value").textContent || 0);
  button.disabled = true;
  setButtonBusy(button, true);
  $("#header-status").textContent = "Starting";
  setStatus("Starting save…");
  try {
    const response = await sendMessage({
      type: "START_CAPTURE",
      tabId: activeTab.id,
      pageUrl: activeTab.url,
      pageTitle: activeTab.title,
      depth,
      runScripts: $("#run-scripts").checked,
      folderId: $("#save-folder").value || null,
      maxPages: Number($("#max-pages-per-pack").value),
      maxTotalBytes: Number($("#max-bytes-per-pack").value),
    });
    if (!response.accepted) throw new Error("The save did not start.");
    cancelInFlightRequestId = null;
    setStatus("Reading the page…");
    $("#save-background-note").hidden = false;
    scrollToSaveNote();
    loadLibraryData();
  } catch (error) {
    button.disabled = false;
    setButtonBusy(button, false);
    $("#header-status").textContent = "Needs attention";
    setStatus(error.message, true);
  }
}

async function cancelSave() {
  const capture = captures.find((item) => ACTIVE_CAPTURE_STATES.has(item.state));
  if (!capture || cancelInFlightRequestId) return;
  cancelInFlightRequestId = capture.id;
  setButtonBusy($("#cancel-save-button"), true);
  updateSaveAvailability();
  setStatus("Cancelling save…");
  try {
    const response = await sendMessage({ type: "CANCEL_CAPTURE", requestId: capture.id });
    if (!response.ok) throw new Error(response.error || "The save could not be cancelled.");
  } catch (error) {
    cancelInFlightRequestId = null;
    setButtonBusy($("#cancel-save-button"), false);
    updateSaveAvailability();
    setStatus(error.message, true);
    loadLibraryData();
  }
}

async function startJourney() {
  if (navigator.onLine === false) {
    setStatus("You’re offline. Start a journey while online.", true);
    return;
  }
  if (!activeTab || !Number.isInteger(activeTab.id)) {
    setStatus("The current tab is unavailable. Reopen the popup and try again.", true);
    return;
  }
  if (!/^https?:\/\//i.test(activeTab.url || "")) {
    setStatus("This page cannot start a journey from the browser’s internal pages.", true);
    return;
  }
  const button = $("#capture-start-button");
  button.disabled = true;
  setButtonBusy(button, true);
  setStatus("Starting journey…");
  try {
    const response = await sendMessage({
      type: "START_JOURNEY",
      tabId: activeTab.id,
      pageUrl: activeTab.url,
      pageTitle: activeTab.title,
      runScripts: $("#run-scripts").checked,
      folderId: $("#save-folder").value || null,
      maxPages: Number($("#max-pages-per-pack").value),
      maxTotalBytes: Number($("#max-bytes-per-pack").value),
    });
    if (!response.accepted) throw new Error("The journey did not start.");
    button.disabled = false;
    setButtonBusy(button, false);
    setStatus("Journey started. Keep browsing; pages will be added automatically.");
    $("#save-background-note").hidden = false;
    scrollToSaveNote();
    await loadLibraryData();
  } catch (error) {
    button.disabled = false;
    setButtonBusy(button, false);
    button.textContent = "Discard journey";
    button.classList.remove("is-confirming");
    setStatus(error.message, true);
  }
}

function openJourneyReview() {
  const journey = activeJourney();
  if (!journey || journey.state !== "recording" || journeySaveInFlight) return;
  journeyReviewId = journey.id;
  journeyReviewRestoreFocus = document.activeElement;
  const pages = journey.pageTitles || [];
  const waitingCount = pages.filter((page) => ["queued", "saving", "retrying"].includes(page.state)).length;
  const failedCount = pages.filter((page) => page.state === "failed").length;
  const details = [
    waitingCount ? `${waitingCount} still saving` : "ready to save",
    failedCount ? `${failedCount} couldn’t be saved` : "",
  ].filter(Boolean).join(" · ");
  const selectionHint = pages.length > 1 ? " Uncheck pages you don’t need; the starting page stays included." : " The starting page is always included.";
  $("#journey-review-summary").textContent = `${pages.length} ${pages.length === 1 ? "page" : "pages"} captured · ${details}.${selectionHint}`;
  const list = $("#journey-review-list");
  list.replaceChildren();
  pages.forEach((page, index) => {
    const row = document.createElement("label");
    row.className = "journey-review-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = page.state !== "failed";
    checkbox.dataset.pageUrl = page.url || "";
    checkbox.id = `journey-review-page-${index}`;
    const isStartingPage = index === 0;
    const isFailedPage = page.state === "failed";
    checkbox.disabled = isStartingPage || isFailedPage;
    if (isStartingPage) {
      checkbox.title = "The starting page is always included";
      row.classList.add("is-required");
    }
    if (isFailedPage) row.classList.add("is-disabled");
    const mark = document.createElement("span");
    mark.className = "journey-review-mark";
    const state = page.state || "saved";
    mark.textContent = state === "failed" ? "!" : ["queued", "saving", "retrying"].includes(state) ? "" : "✓";
    if (["queued", "saving", "retrying"].includes(state)) mark.classList.add("is-loading");
    if (state === "failed") mark.classList.add("is-failed");
    const copy = document.createElement("span");
    copy.className = "journey-review-copy";
    const title = document.createElement("strong");
    title.textContent = page.title || page.url || "Saved page";
    const stateLabel = document.createElement("small");
    stateLabel.textContent = state === "failed" ? "Couldn’t save" : isStartingPage ? "Starting page · always included" : state === "saving" ? "Saving…" : state === "retrying" ? "Retrying…" : state === "queued" ? "Waiting" : "Saved";
    copy.append(title, stateLabel);
    row.append(checkbox, mark, copy);
    list.append(row);
  });
  $("#journey-review-overlay").hidden = false;
  $("#journey-finish-button").disabled = true;
  $("#journey-discard-button").disabled = true;
  requestAnimationFrame(() => $("#save-reviewed-journey-button").focus());
}

function setJourneyReviewBusy(busy) {
  journeySaveInFlight = busy;
  const overlay = $("#journey-review-overlay");
  overlay.classList.toggle("is-busy", busy);
  overlay.setAttribute("aria-busy", String(busy));
  overlay.querySelectorAll("button").forEach((control) => { control.disabled = busy; });
  const saveButton = $("#save-reviewed-journey-button");
  saveButton.textContent = busy ? "Saving…" : "Save journey";
  setButtonBusy(saveButton, busy);
  renderJourneyState();
  updateSaveAvailability();
}

function closeJourneyReview(force = false) {
  if (journeySaveInFlight && !force) return;
  setJourneyReviewBusy(false);
  $("#journey-review-overlay").hidden = true;
  journeyReviewId = null;
  if (journeyReviewRestoreFocus?.focus) journeyReviewRestoreFocus.focus();
  journeyReviewRestoreFocus = null;
}

async function saveActiveJourney(excludedUrls = []) {
  const journey = activeJourney();
  if (!journey || journey.state !== "recording" || journeySaveInFlight) return;
  const button = $("#save-reviewed-journey-button");
  setJourneyReviewBusy(true);
  // Keep the capture view visible so progress and any failure are visible
  // immediately instead of being trapped behind the review dialog.
  $("#journey-review-overlay").hidden = true;
  if (document.activeElement?.closest?.("#journey-review-overlay")) document.activeElement.blur();
  setStatus("Saving journey…");
  try {
    const response = await sendMessage({ type: "FINISH_JOURNEY", journeyId: journey.id, excludedUrls });
    if (response.empty) throw new Error("No pages could be saved from this journey.");
    closeJourneyReview(true);
    await Promise.all([loadLibraryData(), refreshMonetization(false)]);
    setStatus("Journey saved to your library.");
  } catch (error) {
    setStatus(error.message, true);
    await loadLibraryData();
    setJourneyReviewBusy(false);
    button.disabled = false;
  }
}

function finishActiveJourney() {
  const journey = activeJourney();
  if (!journey || journey.state !== "recording" || journeySaveInFlight) return;
  const waitingCount = (journey.pageTitles || []).filter((page) => ["queued", "saving", "retrying"].includes(page.state)).length;
  if (Number(journey.savedCount || 0) < 1 && waitingCount < 1) {
    setStatus("No pages have been saved yet. Keep browsing and try Done again.", true);
    return;
  }
  if (journey && Number(journey.pageCount || 0) < 1) {
    setStatus("The starting page is still being saved. Try Done again in a moment.");
    return;
  }
  openJourneyReview();
}

function saveReviewedJourney() {
  if (journeySaveInFlight) return;
  const excludedUrls = [...$("#journey-review-list").querySelectorAll("input[type=checkbox]:not(:checked):not(:disabled)")]
    .map((input) => input.dataset.pageUrl)
    .filter(Boolean);
  saveActiveJourney(excludedUrls).catch((error) => setStatus(error.message, true));
}

function discardActiveJourney() {
  const journey = activeJourney();
  if (!journey || journey.state !== "recording" || journeySaveInFlight) return;
  armDiscardJourneyConfirmation(journey.id);
  renderJourneyState();
  setStatus("");
}

async function confirmDiscardJourney() {
  const journey = activeJourney();
  if (!journey || journey.state !== "recording" || journeySaveInFlight || !discardJourneyArmed || discardJourneyId !== journey.id) return;
  const button = $("#confirm-discard-journey");
  resetDiscardJourneyConfirmation();
  button.disabled = true;
  setButtonBusy(button, true);
  try {
    await sendMessage({ type: "DISCARD_JOURNEY", journeyId: journey.id });
    await loadLibraryData();
    setStatus("");
  } catch (error) {
    button.disabled = false;
    setButtonBusy(button, false);
    renderJourneyState();
    setStatus(error.message, true);
  }
}

function cancelDiscardJourney() {
  if (!discardJourneyArmed) return;
  resetDiscardJourneyConfirmation();
  renderJourneyState();
  setStatus("");
}

function applyOnlineState() {
  const offline = navigator.onLine === false;
  updateSaveAvailability();
  if (offline) {
    $("#header-status").textContent = "Offline";
    showView("library");
    setStatus("You’re offline. Your saved pages are in Library.");
  } else if (!captures.some((capture) => ACTIVE_CAPTURE_STATES.has(capture.state))) {
    $("#header-status").textContent = "Ready";
  }
}

async function createFolder(event) {
  event.preventDefault();
  const input = $("#new-folder-name");
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  const name = input.value.trim();
  if (!name) return input.focus();
  input.disabled = true;
  if (submitButton) submitButton.disabled = true;
  setButtonBusy(submitButton, true);
  try {
    const response = await sendMessage({ type: "CREATE_FOLDER", name });
    folders.push(response.folder);
    input.value = "";
    $("#new-folder-form").hidden = true;
    renderFolders();
    renderLibrary();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    input.disabled = false;
    if (submitButton) submitButton.disabled = false;
    setButtonBusy(submitButton, false);
  }
}

async function handleLibraryAction(action) {
  if (action.startsWith("cancel:")) {
    resetDeleteConfirmation();
    renderLibrary();
    return;
  }
  const [kind, ...idParts] = action.split(":");
  const id = idParts.join(":");
  if (kind === "toggle-pack-pages") {
    if (expandedPackIds.has(id)) expandedPackIds.delete(id);
    else expandedPackIds.add(id);
    renderLibrary();
    return;
  }
  if (kind === "open-pack-page") {
    const packId = idParts.shift();
    const pageIndex = Number(idParts.join(":"));
    if (packId) openViewer(packId, pageIndex);
    return;
  }
  if (kind === "remove-pack-page") {
    const packId = idParts.shift();
    const pageIndex = Number(idParts.join(":"));
    if (!packId || !Number.isInteger(pageIndex) || pageIndex < 1 || libraryMutationInFlight) return;
    const previousPacks = allPacks;
    const currentPack = allPacks.find((pack) => pack.id === packId);
    if (!currentPack) return;
    const optimisticPack = {
      ...currentPack,
      pages: [...(currentPack.pages || [])],
      failures: [...(currentPack.failures || [])],
      visits: [...(currentPack.visits || [])],
      stats: { ...(currentPack.stats || {}) },
    };
    removePackPageFromPack(optimisticPack, pageIndex);
    libraryMutationInFlight = true;
    allPacks = allPacks.map((pack) => pack.id === packId ? optimisticPack : pack);
    expandedPackIds.add(packId);
    renderLibrary();
    setStatus("Captured page removed.");
    try {
      const response = await sendMessage({ type: "REMOVE_PACK_PAGE", id: packId, pageIndex });
      if (!response.ok) throw new Error("The captured page could not be removed.");
      await loadLibraryData();
    } catch (error) {
      allPacks = previousPacks;
      renderLibrary();
      throw error;
    } finally {
      libraryMutationInFlight = false;
    }
    return;
  }
  if (kind === "open-folder") {
    resetDeleteConfirmation();
    currentFolderId = id;
    $("#library-search").value = "";
    renderLibrary();
    return;
  }
  if (kind === "go-root") {
    resetDeleteConfirmation();
    currentFolderId = ROOT_DIRECTORY;
    $("#library-search").value = "";
    renderLibrary();
    return;
  }
  if (kind === "open-pack") {
    resetDeleteConfirmation();
    openViewer(id);
    return;
  }
  if (kind === "show-issues") {
    resetDeleteConfirmation();
    openIssuesOverlay(id);
    return;
  }
  if (kind === "delete-pack") {
    if (pendingDeleteAction !== action) {
      armDeleteConfirmation(action);
      renderLibrary();
      return;
    }
    if (libraryMutationInFlight) return;
    resetDeleteConfirmation();
    const previousPacks = allPacks;
    const wasExpanded = expandedPackIds.has(id);
    libraryMutationInFlight = true;
    allPacks = allPacks.filter((pack) => pack.id !== id);
    expandedPackIds.delete(id);
    renderLibrary();
    setStatus("Saved page deleted.");
    try {
      await sendMessage({ type: "DELETE_PACK", id });
    } catch (error) {
      allPacks = previousPacks;
      if (wasExpanded) expandedPackIds.add(id);
      renderLibrary();
      throw error;
    } finally {
      libraryMutationInFlight = false;
    }
    return;
  }
  if (kind === "delete-folder") {
    if (pendingDeleteAction !== action) {
      armDeleteConfirmation(action);
      renderLibrary();
      return;
    }
    if (libraryMutationInFlight) return;
    resetDeleteConfirmation();
    const previousFolders = folders;
    const previousPacks = allPacks;
    const previousFolderId = currentFolderId;
    libraryMutationInFlight = true;
    folders = folders.filter((folder) => folder.id !== id);
    allPacks = allPacks.filter((pack) => pack.folderId !== id);
    currentFolderId = ROOT_DIRECTORY;
    renderFolders();
    renderLibrary();
    setStatus("Folder deleted.");
    try {
      await sendMessage({ type: "DELETE_FOLDER", id });
    } catch (error) {
      folders = previousFolders;
      allPacks = previousPacks;
      currentFolderId = previousFolderId;
      renderFolders();
      renderLibrary();
      throw error;
    } finally {
      libraryMutationInFlight = false;
    }
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CAPTURE_PROGRESS") {
    $("#header-status").textContent = "Saving";
    setStatus(message.message || "Saving…");
  }
  if (message?.type === "CAPTURE_COMPLETE") {
    cancelInFlightRequestId = null;
    $("#capture-start-button").disabled = false;
    setButtonBusy($("#capture-start-button"), false);
    $("#header-status").textContent = "Ready";
    Promise.all([loadLibraryData(), refreshMonetization(false)]).then(() => setStatus("Saved to your library."));
  }
  if (message?.type === "CAPTURE_ERROR") {
    cancelInFlightRequestId = null;
    $("#capture-start-button").disabled = false;
    setButtonBusy($("#capture-start-button"), false);
    $("#header-status").textContent = "Needs attention";
    loadLibraryData();
  }
  if (message?.type === "CAPTURE_CANCELLED") {
    cancelInFlightRequestId = null;
    setButtonBusy($("#capture-start-button"), false);
    setButtonBusy($("#cancel-save-button"), false);
    $("#header-status").textContent = "Ready";
    setStatus("Save cancelled. Nothing was added to your library.");
    loadLibraryData();
  }
  if (["JOURNEY_PROGRESS", "JOURNEY_UPDATED", "JOURNEY_ERROR"].includes(message?.type)) {
    loadLibraryData();
  }
  if (message?.type === "JOURNEY_COMPLETE") {
    closeJourneyReview(true);
    loadLibraryData();
    refreshMonetization(false);
    setStatus("Journey saved to your library.");
  }
  if (message?.type === "JOURNEY_DISCARDED") {
    loadLibraryData();
    setStatus("Journey discarded.");
  }
});

$("#save-tab").addEventListener("click", () => showView("save"));
$("#library-tab").addEventListener("click", () => showView("library"));
$("#plan-chip").addEventListener("click", openProOverlay);
$("#close-pro-button").addEventListener("click", closeProOverlay);
$("#pro-overlay").addEventListener("click", (event) => {
  if (event.target.closest("[data-close-pro]")) closeProOverlay();
});
$("#close-issues-button").addEventListener("click", closeIssuesOverlay);
$("#ignore-all-issues-button").addEventListener("click", ignoreAllIssues);
$("#issues-overlay").addEventListener("click", (event) => {
  if (event.target.closest("[data-close-issues]")) closeIssuesOverlay();
});
$("#close-journey-review-button").addEventListener("click", closeJourneyReview);
$("#keep-browsing-button").addEventListener("click", closeJourneyReview);
$("#save-reviewed-journey-button").addEventListener("click", saveReviewedJourney);
$("#journey-review-overlay").addEventListener("click", (event) => {
  if (event.target.closest("[data-close-journey-review]")) closeJourneyReview();
});
$("#issues-list").addEventListener("click", (event) => {
  const actionNode = event.target.closest("[data-issue-action]");
  if (!actionNode) return;
  handleIssueAction(actionNode.dataset.issueAction, actionNode).catch((error) => setStatus(error.message, true));
});
$("#upgrade-button").addEventListener("click", (event) => openProPage("checkout", event.currentTarget));
$("#manage-button").addEventListener("click", (event) => openProPage("manage", event.currentTarget));
$("#restore-button").addEventListener("click", (event) => openProPage("login", event.currentTarget));
$("#refresh-plan-button").addEventListener("click", (event) => refreshMonetization(true, event.currentTarget));
$("#capture-start-button").addEventListener("click", startSelectedCapture);
$("#journey-finish-button").addEventListener("click", finishActiveJourney);
$("#journey-discard-button").addEventListener("click", discardActiveJourney);
$("#confirm-discard-journey").addEventListener("click", confirmDiscardJourney);
$("#cancel-discard-journey").addEventListener("click", cancelDiscardJourney);
$("#scripts-info-button").addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const info = $("#scripts-info");
  const isOpen = info.hidden;
  info.hidden = !isOpen;
  $("#scripts-info-button").setAttribute("aria-expanded", String(isOpen));
});
$("#cancel-save-button").addEventListener("click", cancelSave);
window.addEventListener("offline", applyOnlineState);
window.addEventListener("online", applyOnlineState);
$("#save-folder-trigger").addEventListener("click", () => toggleFolderMenu());
$("#save-folder-trigger").addEventListener("keydown", (event) => {
  if (["ArrowDown", "Enter", " "].includes(event.key)) {
    event.preventDefault();
    toggleFolderMenu(true);
  }
  if (event.key === "Escape") closeFolderMenu();
});
$("#save-folder-menu").addEventListener("click", (event) => {
  const option = event.target.closest(".folder-option");
  if (option) setSelectedFolder(option.dataset.folderId);
});
document.addEventListener("click", (event) => {
  if (!$("#folder-picker").contains(event.target)) closeFolderMenu();
  if (!$("#scripts-info-button").contains(event.target) && !$("#scripts-info").contains(event.target)) {
    $("#scripts-info").hidden = true;
    $("#scripts-info-button").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  $("#scripts-info").hidden = true;
  $("#scripts-info-button").setAttribute("aria-expanded", "false");
});
document.querySelectorAll('input[name="capture-mode"]').forEach((input) => input.addEventListener("change", () => {
  setCaptureMode(input.value);
  persistCapturePreferences();
}));
$("#run-scripts").addEventListener("change", persistCapturePreferences);
$("#max-pages-per-pack").addEventListener("change", persistCapturePreferences);
$("#max-bytes-per-pack").addEventListener("change", persistCapturePreferences);
document.querySelectorAll("[data-depth-step]").forEach((button) => button.addEventListener("click", () => updateDepth(Number(button.dataset.depthStep))));
$("#new-folder-button").addEventListener("click", () => {
  $("#new-folder-form").hidden = false;
  $("#new-folder-name").focus();
});
$("#cancel-folder-button").addEventListener("click", () => { $("#new-folder-form").hidden = true; });
$("#new-folder-form").addEventListener("submit", createFolder);
$("#library-search").addEventListener("input", renderLibrary);
$("#clear-search").addEventListener("click", () => { $("#library-search").value = ""; renderLibrary(); $("#library-search").focus(); });
$("#library-list").addEventListener("click", (event) => {
  if (event.target.closest(".entry-handle")) return;
  const actionNode = event.target.closest("[data-action]");
  if (!actionNode) return;
  handleLibraryAction(actionNode.dataset.action).catch((error) => setStatus(error.message, true));
});
$("#library-list").addEventListener("pointerdown", handleReorderPointerDown);
$("#library-list").addEventListener("keydown", handleReorderKeyDown);
document.addEventListener("pointermove", handleReorderPointerMove, { passive: false });
document.addEventListener("pointerup", handleReorderPointerUp, { passive: false });
document.addEventListener("pointercancel", handleReorderPointerCancel);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dragSession?.mode === "pointer") cancelPointerDrag();
  if (event.key === "Escape" && !$("#issues-overlay").hidden) closeIssuesOverlay();
  if (event.key === "Escape" && !$("#journey-review-overlay").hidden) closeJourneyReview();
  if (event.key === "Escape" && !$("#pro-overlay").hidden) closeProOverlay();
});

if (navigator.onLine === false) showView("library");

async function initializePopup() {
  await loadCapturePreferences();
  await Promise.all([
    new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { activeTab = tabs?.[0] || null; resolve(); })),
    loadLibraryData(),
    navigator.onLine === false ? Promise.resolve() : refreshMonetization(true),
  ]);
  if (location.hash === "#library") showView("library");
  else if (location.hash === "#pro") openProOverlay();
  else showView(navigator.onLine === false ? "library" : "save");
  applyOnlineState();
}

initializePopup().catch((error) => setStatus(error.message, true));

setInterval(() => {
  if (!dragSession && !libraryMutationInFlight) loadLibraryData();
}, 2500);

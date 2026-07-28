import { removePackPageFromPack } from "./pack-page.js";
import { DEFAULT_PACK_LIMITS, normalizePackLimits } from "./monetization.js";

const $ = (selector) => document.querySelector(selector);
const ROOT_FOLDER = "__root__";
const MAX_DEPTH = 3;
const ACTIVE_CAPTURE_STATES = new Set(["queued", "reading", "saving", "finishing"]);
const PENDING_PAGE_STATES = new Set(["queued", "saving", "retrying"]);
const COLLECT_PREVIEW_LIMIT = 8;
const DEPTH_LABELS = ["Single page", "One level of links", "Two levels of links", "Three levels of links"];

let activeTab = null;
let packs = [];
let folders = [];
let captures = [];
let journeys = [];
let monetization = null;
let currentFolderId = ROOT_FOLDER;
let expandedPackId = null;
let renamingFolderId = null;
let searchQuery = "";
let searchMatches = null;
let searchTimer = 0;
let searchToken = 0;
let cancelRequestId = null;
let librarySignature = "";
let libraryMutationInFlight = false;
let refreshTimer = 0;
let preferencesReady = false;
let preferencesWrite = Promise.resolve();
let issueReport = null;
let reviewBusy = false;
let shownFailureId = null;
let menuRowId = null;
const overlayStack = [];

/* ------------------------------------------------------------------ *
 * Messaging and small helpers
 * ------------------------------------------------------------------ */

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) return reject(new Error(runtimeError.message));
      if (response?.error) return reject(new Error(response.error));
      resolve(response || {});
    });
  });
}

function setBusy(button, busy) {
  if (!button) return;
  button.classList.toggle("is-loading", Boolean(busy));
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

function formatBytes(bytes) {
  const amount = Number(bytes || 0);
  if (amount < 1024) return `${amount} B`;
  if (amount < 1024 * 1024) return `${Math.round(amount / 1024)} KB`;
  if (amount < 1024 * 1024 * 1024) return `${(amount / (1024 * 1024)).toFixed(1)} MB`;
  return `${(amount / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(value) {
  const time = Number(value || 0);
  if (!time) return "";
  const date = new Date(time);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  try {
    if (sameDay) {
      return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
    }
    const sameYear = date.getFullYear() === today.getFullYear();
    return new Intl.DateTimeFormat(undefined, sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" }).format(date);
  } catch {
    return "";
  }
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function hostOf(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    const path = `${url.pathname}${url.search}`.replace(/\/$/, "");
    return `${url.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return String(value || "");
  }
}

function truncate(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function setStatus(message, isError = false) {
  const node = $("#save-status");
  node.textContent = message || "";
  node.classList.toggle("is-error", Boolean(isError) && Boolean(message));
}

function setProStatus(message, isError = false) {
  const node = $("#pro-status");
  node.textContent = message || "";
  node.classList.toggle("is-error", Boolean(isError) && Boolean(message));
}

function reportError(error) {
  setStatus(error?.message || "Something went wrong.", true);
}

function isSavablePage(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

function isOffline() {
  return navigator.onLine === false;
}

/* ------------------------------------------------------------------ *
 * Derived state
 * ------------------------------------------------------------------ */

function activeCapture() {
  return captures.find((capture) => ACTIVE_CAPTURE_STATES.has(capture.state)) || null;
}

function failedCapture() {
  return captures.find((capture) => ["failed", "interrupted"].includes(capture.state)) || null;
}

function activeJourney() {
  return journeys.find((journey) => ["recording", "finishing"].includes(journey.state)) || null;
}

function hasActiveWork() {
  return Boolean(activeCapture() || activeJourney());
}

function isPaid() {
  return Boolean(monetization?.entitlement?.paid);
}

function savesLeft() {
  if (!monetization || isPaid()) return Infinity;
  return Math.max(0, Number(monetization.remaining) || 0);
}

function folderById(id) {
  return folders.find((folder) => folder.id === id) || null;
}

function folderName(id) {
  return folderById(id)?.name || "Library";
}

function sortedFolders() {
  return [...folders].sort((a, b) => {
    const orderA = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number(a.createdAt || 0);
    const orderB = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number(b.createdAt || 0);
    return orderA - orderB || String(a.name).localeCompare(String(b.name));
  });
}

function packsIn(folderId) {
  return packs
    .filter((pack) => (pack.folderId || null) === (folderId || null))
    .sort((a, b) => {
      const orderA = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
      const orderB = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;
      return orderA - orderB || Number(b.savedAt || 0) - Number(a.savedAt || 0);
    });
}

function packById(id) {
  return packs.find((pack) => pack.id === id) || null;
}

/* ------------------------------------------------------------------ *
 * Capture preferences
 * ------------------------------------------------------------------ */

function preferenceSnapshot() {
  const limits = normalizePackLimits({
    maxPages: $("#max-pages-per-pack").value,
    maxTotalBytes: $("#max-bytes-per-pack").value,
  });
  return {
    depth: Math.max(0, Math.min(MAX_DEPTH, Number($("#depth-select").value) || 0)),
    runScripts: $("#run-scripts").checked,
    folderId: $("#save-folder").value || null,
    ...limits,
  };
}

function persistPreferences() {
  if (!preferencesReady) return;
  const preferences = preferenceSnapshot();
  preferencesWrite = preferencesWrite
    .catch(() => {})
    .then(() => sendMessage({ type: "SET_CAPTURE_PREFERENCES", preferences }))
    .catch(() => {});
}

async function loadPreferences() {
  try {
    const { preferences = {} } = await sendMessage({ type: "GET_CAPTURE_PREFERENCES" });
    const depth = Math.max(0, Math.min(MAX_DEPTH, Number(preferences.depth) || 0));
    $("#depth-select").value = String(depth);
    $("#run-scripts").checked = preferences.runScripts !== false;
    $("#save-folder").value = typeof preferences.folderId === "string" ? preferences.folderId : "";
    const limits = normalizePackLimits(preferences);
    $("#max-pages-per-pack").value = String(limits.maxPages || DEFAULT_PACK_LIMITS.maxPages);
    $("#max-bytes-per-pack").value = String(limits.maxTotalBytes || DEFAULT_PACK_LIMITS.maxTotalBytes);
  } catch {
    // Defaults from the markup remain in place.
  } finally {
    preferencesReady = true;
    renderOptionsSummary();
  }
}

function renderOptionsSummary() {
  const depth = Number($("#depth-select").value) || 0;
  const parts = [DEPTH_LABELS[depth] || DEPTH_LABELS[0]];
  if (!$("#run-scripts").checked) parts.push("no scripts");
  $("#options-summary").textContent = parts.join(" · ");
}

/* ------------------------------------------------------------------ *
 * Folder picker (save destination)
 * ------------------------------------------------------------------ */

function closeFolderMenu(restoreFocus = false) {
  $("#save-folder-menu").hidden = true;
  $("#save-folder-trigger").setAttribute("aria-expanded", "false");
  if (restoreFocus) $("#save-folder-trigger").focus();
}

function toggleFolderMenu(force) {
  const menu = $("#save-folder-menu");
  const open = typeof force === "boolean" ? force : menu.hidden;
  menu.hidden = !open;
  $("#save-folder-trigger").setAttribute("aria-expanded", String(open));
  if (open) (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild)?.focus();
}

function setSaveFolder(id, { closeMenu = true, persist = true } = {}) {
  const folder = id ? folderById(id) : null;
  const value = folder?.id || "";
  $("#save-folder").value = value;
  const label = folder ? folder.name : "Library";
  $("#save-folder-label").textContent = label;
  $("#save-folder-trigger").setAttribute("aria-label", `Save to folder: ${label}`);
  $("#save-folder-menu").querySelectorAll("[data-folder-id]").forEach((option) => {
    option.setAttribute("aria-selected", String(option.dataset.folderId === value));
  });
  if (closeMenu) closeFolderMenu(true);
  if (persist) persistPreferences();
}

function renderFolderPicker() {
  const menu = $("#save-folder-menu");
  const selected = $("#save-folder").value;
  const options = [{ id: "", name: "Library" }, ...sortedFolders()];
  menu.replaceChildren(...options.map((folder) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "menu-item";
    option.setAttribute("role", "option");
    option.dataset.folderId = folder.id || "";
    const name = document.createElement("span");
    name.textContent = folder.name;
    const check = document.createElement("span");
    check.className = "menu-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";
    option.append(name, check);
    return option;
  }));
  const stillExists = options.some((folder) => (folder.id || "") === selected);
  setSaveFolder(stillExists ? selected : "", { closeMenu: false, persist: false });
}

/* ------------------------------------------------------------------ *
 * Save view
 * ------------------------------------------------------------------ */

function renderTargetCard() {
  const title = $("#target-title");
  const host = $("#target-host");
  const mark = $("#target-mark");
  if (!activeTab) {
    title.textContent = "No page to save";
    host.textContent = "Open a website in this tab first.";
    mark.textContent = "·";
    return;
  }
  const site = hostOf(activeTab.url);
  title.textContent = activeTab.title || site || "Untitled page";
  title.title = activeTab.title || "";
  host.textContent = isSavablePage(activeTab.url) ? site : "This kind of page cannot be saved";
  mark.textContent = (site[0] || "·").toUpperCase();
}

function captureProgressRatio(capture) {
  const total = Number(capture.assetsTotal) || 0;
  const done = Number(capture.assetsDone) || 0;
  if (!total) return 0;
  return Math.max(0, Math.min(1, done / total));
}

function renderProgressCard(capture) {
  const pagesTotal = Number(capture.pagesTotal) || 1;
  const cancelling = cancelRequestId === capture.id;
  $("#progress-title").textContent = cancelling
    ? "Cancelling…"
    : pagesTotal > 1 ? "Saving pages" : "Saving this page";
  $("#progress-detail").textContent = cancelling ? "" : capture.message || "Working…";
  const bar = $("#progress-bar");
  const determinate = capture.determinate === true && Number(capture.assetsTotal) > 0 && !cancelling;
  bar.classList.toggle("is-indeterminate", !determinate);
  if (determinate) {
    const percent = Math.round(captureProgressRatio(capture) * 100);
    $("#progress-fill").style.width = `${percent}%`;
    bar.setAttribute("aria-valuenow", String(percent));
    bar.setAttribute("aria-valuetext", `${percent}% saved`);
  } else {
    $("#progress-fill").style.removeProperty("width");
    bar.removeAttribute("aria-valuenow");
    bar.setAttribute("aria-valuetext", capture.message || "Saving");
  }
  const cancel = $("#cancel-save-button");
  cancel.disabled = cancelling;
  cancel.textContent = cancelling ? "Cancelling…" : "Cancel save";
  setBusy(cancel, cancelling);
}

function renderCollectPanel(journey) {
  const pages = journey.pageTitles || [];
  const saved = Number(journey.savedCount) || 0;
  const pending = Number(journey.pendingCount) || 0;
  const failed = Number(journey.failedCount) || 0;
  const finishing = journey.state === "finishing" || reviewBusy;
  $("#collect-count").textContent = plural(Number(journey.pageCount) || 0, "page");
  const parts = [`${saved} saved`];
  if (pending) parts.push(`${pending} still saving`);
  if (failed) parts.push(`${failed} couldn’t be saved`);
  // A limit or capture failure is the one case where the worker's own wording
  // says more than the counts do.
  const warning = /limit|couldn’t|could not/i.test(journey.message || "") ? journey.message : "";
  const status = $("#collect-status");
  status.textContent = finishing
    ? "Saving your collection…"
    : warning || (saved || pending || failed
      ? parts.join(" · ")
      : "Browse normally. Every page you open here is added.");
  status.classList.toggle("is-warning", Boolean(warning) && !finishing);

  const list = $("#collect-pages");
  list.replaceChildren();
  const visible = pages.slice(-COLLECT_PREVIEW_LIMIT);
  if (pages.length > visible.length) {
    const more = document.createElement("p");
    more.className = "collect-more";
    more.textContent = `${pages.length - visible.length} earlier ${pages.length - visible.length === 1 ? "page" : "pages"}`;
    list.append(more);
  }
  visible.forEach((page) => {
    const row = document.createElement("p");
    row.className = "collect-page";
    const mark = document.createElement("span");
    mark.className = "collect-mark";
    const state = page.state || "saved";
    if (PENDING_PAGE_STATES.has(state)) {
      mark.classList.add("is-pending");
    } else if (state === "failed") {
      mark.classList.add("is-failed");
      mark.textContent = "!";
    } else {
      mark.textContent = "✓";
    }
    const label = document.createElement("span");
    label.className = "collect-page-title";
    label.textContent = page.title || shortUrl(page.url);
    label.title = page.url || "";
    row.append(mark, label);
    if (state === "failed") {
      const note = document.createElement("span");
      note.className = "collect-page-note";
      note.textContent = "not saved";
      row.append(note);
    }
    list.append(row);
  });

  const finish = $("#collect-finish-button");
  const keepable = pages.filter((page) => page.state !== "failed").length;
  finish.textContent = finishing ? "Saving…" : keepable ? `Save ${plural(keepable, "page")}` : "Save these pages";
  finish.disabled = finishing || !keepable;
  setBusy(finish, finishing);
  $("#collect-discard-button").disabled = finishing;
}

function renderSaveView() {
  renderTargetCard();
  const capture = activeCapture();
  const journey = activeJourney();
  const offline = isOffline();
  const savable = Boolean(activeTab) && isSavablePage(activeTab.url);
  const remaining = savesLeft();
  const outOfSaves = remaining < 1;

  $("#save-progress").hidden = !capture;
  $("#collect-panel").hidden = !journey;
  $("#save-action").hidden = Boolean(capture || journey);
  $("#collect-start-button").hidden = Boolean(capture || journey);

  if (capture) renderProgressCard(capture);
  if (journey) renderCollectPanel(journey);

  const saveButton = $("#save-button");
  saveButton.disabled = Boolean(capture || journey) || offline || !savable || outOfSaves;
  saveButton.textContent = offline ? "You’re offline" : outOfSaves ? "No free saves left" : "Save page";
  // A save that finishes before the first refresh must not leave a spinner behind.
  if (!capture) setBusy(saveButton, false);
  $("#quota-upgrade-button").hidden = !outOfSaves || Boolean(capture || journey);

  const collectStart = $("#collect-start-button");
  collectStart.disabled = offline || !savable || outOfSaves;

  const inputsDisabled = Boolean(capture || journey);
  $("#save-folder-trigger").disabled = inputsDisabled;
  $("#depth-select").disabled = inputsDisabled;
  $("#run-scripts").disabled = inputsDisabled;
  $("#max-pages-per-pack").disabled = inputsDisabled || !isPaid();
  $("#max-bytes-per-pack").disabled = inputsDisabled || !isPaid();
  if (inputsDisabled) closeFolderMenu();

  if (!capture && !journey) {
    const failure = failedCapture();
    if (offline) setStatus("You’re offline. Your saved pages are ready in Library.");
    else if (!activeTab) setStatus("Open a page in this tab, then try again.", true);
    else if (!savable) setStatus("Chrome does not allow extensions to save its own pages.", true);
    else if (outOfSaves) setStatus(`You’ve used all ${monetization?.pricing?.freePagesPerMonth || 25} free saves this month.`, true);
    else if (failure && shownFailureId !== failure.id) {
      // Report an unfinished save once, then let newer messages take the slot.
      shownFailureId = failure.id;
      setStatus(failure.message || failure.error || "That save didn’t finish.", true);
    }
  }
}

function renderPlan() {
  const chip = $("#plan-chip");
  const summary = $("#plan-summary");
  if (!monetization) {
    chip.textContent = "Free";
    summary.textContent = "Checking your plan…";
    return;
  }
  const paid = isPaid();
  const freeLimit = Number(monetization.pricing?.freePagesPerMonth || 25);
  chip.replaceChildren(document.createTextNode(paid ? "Pro" : "Free"));
  const hint = document.createElement("span");
  hint.className = "visually-hidden";
  hint.textContent = paid ? " plan — manage PagePack Pro" : " plan — view PagePack Pro";
  chip.append(hint);
  chip.classList.toggle("is-pro", paid);
  summary.textContent = paid ? "Unlimited saves" : `${plural(savesLeft(), "save")} left this month`;
  summary.title = paid ? "PagePack Pro: unlimited page saves" : `${savesLeft()} of ${freeLimit} free saves left this month`;

  $("#pro-title").textContent = paid ? "You’re on Pro" : "Unlimited monthly saves";
  $("#pro-price").hidden = paid;
  $("#pro-price-alt").textContent = paid
    ? "Unlimited saves are active on this browser."
    : `or ${monetization.pricing?.yearlyPrice || "CAD $9.99/year"} — over half off`;
  $("#upgrade-button").hidden = paid;
  $("#manage-button").hidden = !paid;
  $("#restore-button").hidden = paid;
  $("#pack-limits-fields").hidden = !paid;
  $("#pack-limits-pro").hidden = paid;
  if (!paid && monetization.payment?.configured === false) {
    setProStatus("Checkout is not connected yet. Register the PagePack merchant account before selling Pro.");
  }
}

/* ------------------------------------------------------------------ *
 * Library
 * ------------------------------------------------------------------ */

function icon(kind) {
  const artwork = {
    page: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/>',
    journey: '<circle cx="6" cy="17.5" r="2"/><circle cx="12" cy="11.5" r="2"/><circle cx="18" cy="5.5" r="2"/><path d="m7.5 16 3-3m3-3 3-3"/>',
    folder: '<path d="M3.5 7.5h7l2-2h8v14h-17z"/>',
  };
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = artwork[kind] || artwork.page;
  return node;
}

function packMeta(pack) {
  const stats = pack.stats || {};
  const pages = Number(stats.pages) || pack.pages?.length || 1;
  const parts = [];
  if (pages > 1) parts.push(plural(pages, "page"));
  parts.push(formatBytes(stats.bytes));
  const date = formatDate(pack.savedAt);
  if (date) parts.push(date);
  return parts.join(" · ");
}

function matchesQuery(pack, query) {
  if (!query) return true;
  if (searchMatches?.has(pack.id)) return true;
  const haystack = [pack.title, pack.rootUrl, folderById(pack.folderId)?.name]
    .concat((pack.pages || []).flatMap((page) => [page.title, page.url]))
    .join(" ")
    .toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

function makeRow({ kind, id, iconKind, title, meta, issues }) {
  const row = document.createElement("div");
  row.className = `entry ${kind}-entry`;
  row.setAttribute("role", "listitem");
  row.dataset.itemKind = kind;
  row.dataset.itemId = id;

  const grip = document.createElement("button");
  grip.type = "button";
  grip.className = "entry-grip";
  grip.dataset.focusKey = `grip:${kind}:${id}`;
  if (searchQuery) {
    grip.disabled = true;
    grip.title = "Clear the search to reorder";
    grip.setAttribute("aria-label", `Reordering ${title} is unavailable while searching`);
  } else {
    grip.dataset.reorderEnabled = "true";
    grip.title = "Drag to reorder, or press Space and use the arrow keys";
    grip.setAttribute("aria-label", `Reorder ${title}`);
    grip.setAttribute("aria-keyshortcuts", "Space ArrowUp ArrowDown Home End Escape");
  }

  const open = document.createElement("button");
  open.type = "button";
  open.className = "entry-open";
  open.dataset.action = kind === "folder" ? `open-folder:${id}` : `open-pack:${id}`;
  open.dataset.focusKey = `open:${kind}:${id}`;
  const iconNode = document.createElement("span");
  iconNode.className = "entry-icon";
  iconNode.append(icon(iconKind));
  const copy = document.createElement("span");
  copy.className = "entry-copy";
  const titleNode = document.createElement("span");
  titleNode.className = "entry-title";
  titleNode.textContent = title;
  const metaNode = document.createElement("span");
  metaNode.className = "entry-meta";
  metaNode.textContent = meta;
  if (issues) {
    const issueNote = document.createElement("span");
    issueNote.className = "entry-issue";
    issueNote.textContent = `${plural(issues, "part")} missing`;
    metaNode.append(document.createTextNode(" · "), issueNote);
  }
  copy.append(titleNode, metaNode);
  open.append(iconNode, copy);
  open.setAttribute("aria-label", kind === "folder" ? `Open folder ${title}` : `Open ${title}`);
  open.title = title;

  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "entry-menu";
  menu.dataset.menuFor = `${kind}:${id}`;
  menu.dataset.focusKey = `menu:${kind}:${id}`;
  menu.setAttribute("aria-haspopup", "menu");
  menu.setAttribute("aria-expanded", String(menuRowId === `${kind}:${id}`));
  menu.setAttribute("aria-label", `More actions for ${title}`);
  menu.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/></svg>';

  row.append(grip, open, menu);
  return row;
}

function makeRenameRow(folder) {
  const row = document.createElement("div");
  row.className = "entry folder-entry is-renaming";
  row.setAttribute("role", "listitem");
  const form = document.createElement("form");
  form.className = "rename-form";
  form.dataset.renameFolder = folder.id;
  const label = document.createElement("label");
  label.className = "visually-hidden";
  label.setAttribute("for", "rename-folder-input");
  label.textContent = "Folder name";
  const input = document.createElement("input");
  input.id = "rename-folder-input";
  input.type = "text";
  input.value = folder.name;
  input.maxLength = 60;
  input.autocomplete = "off";
  input.dataset.focusKey = `rename:${folder.id}`;
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "small-primary";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "small-quiet";
  cancel.dataset.action = "cancel-rename";
  cancel.textContent = "Cancel";
  form.append(label, input, save, cancel);
  row.append(form);
  return row;
}

function appendPackPages(row, pack) {
  const panel = document.createElement("div");
  panel.className = "pages-panel";
  panel.id = `pages-${pack.id}`;
  (pack.pages || []).forEach((page, index) => {
    const pageRow = document.createElement("div");
    pageRow.className = "page-row";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "page-open";
    open.dataset.action = `open-pack-page:${pack.id}:${index}`;
    open.dataset.focusKey = `page:${pack.id}:${index}`;
    const number = document.createElement("span");
    number.className = "page-number";
    number.textContent = String(index + 1);
    const copy = document.createElement("span");
    copy.className = "page-copy";
    const title = document.createElement("span");
    title.className = "page-title";
    title.textContent = page.title || shortUrl(page.url) || "Saved page";
    const url = document.createElement("span");
    url.className = "page-url";
    url.textContent = shortUrl(page.url);
    copy.append(title, url);
    open.append(number, copy);
    open.title = page.url || "";
    pageRow.append(open);
    if (index > 0) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "page-remove";
      remove.dataset.action = `remove-pack-page:${pack.id}:${index}`;
      remove.dataset.focusKey = `page-remove:${pack.id}:${index}`;
      remove.setAttribute("aria-label", `Remove ${page.title || shortUrl(page.url)} from this save`);
      remove.title = "Remove from this save";
      remove.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>';
      pageRow.append(remove);
    }
    panel.append(pageRow);
  });
  row.append(panel);
  row.classList.add("is-expanded");
}

function setEmptyState(visible, title, help) {
  $("#library-empty").hidden = !visible;
  if (visible) {
    $("#empty-title").textContent = title;
    $("#empty-help").textContent = help;
  }
}

function renderLibrary() {
  const list = $("#library-list");
  closeRowMenu();
  const focusKey = document.activeElement?.dataset?.focusKey || null;
  const selectionStart = document.activeElement?.selectionStart ?? null;
  const folder = currentFolderId === ROOT_FOLDER ? null : folderById(currentFolderId);
  if (currentFolderId !== ROOT_FOLDER && !folder) currentFolderId = ROOT_FOLDER;

  $("#library-title").textContent = folder ? folder.name : "Library";
  $("#folder-back-button").hidden = !folder;
  $("#new-folder-button").hidden = Boolean(folder);
  $("#library-search").placeholder = folder ? "Search this folder" : "Search titles, sites, and text";

  const query = searchQuery;
  const visiblePacks = packsIn(folder ? folder.id : null).filter((pack) => matchesQuery(pack, query));
  const visibleFolders = folder
    ? []
    : sortedFolders().filter((item) => !query || item.name.toLowerCase().includes(query));

  $("#library-subtitle").hidden = Boolean(folder) || Boolean(query);
  const count = $("#library-count");
  if (query) {
    const total = visiblePacks.length + visibleFolders.length;
    count.textContent = total ? `${plural(total, "match", "matches")}` : "";
    count.hidden = !total;
  } else if (folder) {
    count.textContent = visiblePacks.length ? plural(visiblePacks.length, "saved page") : "";
    count.hidden = !visiblePacks.length;
  } else {
    count.hidden = true;
    count.textContent = "";
  }

  list.replaceChildren();
  visibleFolders.forEach((item) => {
    if (renamingFolderId === item.id) {
      list.append(makeRenameRow(item));
      return;
    }
    const contained = packs.filter((pack) => pack.folderId === item.id).length;
    list.append(makeRow({
      kind: "folder",
      id: item.id,
      iconKind: "folder",
      title: item.name,
      meta: contained ? plural(contained, "saved page") : "Empty",
    }));
  });
  visiblePacks.forEach((pack) => {
    const row = makeRow({
      kind: "pack",
      id: pack.id,
      iconKind: pack.captureMode === "journey" ? "journey" : "page",
      title: pack.title || shortUrl(pack.rootUrl),
      meta: packMeta(pack),
      issues: Number(pack.stats?.failed) || 0,
    });
    list.append(row);
    if (expandedPackId === pack.id) appendPackPages(row, pack);
  });

  const nothing = !visiblePacks.length && !visibleFolders.length;
  if (nothing && query) setEmptyState(true, "No matches", "Try a different word, or clear the search.");
  else if (nothing && folder) setEmptyState(true, "This folder is empty", "Move saves here from any item’s ⋯ menu.");
  else if (nothing) setEmptyState(true, "Nothing saved yet", "Open a page you want to keep, then choose Save.");
  else setEmptyState(false);

  $("#clear-search").hidden = !query;

  if (focusKey) {
    const restored = list.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (restored) {
      restored.focus({ preventScroll: true });
      if (selectionStart !== null && typeof restored.setSelectionRange === "function") {
        restored.setSelectionRange(selectionStart, selectionStart);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Row menu
 * ------------------------------------------------------------------ */

function closeRowMenu({ restoreFocus = false } = {}) {
  const menu = $("#row-menu");
  if (menu.hidden) return;
  menu.hidden = true;
  menu.replaceChildren();
  const trigger = menuRowId
    ? $("#library-list").querySelector(`[data-menu-for="${CSS.escape(menuRowId)}"]`)
    : null;
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger?.focus();
  menuRowId = null;
}

function menuItemsFor(kind, id) {
  if (kind === "folder") {
    const folder = folderById(id);
    if (!folder) return [];
    const contained = packs.filter((pack) => pack.folderId === id).length;
    return [
      { label: "Open folder", action: `open-folder:${id}` },
      { label: "Rename…", action: `rename-folder:${id}` },
      { label: "Delete folder…", action: `delete-folder:${id}`, danger: true, hint: contained ? plural(contained, "saved page") : "empty" },
    ];
  }
  const pack = packById(id);
  if (!pack) return [];
  const pages = pack.pages?.length || 0;
  const issues = Number(pack.stats?.failed) || 0;
  const items = [{ label: "Open", action: `open-pack:${id}` }];
  if (pages > 1) {
    items.push({
      label: expandedPackId === id ? "Hide pages" : `Show ${plural(pages, "page")}`,
      action: `toggle-pages:${id}`,
    });
  }
  if (issues) items.push({ label: `Review ${plural(issues, "missing part")}`, action: `show-issues:${id}` });
  if (folders.length) items.push({ label: "Move to…", action: `move-pack:${id}` });
  items.push({ label: "Delete…", action: `delete-pack:${id}`, danger: true });
  return items;
}

function openRowMenu(trigger) {
  const key = trigger.dataset.menuFor;
  if (menuRowId === key) {
    closeRowMenu({ restoreFocus: true });
    return;
  }
  closeRowMenu();
  const [kind, ...rest] = key.split(":");
  const items = menuItemsFor(kind, rest.join(":"));
  if (!items.length) return;
  const menu = $("#row-menu");
  menu.replaceChildren(...items.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `menu-item${item.danger ? " is-danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.dataset.action = item.action;
    const label = document.createElement("span");
    label.textContent = item.label;
    button.append(label);
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "menu-hint";
      hint.textContent = item.hint;
      button.append(hint);
    }
    return button;
  }));
  menuRowId = key;
  trigger.setAttribute("aria-expanded", "true");
  menu.hidden = false;
  const rect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8));
  const below = rect.bottom + 6;
  const top = below + menuRect.height > window.innerHeight - 8
    ? Math.max(8, rect.top - menuRect.height - 6)
    : below;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.querySelector(".menu-item")?.focus();
}

/* ------------------------------------------------------------------ *
 * Overlays
 * ------------------------------------------------------------------ */

function openOverlay(name, focusTarget) {
  const overlay = $(`#${name}-overlay`);
  if (!overlay || !overlay.hidden) return;
  overlayStack.push({ name, restoreFocus: document.activeElement });
  overlay.hidden = false;
  document.body.classList.add("is-overlay-open");
  requestAnimationFrame(() => {
    const target = typeof focusTarget === "string" ? overlay.querySelector(focusTarget) : focusTarget;
    (target || overlay.querySelector("button, input, [tabindex]"))?.focus();
  });
}

function closeOverlay(name) {
  const overlay = $(`#${name}-overlay`);
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  const index = overlayStack.findIndex((entry) => entry.name === name);
  const entry = index >= 0 ? overlayStack.splice(index, 1)[0] : null;
  if (!overlayStack.length) document.body.classList.remove("is-overlay-open");
  if (entry?.restoreFocus?.isConnected) entry.restoreFocus.focus();
}

function topOverlay() {
  return overlayStack.at(-1)?.name || null;
}

function trapFocus(event) {
  const name = topOverlay();
  if (!name) return;
  const overlay = $(`#${name}-overlay`);
  const focusable = [...overlay.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")]
    .filter((node) => !node.disabled && node.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!overlay.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

let confirmResolve = null;

function askConfirm({ title, body, confirmLabel = "Delete" }) {
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  $("#confirm-accept-button").textContent = confirmLabel;
  openOverlay("confirm", "#confirm-cancel-button");
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function settleConfirm(result) {
  const resolve = confirmResolve;
  confirmResolve = null;
  closeOverlay("confirm");
  resolve?.(result);
}

/* ------------------------------------------------------------------ *
 * Issue report
 * ------------------------------------------------------------------ */

function issueLabel(issue) {
  if (issue?.type === "page-limit") return "Page limit";
  if (issue?.type === "pack-limit") return "Size limit";
  if (issue?.type === "page") return "Page";
  const kind = String(issue?.kind || "").toLowerCase();
  if (kind === "style") return "Stylesheet";
  if (kind === "script") return "Script";
  if (kind === "media") return "Media";
  if (kind === "image") return "Image";
  return "File";
}

function issueReason(issue) {
  const message = String(issue?.message || "").trim();
  if (issue?.type === "page-limit" || issue?.type === "pack-limit") return message || "A safety limit was reached.";
  if (/HTTP\s+(401|403)\b/i.test(message)) return "The site refused access to this item.";
  const httpCode = message.match(/HTTP\s+\d{3}/i);
  if (httpCode) return `The site returned ${httpCode[0]}.`;
  if (/not an HTML page/i.test(message)) return "That link was not a web page.";
  if (/failed to fetch|network|timed out|timeout|name not resolved|connection/i.test(message)) {
    return "It didn’t respond in time, or the site blocked it.";
  }
  if (/blocked|cannot access|permission|protected/i.test(message)) return "Chrome or the site blocked access.";
  return message || "It couldn’t be saved.";
}

function isRetryable(issue) {
  if (issue?.type === "page") return /^https?:\/\//i.test(String(issue.url || ""));
  if (issue?.type === "resource") {
    return /^https?:\/\//i.test(String(issue.url || "")) && /^https?:\/\//i.test(String(issue.pageUrl || ""));
  }
  return false;
}

function renderIssueReport() {
  const issues = issueReport?.issues || [];
  const count = issues.length;
  $("#issues-title").textContent = count ? `${plural(count, "part")} missing` : "Nothing missing";
  $("#issues-summary").textContent = count
    ? `“${truncate(issueReport.title, 48)}” opens normally, but these pieces are not in the save.`
    : "Everything in this save is complete.";
  const list = $("#issues-list");
  list.replaceChildren();
  const shown = issues.slice(0, 60);
  shown.forEach((issue, index) => {
    const row = document.createElement("article");
    row.className = "issue-row";
    const head = document.createElement("p");
    head.className = "issue-head";
    const type = document.createElement("span");
    type.className = "issue-type";
    type.textContent = issueLabel(issue);
    const target = document.createElement("span");
    target.className = "issue-target";
    target.textContent = issue.type === "page-limit" || issue.type === "pack-limit"
      ? "Safety limit reached"
      : truncate(shortUrl(issue.url || issue.pageUrl), 64);
    target.title = issue.url || issue.pageUrl || "";
    head.append(type, target);
    const reason = document.createElement("p");
    reason.className = "issue-reason";
    reason.textContent = issueReason(issue);
    row.append(head, reason);
    const actions = document.createElement("div");
    actions.className = "issue-actions";
    if (isRetryable(issue)) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "small-quiet";
      retry.dataset.issueAction = `retry:${index}`;
      retry.textContent = "Try again";
      actions.append(retry);
    }
    const ignore = document.createElement("button");
    ignore.type = "button";
    ignore.className = "small-quiet";
    ignore.dataset.issueAction = `ignore:${index}`;
    ignore.textContent = "Dismiss";
    actions.append(ignore);
    row.append(actions);
    list.append(row);
  });
  if (issues.length > shown.length) {
    const more = document.createElement("p");
    more.className = "issues-more";
    more.textContent = `and ${issues.length - shown.length} more`;
    list.append(more);
  }
  const retryable = issues.some(isRetryable);
  $("#retry-all-issues-button").hidden = !retryable;
  $("#ignore-all-issues-button").hidden = !count;
}

async function openIssueReport(packId) {
  const pack = packById(packId);
  if (!pack) return;
  issueReport = { id: packId, title: pack.title || shortUrl(pack.rootUrl), issues: [] };
  renderIssueReport();
  openOverlay("issues", "#close-issues-button");
  try {
    const { issues } = await sendMessage({ type: "GET_PACK_ISSUES", packId });
    if (issueReport?.id !== packId) return;
    issueReport.issues = Array.isArray(issues) ? issues : [];
    renderIssueReport();
  } catch (error) {
    $("#issues-summary").textContent = error.message;
  }
}

async function refreshIssueReport() {
  if (!issueReport) return;
  await loadLibrary({ force: true });
  const { issues } = await sendMessage({ type: "GET_PACK_ISSUES", packId: issueReport.id }).catch(() => ({ issues: [] }));
  if (!issueReport) return;
  issueReport.issues = Array.isArray(issues) ? issues : [];
  renderIssueReport();
  if (!issueReport.issues.length) closeOverlay("issues");
}

async function handleIssueAction(action, button) {
  const [kind, indexValue] = String(action).split(":");
  const issueIndex = Number(indexValue);
  if (!issueReport || !Number.isInteger(issueIndex)) return;
  button.disabled = true;
  setBusy(button, true);
  try {
    await sendMessage({
      type: kind === "retry" ? "RETRY_PACK_ISSUE" : "IGNORE_PACK_ISSUE",
      packId: issueReport.id,
      issueIndex,
    });
    await refreshIssueReport();
  } catch (error) {
    setBusy(button, false);
    button.disabled = false;
    $("#issues-summary").textContent = error.message;
    await refreshIssueReport();
  }
}

async function retryAllIssues() {
  if (!issueReport) return;
  const button = $("#retry-all-issues-button");
  button.disabled = true;
  setBusy(button, true);
  const attempted = new Set();
  try {
    for (let round = 0; round < 60; round += 1) {
      const target = issueReport.issues.findIndex((issue) => isRetryable(issue)
        && !attempted.has(`${issue.type}|${issue.url}|${issue.pageUrl || ""}`));
      if (target < 0) break;
      const issue = issueReport.issues[target];
      attempted.add(`${issue.type}|${issue.url}|${issue.pageUrl || ""}`);
      await sendMessage({ type: "RETRY_PACK_ISSUE", packId: issueReport.id, issueIndex: target }).catch(() => {});
      const { issues } = await sendMessage({ type: "GET_PACK_ISSUES", packId: issueReport.id }).catch(() => ({ issues: [] }));
      if (!issueReport) return;
      issueReport.issues = Array.isArray(issues) ? issues : [];
      renderIssueReport();
    }
    await loadLibrary({ force: true });
    if (issueReport && !issueReport.issues.length) closeOverlay("issues");
  } finally {
    setBusy(button, false);
    button.disabled = false;
  }
}

async function dismissAllIssues() {
  if (!issueReport) return;
  const button = $("#ignore-all-issues-button");
  button.disabled = true;
  try {
    await sendMessage({ type: "IGNORE_ALL_PACK_ISSUES", packId: issueReport.id });
    await refreshIssueReport();
  } catch (error) {
    $("#issues-summary").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Move to folder
 * ------------------------------------------------------------------ */

let movePackId = null;

function openMoveSheet(packId) {
  const pack = packById(packId);
  if (!pack) return;
  movePackId = packId;
  $("#move-summary").textContent = `Choose where “${truncate(pack.title || shortUrl(pack.rootUrl), 40)}” lives.`;
  const list = $("#move-list");
  const destinations = [{ id: "", name: "Library" }, ...sortedFolders()];
  list.replaceChildren(...destinations.map((folder) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "menu-item";
    option.setAttribute("role", "option");
    const current = (pack.folderId || "") === (folder.id || "");
    option.setAttribute("aria-selected", String(current));
    option.dataset.moveTo = folder.id || "";
    const name = document.createElement("span");
    name.textContent = folder.name;
    const check = document.createElement("span");
    check.className = "menu-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";
    option.append(name, check);
    return option;
  }));
  openOverlay("move", '[aria-selected="true"]');
}

async function movePackToFolder(packId, folderId) {
  const pack = packById(packId);
  const target = folderId || null;
  if (!pack || (pack.folderId || null) === target) return;
  const previous = packs;
  const sourceOrder = new Map(packsIn(pack.folderId || null)
    .filter((item) => item.id !== packId)
    .map((item, index) => [item.id, index]));
  const targetOrder = new Map([pack, ...packsIn(target)].map((item, index) => [item.id, index]));
  packs = packs.map((item) => {
    if (targetOrder.has(item.id)) return { ...item, folderId: target, sortOrder: targetOrder.get(item.id) };
    if (sourceOrder.has(item.id)) return { ...item, sortOrder: sourceOrder.get(item.id) };
    return item;
  });
  libraryMutationInFlight = true;
  renderLibrary();
  setStatus(`Moved to ${target ? folderName(target) : "Library"}.`);
  try {
    await sendMessage({ type: "MOVE_PACK", id: packId, folderId: target });
  } catch (error) {
    packs = previous;
    renderLibrary();
    throw error;
  } finally {
    libraryMutationInFlight = false;
  }
}

/* ------------------------------------------------------------------ *
 * Reordering (pointer and keyboard)
 * ------------------------------------------------------------------ */

const DRAG_START_DISTANCE = 5;
const AUTO_SCROLL_EDGE = 56;
const AUTO_SCROLL_MAX_SPEED = 14;

const REORDER_KINDS = Object.freeze({
  pack: {
    noun: "saved page",
    selector: '.entry[data-item-kind="pack"]',
    fallbackReference: () => null,
    applyLocalOrder(orderedIds) {
      const folderId = currentFolderId === ROOT_FOLDER ? null : currentFolderId;
      const indexById = new Map(orderedIds.map((id, index) => [id, index]));
      packs = packs.map((pack) => indexById.has(pack.id)
        ? { ...pack, folderId, sortOrder: indexById.get(pack.id) }
        : pack);
    },
    persist(sourceId, orderedIds) {
      const folderId = currentFolderId === ROOT_FOLDER ? null : currentFolderId;
      return sendMessage({ type: "MOVE_AND_REORDER_PACK", id: sourceId, folderId, orderedIds });
    },
  },
  folder: {
    noun: "folder",
    selector: '.entry[data-item-kind="folder"]',
    fallbackReference: () => $("#library-list").querySelector('.entry[data-item-kind="pack"]'),
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

let dragSession = null;
let dropTarget = null;
let autoScrollFrame = 0;
const reorderAnimations = new Map();

function announce(message) {
  const node = $("#reorder-status");
  node.textContent = "";
  requestAnimationFrame(() => { node.textContent = message || ""; });
}

function rowTitle(row) {
  return row.querySelector(".entry-title")?.textContent || "Item";
}

function orderOf(kind) {
  return [...$("#library-list").querySelectorAll(REORDER_KINDS[kind].selector)].map((row) => row.dataset.itemId);
}

function sameOrder(first, second) {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

function cancelReorderAnimations() {
  reorderAnimations.forEach((animation) => animation.cancel());
  reorderAnimations.clear();
}

function prefersReducedMotion() {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function animateMutation(mutate) {
  const rows = [...$("#library-list").querySelectorAll(".entry")];
  const before = new Map(rows.map((row) => [row, row.getBoundingClientRect()]));
  cancelReorderAnimations();
  mutate();
  if (prefersReducedMotion()) return;
  rows.forEach((row) => {
    if (!row.isConnected || typeof row.animate !== "function") return;
    const from = before.get(row);
    const to = row.getBoundingClientRect();
    const deltaY = from.top - to.top;
    if (Math.abs(deltaY) < 0.5) return;
    const animation = row.animate(
      [{ transform: `translateY(${deltaY}px)` }, { transform: "translateY(0)" }],
      { duration: 150, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
    reorderAnimations.set(row, animation);
    animation.onfinish = animation.oncancel = () => {
      if (reorderAnimations.get(row) === animation) reorderAnimations.delete(row);
    };
  });
}

function insertBefore(list, node, reference) {
  if (reference ? node.nextElementSibling === reference : node === list.lastElementChild) return;
  animateMutation(() => list.insertBefore(node, reference));
}

function setDropTarget(row) {
  if (dropTarget === row) return;
  dropTarget?.classList.remove("is-drop-target");
  dropTarget = row || null;
  dropTarget?.classList.add("is-drop-target");
}

function positionGhost(session) {
  session.row.style.transform =
    `translate3d(${Math.round(session.lastX - session.offsetX)}px, ${Math.round(session.lastY - session.offsetY)}px, 0)`;
}

function placePlaceholder(session) {
  const list = $("#library-list");
  const kind = REORDER_KINDS[session.kind];
  const siblings = [...list.querySelectorAll(kind.selector)];
  const target = siblings.find((row) => {
    const rect = row.getBoundingClientRect();
    return session.lastY < rect.top + rect.height / 2;
  });
  insertBefore(list, session.placeholder, target || kind.fallbackReference());
}

function updateDropState(session) {
  const list = $("#library-list");
  const element = document.elementFromPoint(session.lastX, session.lastY);
  const row = element?.closest?.(".entry");
  const hovered = row && list.contains(row) ? row : null;
  if (session.kind === "pack" && hovered?.dataset.itemKind === "folder") {
    setDropTarget(hovered);
    session.folderTarget = hovered;
    session.validDrop = true;
    session.row.classList.remove("is-invalid-drop");
    if (session.announcedTarget !== hovered.dataset.itemId) {
      session.announcedTarget = hovered.dataset.itemId;
      announce(`Move into ${rowTitle(hovered)}`);
    }
    return;
  }
  setDropTarget(null);
  session.folderTarget = null;
  session.announcedTarget = null;
  const rect = list.getBoundingClientRect();
  const panel = scroller().getBoundingClientRect();
  const inside = session.lastX >= rect.left - 12 && session.lastX <= rect.right + 12
    && session.lastY >= Math.max(panel.top, rect.top - 24)
    && session.lastY <= Math.min(panel.bottom, rect.bottom + 24);
  session.validDrop = inside && !(hovered && hovered.dataset.itemKind !== session.kind);
  session.row.classList.toggle("is-invalid-drop", !session.validDrop);
  if (session.validDrop) placePlaceholder(session);
}

// The list scrolls inside the view panel, not the window.
function scroller() {
  return document.querySelector(".view-panel");
}

function scrollSpeedAt(clientY) {
  const rect = scroller().getBoundingClientRect();
  const fromTop = clientY - rect.top;
  const fromBottom = rect.bottom - clientY;
  if (fromTop < AUTO_SCROLL_EDGE) return -AUTO_SCROLL_MAX_SPEED * (1 - Math.max(0, fromTop) / AUTO_SCROLL_EDGE);
  if (fromBottom < AUTO_SCROLL_EDGE) return AUTO_SCROLL_MAX_SPEED * (1 - Math.max(0, fromBottom) / AUTO_SCROLL_EDGE);
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
    scroller().scrollBy(0, speed);
    updateDropState(session);
    autoScrollFrame = requestAnimationFrame(tick);
  };
  if (scrollSpeedAt(dragSession.lastY)) autoScrollFrame = requestAnimationFrame(tick);
}

function beginPointerDrag(session) {
  const rect = session.row.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = "entry reorder-placeholder";
  placeholder.style.height = `${rect.height}px`;
  placeholder.setAttribute("aria-hidden", "true");
  session.placeholder = placeholder;
  session.offsetX = session.startX - rect.left;
  session.offsetY = session.startY - rect.top;
  session.phase = "active";
  session.validDrop = true;
  session.row.replaceWith(placeholder);
  document.body.append(session.row);
  session.row.classList.add("is-dragging", "drag-ghost");
  session.row.style.width = `${rect.width}px`;
  session.row.style.height = `${rect.height}px`;
  document.body.classList.add("is-reordering");
  positionGhost(session);
  updateDropState(session);
  announce(`Moving ${rowTitle(session.row)}`);
}

function releasePointer(session) {
  try {
    if (session.grip.hasPointerCapture?.(session.pointerId)) session.grip.releasePointerCapture(session.pointerId);
  } catch {
    // Chrome can release capture first when the pointer leaves the popup.
  }
}

function resetPointerDrag(session, restoreOrder) {
  stopAutoScroll();
  cancelReorderAnimations();
  setDropTarget(null);
  session.row.classList.remove("is-dragging", "drag-ghost", "is-invalid-drop");
  session.row.style.removeProperty("width");
  session.row.style.removeProperty("height");
  session.row.style.removeProperty("transform");
  if (session.placeholder?.isConnected) session.placeholder.replaceWith(session.row);
  if (restoreOrder) session.startRows.forEach((row) => $("#library-list").append(row));
  document.body.classList.remove("is-reordering");
  releasePointer(session);
}

function cancelPointerDrag(message = "Reorder cancelled") {
  const session = dragSession;
  if (!session || session.mode !== "pointer") return;
  dragSession = null;
  if (session.phase === "active") resetPointerDrag(session, true);
  else releasePointer(session);
  if (session.phase === "active") announce(message);
}

function finishPointerDrag() {
  const session = dragSession;
  if (!session || session.mode !== "pointer") return;
  if (session.phase !== "active") {
    dragSession = null;
    releasePointer(session);
    return;
  }
  if (!session.validDrop) return cancelPointerDrag();
  const folderTarget = session.folderTarget;
  dragSession = null;
  resetPointerDrag(session, false);
  if (folderTarget) {
    announce(`Moved ${rowTitle(session.row)} into ${rowTitle(folderTarget)}`);
    movePackToFolder(session.id, folderTarget.dataset.itemId).catch(reportError);
    return;
  }
  const ordered = orderOf(session.kind);
  if (sameOrder(ordered, session.startOrder)) return announce("Order unchanged");
  announce(`${rowTitle(session.row)} moved`);
  persistOrder(session.kind, session.id, ordered).catch(reportError);
}

function onGripPointerDown(event) {
  const grip = event.target.closest('.entry-grip[data-reorder-enabled="true"]');
  if (!grip || libraryMutationInFlight || event.button !== 0 || event.isPrimary === false) return;
  if (dragSession?.mode === "keyboard") cancelKeyboardDrag();
  if (dragSession) return;
  closeRowMenu();
  const row = grip.closest(".entry");
  const kind = row.dataset.itemKind;
  dragSession = {
    mode: "pointer",
    phase: "pending",
    pointerId: event.pointerId,
    grip,
    row,
    kind,
    id: row.dataset.itemId,
    startRows: [...$("#library-list").querySelectorAll(".entry")],
    startOrder: orderOf(kind),
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
  };
  try { grip.setPointerCapture(event.pointerId); } catch { /* capture is best effort */ }
  event.preventDefault();
}

function onPointerMove(event) {
  const session = dragSession;
  if (!session || session.mode !== "pointer" || event.pointerId !== session.pointerId) return;
  session.lastX = event.clientX;
  session.lastY = event.clientY;
  if (session.phase === "pending") {
    if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < DRAG_START_DISTANCE) return;
    beginPointerDrag(session);
  } else {
    positionGhost(session);
    updateDropState(session);
  }
  continueAutoScroll();
  event.preventDefault();
}

function onPointerUp(event) {
  const session = dragSession;
  if (!session || session.mode !== "pointer" || event.pointerId !== session.pointerId) return;
  session.lastX = event.clientX;
  session.lastY = event.clientY;
  if (session.phase === "active") updateDropState(session);
  finishPointerDrag();
  event.preventDefault();
}

function keyboardPosition(session) {
  const rows = [...$("#library-list").querySelectorAll(REORDER_KINDS[session.kind].selector)];
  return `${rowTitle(session.row)}, position ${rows.indexOf(session.row) + 1} of ${rows.length}`;
}

function startKeyboardDrag(grip) {
  const row = grip.closest(".entry");
  const kind = row.dataset.itemKind;
  dragSession = {
    mode: "keyboard",
    grip,
    row,
    kind,
    id: row.dataset.itemId,
    startRows: [...$("#library-list").querySelectorAll(".entry")],
    startOrder: orderOf(kind),
  };
  row.classList.add("is-dragging");
  grip.setAttribute("aria-pressed", "true");
  announce(`Picked up ${keyboardPosition(dragSession)}. Arrow keys move it, Space drops it, Escape cancels.`);
}

function moveKeyboardDrag(key) {
  const session = dragSession;
  const list = $("#library-list");
  const rows = [...list.querySelectorAll(REORDER_KINDS[session.kind].selector)];
  const index = rows.indexOf(session.row);
  let reference;
  if (key === "ArrowUp" && index > 0) reference = rows[index - 1];
  else if (key === "ArrowDown" && index < rows.length - 1) reference = rows[index + 1].nextElementSibling;
  else if (key === "Home" && index > 0) reference = rows[0];
  else if (key === "End" && index < rows.length - 1) reference = rows.at(-1).nextElementSibling;
  else return;
  insertBefore(list, session.row, reference || REORDER_KINDS[session.kind].fallbackReference());
  announce(keyboardPosition(session));
}

function clearKeyboardDrag(session) {
  session.row.classList.remove("is-dragging");
  session.grip.removeAttribute("aria-pressed");
}

function focusGrip(kind, id) {
  requestAnimationFrame(() => {
    $("#library-list").querySelector(`[data-focus-key="${CSS.escape(`grip:${kind}:${id}`)}"]`)?.focus();
  });
}

function commitKeyboardDrag() {
  const session = dragSession;
  if (!session || session.mode !== "keyboard") return;
  dragSession = null;
  clearKeyboardDrag(session);
  const ordered = orderOf(session.kind);
  if (sameOrder(ordered, session.startOrder)) return announce("Order unchanged");
  announce(`${rowTitle(session.row)} moved`);
  persistOrder(session.kind, session.id, ordered, true).catch(reportError);
}

function cancelKeyboardDrag() {
  const session = dragSession;
  if (!session || session.mode !== "keyboard") return;
  dragSession = null;
  animateMutation(() => session.startRows.forEach((row) => $("#library-list").append(row)));
  clearKeyboardDrag(session);
  announce("Reorder cancelled");
  session.grip.focus();
}

function onGripKeyDown(event) {
  const grip = event.target.closest('.entry-grip[data-reorder-enabled="true"]');
  if (!grip) return;
  const active = dragSession?.mode === "keyboard" && dragSession.grip === grip;
  if (!active && [" ", "Enter"].includes(event.key)) {
    if (libraryMutationInFlight || dragSession) return;
    event.preventDefault();
    startKeyboardDrag(grip);
    return;
  }
  if (!active) return;
  if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    moveKeyboardDrag(event.key);
  } else if ([" ", "Enter"].includes(event.key)) {
    event.preventDefault();
    commitKeyboardDrag();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelKeyboardDrag();
  }
}

async function persistOrder(kind, sourceId, orderedIds, restoreFocus = false) {
  const adapter = REORDER_KINDS[kind];
  if (!adapter || !orderedIds.length) return;
  const previousPacks = packs;
  const previousFolders = folders;
  adapter.applyLocalOrder(orderedIds);
  libraryMutationInFlight = true;
  if (kind === "folder") renderFolderPicker();
  renderLibrary();
  if (restoreFocus) focusGrip(kind, sourceId);
  try {
    await adapter.persist(sourceId, orderedIds);
  } catch (error) {
    packs = previousPacks;
    folders = previousFolders;
    if (kind === "folder") renderFolderPicker();
    renderLibrary();
    if (restoreFocus) focusGrip(kind, sourceId);
    throw error;
  } finally {
    libraryMutationInFlight = false;
  }
}

/* ------------------------------------------------------------------ *
 * Data loading
 * ------------------------------------------------------------------ */

function signatureOf() {
  return JSON.stringify([
    packs.map((pack) => [pack.id, pack.title, pack.folderId, pack.sortOrder, pack.savedAt,
      pack.stats?.pages, pack.stats?.bytes, pack.stats?.failed, pack.pages?.length]),
    folders.map((folder) => [folder.id, folder.name, folder.sortOrder]),
    captures.map((capture) => [capture.id, capture.state, capture.message,
      capture.pagesDone, capture.pagesTotal, capture.assetsDone, capture.assetsTotal]),
    journeys.map((journey) => [journey.id, journey.state, journey.message, journey.pageCount,
      journey.savedCount, journey.pendingCount, journey.failedCount,
      (journey.pageTitles || []).map((page) => `${page.url}:${page.state}`)]),
  ]);
}

async function loadLibrary({ force = false } = {}) {
  if (dragSession || libraryMutationInFlight) {
    scheduleRefresh();
    return;
  }
  let result;
  try {
    result = await sendMessage({ type: "LIST_LIBRARY" });
  } catch (error) {
    reportError(error);
    return;
  }
  if (dragSession || libraryMutationInFlight) return;
  packs = Array.isArray(result.packs) ? result.packs : [];
  folders = Array.isArray(result.folders) ? result.folders : [];
  captures = Array.isArray(result.captures) ? result.captures : [];
  journeys = Array.isArray(result.journeys) ? result.journeys : [];
  const signature = signatureOf();
  if (!force && signature === librarySignature) {
    scheduleRefresh();
    return;
  }
  librarySignature = signature;
  if (expandedPackId && !packById(expandedPackId)) expandedPackId = null;
  renderFolderPicker();
  renderLibrary();
  renderSaveView();
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!hasActiveWork()) return;
  refreshTimer = setTimeout(() => { loadLibrary().catch(() => {}); }, 1200);
}

async function refreshPlan(refresh = false, trigger = null) {
  setBusy(trigger, true);
  if (trigger) trigger.disabled = true;
  try {
    const { state } = await sendMessage({ type: "GET_MONETIZATION", refresh });
    monetization = state;
    renderPlan();
    renderSaveView();
    if (refresh) {
      setProStatus(monetization.payment?.configured === false
        ? "Checkout is not connected yet. Register the PagePack merchant account before selling Pro."
        : isPaid() ? "Pro is active on this browser." : "Plan status is up to date.");
    }
  } catch (error) {
    if (!monetization) $("#plan-summary").textContent = "Plan unavailable offline";
    setProStatus(error.message, true);
  } finally {
    setBusy(trigger, false);
    if (trigger) trigger.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

function showView(name) {
  if (dragSession?.mode === "keyboard") cancelKeyboardDrag();
  if (dragSession?.mode === "pointer") cancelPointerDrag();
  closeRowMenu();
  const saveActive = name === "save";
  $("#save-view").hidden = !saveActive;
  $("#library-view").hidden = saveActive;
  [["#save-tab", saveActive], ["#library-tab", !saveActive]].forEach(([selector, active]) => {
    const tab = $(selector);
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  if (!saveActive) renderLibrary();
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function openViewer(packId, pageIndex = 0) {
  const url = chrome.runtime.getURL(`viewer.html?pack=${encodeURIComponent(packId)}&page=${Math.max(0, Number(pageIndex) || 0)}`);
  chrome.tabs.create({ url });
  window.close();
}

function captureRequest() {
  return {
    tabId: activeTab.id,
    pageUrl: activeTab.url,
    pageTitle: activeTab.title,
    runScripts: $("#run-scripts").checked,
    folderId: $("#save-folder").value || null,
    maxPages: Number($("#max-pages-per-pack").value),
    maxTotalBytes: Number($("#max-bytes-per-pack").value),
  };
}

function canStartCapture() {
  if (isOffline()) {
    showView("library");
    setStatus("You’re offline. Your saved pages are ready in Library.");
    return false;
  }
  if (!activeTab || !Number.isInteger(activeTab.id)) {
    setStatus("This tab is unavailable. Close and reopen PagePack.", true);
    return false;
  }
  if (!isSavablePage(activeTab.url)) {
    setStatus("Chrome does not allow extensions to save its own pages.", true);
    return false;
  }
  return true;
}

async function savePage() {
  if (!canStartCapture()) return;
  const button = $("#save-button");
  button.disabled = true;
  setBusy(button, true);
  setStatus("Starting…");
  try {
    const response = await sendMessage({
      type: "START_CAPTURE",
      depth: Number($("#depth-select").value) || 0,
      ...captureRequest(),
    });
    if (!response.accepted) throw new Error("The save did not start.");
    cancelRequestId = null;
    setStatus("");
    await loadLibrary({ force: true });
  } catch (error) {
    setBusy(button, false);
    reportError(error);
    renderSaveView();
  }
}

async function startCollecting() {
  if (!canStartCapture()) return;
  const button = $("#collect-start-button");
  button.disabled = true;
  setBusy(button, true);
  setStatus("Starting…");
  try {
    const response = await sendMessage({ type: "START_JOURNEY", ...captureRequest() });
    if (!response.accepted) throw new Error("Collecting did not start.");
    setStatus("Collecting. Browse as usual, then come back and save.");
    await loadLibrary({ force: true });
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(button, false);
    renderSaveView();
  }
}

async function cancelSave() {
  const capture = activeCapture();
  if (!capture || cancelRequestId) return;
  cancelRequestId = capture.id;
  renderSaveView();
  try {
    await sendMessage({ type: "CANCEL_CAPTURE", requestId: capture.id });
  } catch (error) {
    cancelRequestId = null;
    reportError(error);
    await loadLibrary({ force: true });
  }
}

function keepablePages(journey) {
  return (journey.pageTitles || []).filter((page) => page.state !== "failed");
}

function openReviewSheet(journey) {
  const pages = journey.pageTitles || [];
  const pending = pages.filter((page) => PENDING_PAGE_STATES.has(page.state)).length;
  const failed = pages.filter((page) => page.state === "failed").length;
  const details = [
    pending ? `${pending} still saving` : null,
    failed ? `${failed} couldn’t be saved` : null,
  ].filter(Boolean);
  $("#review-summary").textContent = `${plural(pages.length, "page")} collected${details.length ? ` · ${details.join(" · ")}` : ""}. Uncheck anything you don’t need — the first page always stays.`;
  const list = $("#review-list");
  list.replaceChildren(...pages.map((page, index) => {
    const row = document.createElement("label");
    row.className = "review-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = page.state !== "failed";
    checkbox.dataset.pageUrl = page.url || "";
    const first = index === 0;
    const failedPage = page.state === "failed";
    // The first page anchors the collection and failed pages hold nothing, so
    // both stay locked even after the sheet leaves its busy state.
    checkbox.disabled = first || failedPage;
    if (checkbox.disabled) checkbox.dataset.locked = "true";
    if (first) row.classList.add("is-required");
    if (failedPage) row.classList.add("is-disabled");
    const copy = document.createElement("span");
    copy.className = "review-copy";
    const title = document.createElement("span");
    title.className = "review-title";
    title.textContent = page.title || shortUrl(page.url) || "Saved page";
    const note = document.createElement("span");
    note.className = "review-note";
    note.textContent = failedPage
      ? "Couldn’t be saved"
      : first
        ? "First page · always kept"
        : PENDING_PAGE_STATES.has(page.state) ? "Still saving" : shortUrl(page.url);
    copy.append(title, note);
    row.append(checkbox, copy);
    return row;
  }));
  setReviewBusy(false);
  openOverlay("review", "#save-reviewed-button");
}

function setReviewBusy(busy) {
  reviewBusy = busy;
  const overlay = $("#review-overlay");
  overlay.setAttribute("aria-busy", String(busy));
  overlay.querySelectorAll("button").forEach((control) => { control.disabled = busy; });
  overlay.querySelectorAll("input").forEach((control) => {
    control.disabled = busy || control.dataset.locked === "true";
  });
  const save = $("#save-reviewed-button");
  save.textContent = busy ? "Saving…" : "Save selected pages";
  setBusy(save, busy);
}

function finishCollecting() {
  const journey = activeJourney();
  if (!journey || journey.state !== "recording" || reviewBusy) return;
  const keepable = keepablePages(journey);
  if (!keepable.length) {
    setStatus("Nothing has been collected yet. Keep browsing, then try again.", true);
    return;
  }
  if (keepable.length === 1 && journey.pageTitles?.length === 1) {
    saveCollection([]).catch(reportError);
    return;
  }
  openReviewSheet(journey);
}

async function saveCollection(excludedUrls) {
  const journey = activeJourney();
  if (!journey || journey.state !== "recording" || reviewBusy) return;
  setReviewBusy(true);
  renderSaveView();
  setStatus("Saving your collection…");
  try {
    const response = await sendMessage({ type: "FINISH_JOURNEY", journeyId: journey.id, excludedUrls });
    if (response.empty) throw new Error("None of those pages could be saved.");
    setReviewBusy(false);
    closeOverlay("review");
    await Promise.all([loadLibrary({ force: true }), refreshPlan(false)]);
    setStatus("Saved to your library.");
  } catch (error) {
    setReviewBusy(false);
    closeOverlay("review");
    reportError(error);
    await loadLibrary({ force: true });
  }
}

function saveReviewedCollection() {
  if (reviewBusy) return;
  const excludedUrls = [...$("#review-list").querySelectorAll("input:not(:checked):not(:disabled)")]
    .map((input) => input.dataset.pageUrl)
    .filter(Boolean);
  saveCollection(excludedUrls).catch(reportError);
}

async function discardCollection() {
  const journey = activeJourney();
  if (!journey || reviewBusy) return;
  const confirmed = await askConfirm({
    title: "Discard this collection?",
    body: `${plural(Number(journey.pageCount) || 0, "collected page")} will be thrown away. Nothing is added to your library.`,
    confirmLabel: "Discard",
  });
  if (!confirmed) return;
  try {
    await sendMessage({ type: "DISCARD_JOURNEY", journeyId: journey.id });
    setStatus("Collection discarded.");
    await loadLibrary({ force: true });
  } catch (error) {
    reportError(error);
  }
}

async function createFolder(event) {
  event.preventDefault();
  const input = $("#new-folder-name");
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  const name = input.value.trim();
  if (!name) return input.focus();
  input.disabled = true;
  submit.disabled = true;
  setBusy(submit, true);
  try {
    const { folder } = await sendMessage({ type: "CREATE_FOLDER", name });
    folders = [...folders, folder];
    librarySignature = "";
    input.value = "";
    $("#new-folder-form").hidden = true;
    renderFolderPicker();
    renderLibrary();
    $("#new-folder-button").focus();
  } catch (error) {
    reportError(error);
  } finally {
    input.disabled = false;
    submit.disabled = false;
    setBusy(submit, false);
  }
}

async function renameFolder(id, name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return;
  const previous = folders;
  folders = folders.map((folder) => folder.id === id ? { ...folder, name: trimmed } : folder);
  renamingFolderId = null;
  librarySignature = "";
  renderFolderPicker();
  renderLibrary();
  try {
    await sendMessage({ type: "RENAME_FOLDER", id, name: trimmed });
  } catch (error) {
    folders = previous;
    renderFolderPicker();
    renderLibrary();
    reportError(error);
  }
}

async function deletePack(id) {
  const pack = packById(id);
  if (!pack || libraryMutationInFlight) return;
  const confirmed = await askConfirm({
    title: "Delete this save?",
    body: `“${truncate(pack.title || shortUrl(pack.rootUrl), 60)}” will be removed from this device. This cannot be undone.`,
  });
  if (!confirmed) return;
  const previous = packs;
  libraryMutationInFlight = true;
  packs = packs.filter((item) => item.id !== id);
  if (expandedPackId === id) expandedPackId = null;
  librarySignature = "";
  renderLibrary();
  setStatus("Save deleted.");
  try {
    await sendMessage({ type: "DELETE_PACK", id });
  } catch (error) {
    packs = previous;
    renderLibrary();
    reportError(error);
  } finally {
    libraryMutationInFlight = false;
    loadLibrary({ force: true }).catch(() => {});
  }
}

async function deleteFolder(id) {
  const folder = folderById(id);
  if (!folder || libraryMutationInFlight) return;
  const contained = packs.filter((pack) => pack.folderId === id).length;
  const confirmed = await askConfirm({
    title: `Delete “${truncate(folder.name, 40)}”?`,
    body: contained
      ? `${plural(contained, "saved page")} inside will also be deleted. This cannot be undone.`
      : "The folder is empty, so nothing else is removed.",
  });
  if (!confirmed) return;
  const previousFolders = folders;
  const previousPacks = packs;
  const previousFolderId = currentFolderId;
  libraryMutationInFlight = true;
  folders = folders.filter((item) => item.id !== id);
  packs = packs.filter((pack) => pack.folderId !== id);
  if (currentFolderId === id) currentFolderId = ROOT_FOLDER;
  librarySignature = "";
  renderFolderPicker();
  renderLibrary();
  setStatus(contained ? `Folder and ${plural(contained, "saved page")} deleted.` : "Folder deleted.");
  try {
    await sendMessage({ type: "DELETE_FOLDER", id });
  } catch (error) {
    folders = previousFolders;
    packs = previousPacks;
    currentFolderId = previousFolderId;
    renderFolderPicker();
    renderLibrary();
    reportError(error);
  } finally {
    libraryMutationInFlight = false;
    loadLibrary({ force: true }).catch(() => {});
  }
}

async function removeCapturedPage(packId, pageIndex) {
  if (libraryMutationInFlight) return;
  const pack = packById(packId);
  if (!pack || !Number.isInteger(pageIndex) || pageIndex < 1) return;
  const previous = packs;
  const optimistic = {
    ...pack,
    pages: [...(pack.pages || [])],
    stats: { ...(pack.stats || {}) },
  };
  try {
    removePackPageFromPack(optimistic, pageIndex);
  } catch (error) {
    return reportError(error);
  }
  libraryMutationInFlight = true;
  packs = packs.map((item) => item.id === packId ? optimistic : item);
  librarySignature = "";
  renderLibrary();
  setStatus("Page removed from this save.");
  try {
    await sendMessage({ type: "REMOVE_PACK_PAGE", id: packId, pageIndex });
  } catch (error) {
    packs = previous;
    renderLibrary();
    reportError(error);
  } finally {
    libraryMutationInFlight = false;
    loadLibrary({ force: true }).catch(() => {});
  }
}

async function handleAction(action) {
  const [kind, ...rest] = action.split(":");
  const id = rest.join(":");
  if (kind === "open-folder") {
    closeRowMenu();
    currentFolderId = id;
    clearSearch();
    renderLibrary();
    $("#folder-back-button").focus();
    return;
  }
  if (kind === "open-pack") return openViewer(id);
  if (kind === "open-pack-page") {
    const [packId, pageIndex] = rest;
    return openViewer(packId, Number(pageIndex));
  }
  if (kind === "toggle-pages") {
    closeRowMenu();
    expandedPackId = expandedPackId === id ? null : id;
    renderLibrary();
    $("#library-list").querySelector(`[data-focus-key="${CSS.escape(`menu:pack:${id}`)}"]`)?.focus();
    return;
  }
  if (kind === "remove-pack-page") {
    const [packId, pageIndex] = rest;
    return removeCapturedPage(packId, Number(pageIndex));
  }
  if (kind === "show-issues") {
    closeRowMenu();
    return openIssueReport(id);
  }
  if (kind === "move-pack") {
    closeRowMenu();
    return openMoveSheet(id);
  }
  if (kind === "rename-folder") {
    closeRowMenu();
    renamingFolderId = id;
    renderLibrary();
    $("#rename-folder-input")?.select();
    return;
  }
  if (kind === "cancel-rename") {
    renamingFolderId = null;
    renderLibrary();
    return;
  }
  if (kind === "delete-pack") {
    closeRowMenu();
    return deletePack(id);
  }
  if (kind === "delete-folder") {
    closeRowMenu();
    return deleteFolder(id);
  }
}

function clearSearch() {
  clearTimeout(searchTimer);
  searchQuery = "";
  searchMatches = null;
  $("#library-search").value = "";
}

function onSearchInput() {
  searchQuery = $("#library-search").value.trim().toLowerCase();
  searchMatches = null;
  renderLibrary();
  clearTimeout(searchTimer);
  if (searchQuery.length < 2) return;
  const token = ++searchToken;
  searchTimer = setTimeout(async () => {
    try {
      const { packIds } = await sendMessage({ type: "SEARCH_LIBRARY", query: searchQuery });
      if (token !== searchToken) return;
      searchMatches = new Set(packIds || []);
      renderLibrary();
    } catch {
      // Title and URL matching already covers the common case.
    }
  }, 200);
}

function applyOnlineState() {
  renderSaveView();
  if (isOffline()) showView("library");
}

/* ------------------------------------------------------------------ *
 * Runtime messages
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message) => {
  const type = message?.type;
  if (type === "CAPTURE_PROGRESS") {
    const capture = activeCapture();
    if (!capture) {
      loadLibrary({ force: true }).catch(() => {});
      return;
    }
    ["phase", "message", "pagesDone", "pagesTotal", "assetsDone", "assetsTotal", "determinate"]
      .forEach((field) => { if (field in message) capture[field] = message[field]; });
    librarySignature = "";
    renderSaveView();
    return;
  }
  if (type === "CAPTURE_COMPLETE") {
    cancelRequestId = null;
    Promise.all([loadLibrary({ force: true }), refreshPlan(false)]).then(() => {
      setStatus(Number(message.failed) > 0
        ? `Saved. ${plural(Number(message.failed), "part")} could not be captured — see the ⋯ menu in Library.`
        : "Saved to your library.");
    });
    return;
  }
  if (type === "CAPTURE_ERROR" || type === "JOURNEY_ERROR") {
    cancelRequestId = null;
    loadLibrary({ force: true }).catch(() => {});
    return;
  }
  if (type === "CAPTURE_CANCELLED") {
    cancelRequestId = null;
    setStatus("Save cancelled. Nothing was added.");
    loadLibrary({ force: true }).catch(() => {});
    return;
  }
  if (type === "JOURNEY_PROGRESS" || type === "JOURNEY_UPDATED") {
    loadLibrary().catch(() => {});
    return;
  }
  if (type === "JOURNEY_COMPLETE") {
    setReviewBusy(false);
    closeOverlay("review");
    Promise.all([loadLibrary({ force: true }), refreshPlan(false)])
      .then(() => setStatus("Saved to your library."));
    return;
  }
  if (type === "JOURNEY_DISCARDED") {
    loadLibrary({ force: true }).catch(() => {});
  }
});

/* ------------------------------------------------------------------ *
 * Event wiring
 * ------------------------------------------------------------------ */

$("#save-tab").addEventListener("click", () => showView("save"));
$("#library-tab").addEventListener("click", () => showView("library"));
document.querySelector(".tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const current = tabs.indexOf(event.target.closest('[role="tab"]'));
  if (current < 0) return;
  event.preventDefault();
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  showView(tabs[next].id === "library-tab" ? "library" : "save");
  tabs[next].focus();
});

$("#plan-chip").addEventListener("click", () => openOverlay("pro", "#close-pro-button"));
$("#quota-upgrade-button").addEventListener("click", () => openOverlay("pro", "#upgrade-button"));
$("#pack-limits-upgrade-button").addEventListener("click", () => openOverlay("pro", "#upgrade-button"));
$("#close-pro-button").addEventListener("click", () => closeOverlay("pro"));
$("#close-issues-button").addEventListener("click", () => closeOverlay("issues"));
$("#close-review-button").addEventListener("click", () => closeOverlay("review"));
$("#keep-browsing-button").addEventListener("click", () => closeOverlay("review"));
$("#close-move-button").addEventListener("click", () => closeOverlay("move"));
$("#confirm-cancel-button").addEventListener("click", () => settleConfirm(false));
$("#confirm-accept-button").addEventListener("click", () => settleConfirm(true));
document.addEventListener("click", (event) => {
  const scrim = event.target.closest("[data-close-overlay]");
  if (!scrim) return;
  const name = scrim.dataset.closeOverlay;
  if (name === "confirm") settleConfirm(false);
  else if (name !== "review" || !reviewBusy) closeOverlay(name);
});

$("#upgrade-button").addEventListener("click", (event) => openProPage("checkout", event.currentTarget));
$("#manage-button").addEventListener("click", (event) => openProPage("manage", event.currentTarget));
$("#restore-button").addEventListener("click", (event) => openProPage("login", event.currentTarget));
$("#refresh-plan-button").addEventListener("click", (event) => refreshPlan(true, event.currentTarget));

async function openProPage(mode, trigger) {
  setProStatus(mode === "login" ? "Opening sign in…" : "Opening secure checkout…");
  setBusy(trigger, true);
  trigger.disabled = true;
  try {
    await sendMessage({ type: "OPEN_PRO_PAGE", mode });
  } catch (error) {
    setProStatus(error.message, true);
  } finally {
    setBusy(trigger, false);
    trigger.disabled = false;
  }
}

$("#save-button").addEventListener("click", () => savePage().catch(reportError));
$("#collect-start-button").addEventListener("click", () => startCollecting().catch(reportError));
$("#collect-finish-button").addEventListener("click", finishCollecting);
$("#collect-discard-button").addEventListener("click", () => discardCollection().catch(reportError));
$("#cancel-save-button").addEventListener("click", () => cancelSave().catch(reportError));
$("#save-reviewed-button").addEventListener("click", saveReviewedCollection);

$("#issues-list").addEventListener("click", (event) => {
  const node = event.target.closest("[data-issue-action]");
  if (node) handleIssueAction(node.dataset.issueAction, node).catch(reportError);
});
$("#retry-all-issues-button").addEventListener("click", () => retryAllIssues().catch(reportError));
$("#ignore-all-issues-button").addEventListener("click", () => dismissAllIssues().catch(reportError));

$("#move-list").addEventListener("click", (event) => {
  const option = event.target.closest("[data-move-to]");
  if (!option || !movePackId) return;
  const target = option.dataset.moveTo;
  closeOverlay("move");
  movePackToFolder(movePackId, target).catch(reportError);
  movePackId = null;
});

$("#save-folder-trigger").addEventListener("click", () => toggleFolderMenu());
$("#save-folder-trigger").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    toggleFolderMenu(true);
  }
});
$("#save-folder-menu").addEventListener("click", (event) => {
  const option = event.target.closest("[data-folder-id]");
  if (option) setSaveFolder(option.dataset.folderId);
});
$("#save-folder-menu").addEventListener("keydown", (event) => {
  const options = [...$("#save-folder-menu").querySelectorAll("[data-folder-id]")];
  const index = Math.max(0, options.indexOf(event.target.closest("[data-folder-id]")));
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeFolderMenu(true);
  }
});

$("#depth-select").addEventListener("change", () => {
  renderOptionsSummary();
  persistPreferences();
});
$("#run-scripts").addEventListener("change", () => {
  renderOptionsSummary();
  persistPreferences();
});
$("#max-pages-per-pack").addEventListener("change", persistPreferences);
$("#max-bytes-per-pack").addEventListener("change", persistPreferences);

$("#folder-back-button").addEventListener("click", () => {
  currentFolderId = ROOT_FOLDER;
  clearSearch();
  renderLibrary();
  ($("#library-list").querySelector(".entry-open") || $("#new-folder-button")).focus();
});
$("#new-folder-button").addEventListener("click", () => {
  $("#new-folder-form").hidden = false;
  $("#new-folder-name").focus();
});
$("#cancel-folder-button").addEventListener("click", () => {
  $("#new-folder-form").hidden = true;
  $("#new-folder-name").value = "";
  $("#new-folder-button").focus();
});
$("#new-folder-form").addEventListener("submit", (event) => createFolder(event).catch(reportError));
$("#library-search").addEventListener("input", onSearchInput);
$("#library-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape" && searchQuery) {
    event.preventDefault();
    clearSearch();
    renderLibrary();
  }
});
$("#clear-search").addEventListener("click", () => {
  clearSearch();
  renderLibrary();
  $("#library-search").focus();
});

$("#library-list").addEventListener("click", (event) => {
  const menuTrigger = event.target.closest("[data-menu-for]");
  if (menuTrigger) return openRowMenu(menuTrigger);
  if (event.target.closest(".entry-grip")) return;
  const node = event.target.closest("[data-action]");
  if (node) handleAction(node.dataset.action).catch(reportError);
});
$("#library-list").addEventListener("submit", (event) => {
  const form = event.target.closest("[data-rename-folder]");
  if (!form) return;
  event.preventDefault();
  renameFolder(form.dataset.renameFolder, form.querySelector("input").value).catch(reportError);
});
$("#library-list").addEventListener("keydown", (event) => {
  if (event.key === "Escape" && renamingFolderId) {
    event.preventDefault();
    renamingFolderId = null;
    renderLibrary();
    return;
  }
  onGripKeyDown(event);
});
$("#library-list").addEventListener("pointerdown", onGripPointerDown);
document.addEventListener("pointermove", onPointerMove, { passive: false });
document.addEventListener("pointerup", onPointerUp, { passive: false });
document.addEventListener("pointercancel", (event) => {
  if (dragSession?.mode === "pointer" && event.pointerId === dragSession.pointerId) cancelPointerDrag();
});

$("#row-menu").addEventListener("click", (event) => {
  const item = event.target.closest("[data-action]");
  if (item) handleAction(item.dataset.action).catch(reportError);
});
$("#row-menu").addEventListener("keydown", (event) => {
  const items = [...$("#row-menu").querySelectorAll(".menu-item")];
  const index = items.indexOf(event.target);
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
    return;
  }
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    closeRowMenu({ restoreFocus: true });
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!$("#folder-picker").contains(event.target)) closeFolderMenu();
  if (!$("#row-menu").contains(event.target) && !event.target.closest("[data-menu-for]")) closeRowMenu();
}, true);

document.addEventListener("keydown", (event) => {
  if (event.key === "Tab") trapFocus(event);
  if (event.key !== "Escape") return;
  if (dragSession?.mode === "pointer") return cancelPointerDrag();
  if (!$("#row-menu").hidden) return closeRowMenu({ restoreFocus: true });
  if (!$("#save-folder-menu").hidden) return closeFolderMenu(true);
  const name = topOverlay();
  if (!name) return;
  if (name === "confirm") settleConfirm(false);
  else if (name !== "review" || !reviewBusy) closeOverlay(name);
});

window.addEventListener("online", applyOnlineState);
window.addEventListener("offline", applyOnlineState);
window.addEventListener("focus", () => { loadLibrary().catch(() => {}); });

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

function readActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      activeTab = tabs?.[0] || null;
      resolve();
    });
  });
}

async function start() {
  await loadPreferences();
  await Promise.all([
    readActiveTab(),
    loadLibrary({ force: true }),
    isOffline() ? Promise.resolve() : refreshPlan(true),
  ]);
  renderPlan();
  renderSaveView();
  if (location.hash === "#library" || isOffline()) showView("library");
  else showView("save");
  if (location.hash === "#pro") openOverlay("pro", "#close-pro-button");
  if (isOffline()) setStatus("You’re offline. Your saved pages are ready in Library.");
}

start().catch(reportError);

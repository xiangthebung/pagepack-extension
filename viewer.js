import { findSavedUrl, getPack, getReadingState, putReadingState } from "./storage.js";
import { stripNetworkElements } from "./url-surface.js";
import {
  annotateSavedLinks,
  dataUrlToBlob,
  pageBytes,
  pageIndexForUrl as packPageIndexForUrl,
  prependToHead,
  resourceMapFor,
  savedLinkStyle,
  stripModuleScripts,
  stripPageScripts,
  stripUnresolvedStylesheets,
} from "./pack-render.js";

const $ = (selector) => document.querySelector(selector);
const CHUNK_SIZE = 4 * 1024 * 1024;
/* The deadline for a render scales with the page. A fixed 3.5 s used to refuse
   any page over about 25 MB — the save had worked, the reader just gave up on
   it — and "Try again" reloaded into the same refusal. The markup no longer
   carries the resource bytes, so most of the time now goes to decoding them
   into Blobs, which is linear in size: a base plus a per-megabyte allowance is
   generous for a page that is fine and still finite for one that is not. */
const BASE_RENDER_TIMEOUT = 4000;
const RENDER_TIMEOUT_PER_MB = 400;
const MAX_RENDER_TIMEOUT = 60000;
/* No `allow-popups`.
   A saved page's own scripts could call `window.open("https://…")` and, with
   `allow-popups-to-escape-sandbox`, land the user on the live site in a new tab
   — a network request the reader never sanctioned. Nothing in the reader needs
   popups: "Open online" runs in this document via `chrome.tabs.create`, not in
   the frame. */
const FRAME_SANDBOX = "allow-forms allow-scripts";
const LEGEND_TIMEOUT = 7000;
const SIDEBAR_KEY = "pagepack-reader-sidebar";
const SCROLL_SAVE_DELAY = 800;
const DEFAULT_FAVICON = "icons/icon-32.png";

let pack = null;
let currentPageIndex = 0;
let pageRendered = false;
let pageFailed = false;
let frameReady = false;
let interactiveAttempt = false;
let scriptsPreferred = false;
let frameTimer = null;
let renderAttempt = 0;
let legendTimer = null;
let unsavedLinkHref = "";
let readingState = null;
let sidebarOpen = true;
let scrollSaveTimer = 0;
const blobCache = new Map();

function showError(error) {
  window.PagePackViewer?.showError(error);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) return reject(new Error(runtimeError.message));
      if (response?.error) return reject(new Error(response.error));
      resolve(response || {});
    });
  });
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function shortReaderUrl(value) {
  try {
    const url = new URL(value);
    const path = `${url.pathname}${url.search}`.replace(/\/$/, "");
    return `${url.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return String(value || "");
  }
}

function formatReaderBytes(bytes) {
  const amount = Number(bytes || 0);
  if (amount < 1024 * 1024) return `${Math.max(1, Math.round(amount / 1024))} KB`;
  if (amount < 1024 * 1024 * 1024) return `${(amount / (1024 * 1024)).toFixed(1)} MB`;
  return `${(amount / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function announceMode(message) {
  const node = $("#reader-mode-status");
  if (node) node.textContent = message || "";
}

function currentPage() {
  return pack?.pages?.[currentPageIndex] || null;
}

function renderDeadline(page) {
  const megabytes = Math.ceil(pageBytes(page) / (1024 * 1024));
  return Math.min(MAX_RENDER_TIMEOUT, BASE_RENDER_TIMEOUT + megabytes * RENDER_TIMEOUT_PER_MB);
}

/* ------------------------------------------------------------------ *
 * Markup preparation
 * ------------------------------------------------------------------ */

function packHasSavedScripts() {
  if (pack?.runScripts === false) return false;
  return pack?.runScripts === true || (pack?.pages || []).some((page) => /<script\b/i.test(String(page.html || ""))
    || (Array.isArray(page.resources) && page.resources.some((resource) => resource?.kind === "script"))
    || Object.values(page.resourceMap || {}).some((value) => /^data:(?:text|application)\/javascript/i.test(String(value || ""))));
}

/**
 * The markup handed to the sandbox: scripts stripped or kept, the pack's link
 * badges added, and every resource still a token. The sandbox resolves the
 * tokens after parsing, against Blobs sent separately, so this string stays
 * the size of the page's HTML however many megabytes of images it carries.
 */
function hydrateMarkup(page, { runScripts = true } = {}) {
  let markup = String(page.html || "");
  if (!runScripts) markup = stripPageScripts(markup);
  else markup = stripModuleScripts(markup);
  if (!runScripts) markup = stripUnresolvedStylesheets(markup);
  // Packs saved before the capture paths learned to remove these still contain
  // them, and a `<meta http-equiv="refresh">` in an old pack would navigate this
  // frame onto the live site the moment it opened. The reader cannot re-capture
  // an old pack, so it strips them at read time instead.
  markup = stripNetworkElements(markup);
  markup = annotateSavedLinks(markup, pack, page.url);
  /* No `<base>`.
     The reader used to inject `<base href="<the original page URL>">` so that
     relative links resolved. It also silently re-pointed every relative URL that
     capture had missed at the live origin, which turned a cosmetic gap into a
     network request — the one thing a saved page must never make. Without it, a
     missed relative URL resolves against the sandbox's own opaque origin and
     fails locally, which is the correct way for a capture bug to show up.
     Link resolution does not need the document base: the page URL is handed to
     the sandbox with the markup, and the sandbox's own bridge resolves clicked
     links against it. */
  const storageShield = `<script>(function(){
    function memoryStorage(){
      var values = Object.create(null);
      return { get length(){ return Object.keys(values).length; }, key:function(index){ return Object.keys(values)[index] || null; }, getItem:function(key){ return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; }, setItem:function(key,value){ values[String(key)] = String(value); }, removeItem:function(key){ delete values[String(key)]; }, clear:function(){ values = Object.create(null); } };
    }
    try { Object.defineProperty(window, 'localStorage', { configurable:true, value:memoryStorage() }); } catch (_) {}
    try { Object.defineProperty(window, 'sessionStorage', { configurable:true, value:memoryStorage() }); } catch (_) {}
  }());<\/script>`;
  return prependToHead(markup, `${savedLinkStyle()}${runScripts ? storageShield : ""}`);
}

/** The page's resources as Blobs, decoded once and kept for the session. */
function resourceBlobsFor(index) {
  if (blobCache.has(index)) return blobCache.get(index);
  const page = pack.pages[index];
  const blobs = {};
  for (const [token, value] of Object.entries(resourceMapFor(page, pack))) {
    const blob = dataUrlToBlob(value);
    if (blob) blobs[token] = blob;
  }
  blobCache.set(index, blobs);
  return blobs;
}

/* ------------------------------------------------------------------ *
 * Rendering into the sandbox
 * ------------------------------------------------------------------ */

function sendMarkup() {
  const frame = $("#reader-frame");
  const page = currentPage();
  if (!frameReady || !frame.contentWindow || !page) return;
  const runScripts = interactiveAttempt;
  const markup = hydrateMarkup(page, { runScripts });
  const target = frame.contentWindow;
  target.postMessage({
    source: "pagepack-viewer",
    type: "load-start",
    runScripts,
    renderAttempt,
    pageUrl: String(page.url || ""),
    scrollTop: Number(readingState?.scroll?.[currentPageIndex]) || 0,
  }, "*");
  for (let index = 0; index < markup.length; index += CHUNK_SIZE) {
    target.postMessage({ source: "pagepack-viewer", type: "load-chunk", renderAttempt, chunk: markup.slice(index, index + CHUNK_SIZE) }, "*");
  }
  target.postMessage({ source: "pagepack-viewer", type: "load-resources", renderAttempt, resources: resourceBlobsFor(currentPageIndex) }, "*");
  target.postMessage({ source: "pagepack-viewer", type: "load-end", renderAttempt }, "*");
}

function preloadSandboxFrame() {
  const frame = $("#reader-frame");
  if (!frame || frameReady || frame.getAttribute("src")) return;
  frame.setAttribute("sandbox", FRAME_SANDBOX);
  frame.src = `${chrome.runtime.getURL("sandbox.html")}?render=preload&mode=static`;
}

function setLoadingCopy(title, message) {
  $("#reader-loading-title").textContent = title;
  $("#reader-loading-text").textContent = message;
}

function showLoading(title, message) {
  setLoadingCopy(title, message);
  $("#reader-loading").hidden = false;
  $("#reader-error").hidden = true;
  $("#reader-main").hidden = true;
}

function showSavedLinkLegend() {
  const legend = $("#reader-link-legend");
  clearTimeout(legendTimer);
  legend.hidden = (pack?.pages?.length || 0) < 2;
  if (legend.hidden) return;
  legendTimer = setTimeout(() => { legend.hidden = true; }, LEGEND_TIMEOUT);
}

function hideSavedLinkLegend() {
  clearTimeout(legendTimer);
  $("#reader-link-legend").hidden = true;
}

function showRenderedPage() {
  if (pageFailed) return;
  const firstShowing = !pageRendered;
  pageRendered = true;
  clearTimeout(frameTimer);
  $("#reader-loading").hidden = true;
  $("#reader-error").hidden = true;
  $("#reader-main").hidden = false;
  renderBar();
  if (firstShowing) {
    showSavedLinkLegend();
    rememberOpened();
  }
}

function renderSnapshot(index, { runScripts }) {
  const frame = $("#reader-frame");
  if (!frame || !pack?.pages?.[index]) return;
  const attempt = ++renderAttempt;
  const page = pack.pages[index];
  interactiveAttempt = Boolean(runScripts);
  pageRendered = false;
  pageFailed = false;
  clearTimeout(frameTimer);
  const size = formatReaderBytes(pageBytes(page));
  showLoading(
    runScripts ? "Starting saved scripts…" : "Opening your save…",
    runScripts ? "The plain snapshot stays available if this needs the network." : `Reading ${size} from this device.`,
  );
  renderBar();
  frame.setAttribute("sandbox", FRAME_SANDBOX);
  if (!frameReady) frame.src = `${chrome.runtime.getURL("sandbox.html")}?render=${Date.now()}_${index}&mode=${runScripts ? "interactive" : "static"}`;
  else sendMarkup();
  frameTimer = setTimeout(() => {
    if (attempt !== renderAttempt || pageRendered) return;
    if (runScripts) {
      announceMode("The saved scripts did not finish. Showing the plain snapshot instead.");
      scriptsPreferred = false;
      renderSnapshot(index, { runScripts: false });
      return;
    }
    pageFailed = true;
    showError(new Error(`This ${size} snapshot took too long to open. Try reloading the tab.`));
  }, renderDeadline(page));
}

function recordHistory(mode, index) {
  if (mode !== "push" && mode !== "replace") return;
  const state = { packId: pack.id, pageIndex: index };
  const url = viewerUrlForPage(pack.id, index);
  try {
    if (mode === "push") window.history.pushState(state, "", url);
    else window.history.replaceState(state, "", url);
  } catch {
    // Reading must not depend on the address bar keeping up.
  }
}

function setReaderPage(index, { historyMode = "replace" } = {}) {
  if (!pack?.pages?.[index]) return;
  flushScrollPosition();
  currentPageIndex = index;
  recordHistory(historyMode, index);
  hideUnsavedLinkNotice();
  hideSavedLinkLegend();
  closePageMenu();
  renderSidebar();
  renderSnapshot(index, { runScripts: scriptsPreferred && packHasSavedScripts() });
}

function viewerUrlForPage(packId, pageIndex) {
  const params = new URLSearchParams(location.search);
  params.set("pack", packId);
  params.set("page", String(pageIndex));
  return `viewer.html?${params.toString()}`;
}

/* ------------------------------------------------------------------ *
 * Reading state: where you were, what you have read
 * ------------------------------------------------------------------ */

function localReadingState() {
  if (!readingState) readingState = { packId: pack.id, pageIndex: 0, scroll: {}, opened: {}, lastOpenedAt: 0 };
  return readingState;
}

function rememberOpened() {
  const state = localReadingState();
  state.pageIndex = currentPageIndex;
  state.opened[currentPageIndex] = true;
  state.lastOpenedAt = Date.now();
  renderSidebar();
  putReadingState(pack.id, { pageIndex: currentPageIndex }).catch(() => {});
}

function noteScrollPosition(top) {
  const state = localReadingState();
  state.scroll[currentPageIndex] = Math.max(0, Math.round(Number(top) || 0));
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(flushScrollPosition, SCROLL_SAVE_DELAY);
}

function flushScrollPosition() {
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = 0;
  const state = readingState;
  if (!state || !pack) return;
  const top = state.scroll[currentPageIndex];
  if (!Number.isFinite(Number(top))) return;
  putReadingState(pack.id, { pageIndex: currentPageIndex, scrollTop: top }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Reader bar and sidebar
 * ------------------------------------------------------------------ */

function setFavicon(page) {
  const link = $("#reader-favicon");
  if (!link) return;
  const icon = [page?.favicon, pack?.favicon].find((value) => typeof value === "string" && value.startsWith("data:"));
  link.href = icon || DEFAULT_FAVICON;
}

function renderBar() {
  const page = currentPage();
  if (!page) return;
  const total = pack.pages.length;
  const title = page.title || shortReaderUrl(page.url);
  document.title = title;
  setFavicon(page);
  $("#reader-bar").hidden = false;
  $("#reader-title").textContent = title;
  $("#reader-title").title = page.title || "";
  $("#reader-subtitle").textContent = shortReaderUrl(page.url);
  $("#reader-subtitle").title = page.url || "";
  $("#reader-nav").hidden = total < 2;
  $("#reader-page-label").textContent = `${currentPageIndex + 1} of ${total}`;
  $("#reader-page-button").setAttribute("aria-label", `Page ${currentPageIndex + 1} of ${total}. Choose another page`);
  $("#reader-prev").disabled = currentPageIndex === 0;
  $("#reader-next").disabled = currentPageIndex >= total - 1;
  const scripts = $("#reader-scripts-button");
  const hasScripts = packHasSavedScripts();
  scripts.hidden = !hasScripts;
  scripts.textContent = interactiveAttempt ? "Turn off scripts" : "Enable scripts";
  scripts.title = interactiveAttempt
    ? "Reload this page as a plain offline snapshot"
    : "Experimental: run the scripts saved with this page. Some need the network, and some redraw content that is already on the page.";
  const sidebarButton = $("#reader-sidebar-button");
  sidebarButton.hidden = total < 2;
  sidebarButton.setAttribute("aria-expanded", String(sidebarOpen && total >= 2));
}

function readSidebarPreference() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
}

function writeSidebarPreference(open) {
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? "open" : "closed");
  } catch {
    // A preference that cannot be kept is not worth an error.
  }
}

function renderSidebar() {
  const aside = $("#reader-sidebar");
  const total = pack?.pages?.length || 0;
  const open = sidebarOpen && total >= 2;
  aside.hidden = !open;
  $("#reader-main").classList.toggle("has-sidebar", open);
  $("#reader-sidebar-button")?.setAttribute("aria-expanded", String(open));
  if (!open) return;
  $("#reader-sidebar-count").textContent = `${total} pages`;
  const list = $("#reader-sidebar-list");
  const opened = readingState?.opened || {};
  list.replaceChildren(...pack.pages.map((page, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sidebar-page";
    button.dataset.pageIndex = String(index);
    if (index === currentPageIndex) button.setAttribute("aria-current", "page");
    if (opened[index]) button.classList.add("is-read");
    const number = document.createElement("span");
    number.className = "sidebar-page-number";
    number.textContent = String(index + 1);
    const copy = document.createElement("span");
    copy.className = "sidebar-page-copy";
    const title = document.createElement("strong");
    title.textContent = page.title || shortReaderUrl(page.url);
    const url = document.createElement("span");
    url.textContent = shortReaderUrl(page.url);
    copy.append(title, url);
    button.append(number, copy);
    button.title = page.url || "";
    item.append(button);
    return item;
  }));
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  writeSidebarPreference(sidebarOpen);
  renderSidebar();
  renderBar();
}

function closePageMenu() {
  const menu = $("#reader-page-menu");
  if (menu.hidden) return;
  menu.hidden = true;
  menu.replaceChildren();
  $("#reader-page-button").setAttribute("aria-expanded", "false");
}

function openPageMenu() {
  const menu = $("#reader-page-menu");
  const trigger = $("#reader-page-button");
  menu.replaceChildren(...pack.pages.map((page, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "page-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === currentPageIndex));
    option.dataset.pageIndex = String(index);
    const number = document.createElement("span");
    number.className = "page-option-number";
    number.textContent = String(index + 1);
    const copy = document.createElement("span");
    copy.className = "page-option-copy";
    const title = document.createElement("strong");
    title.textContent = page.title || shortReaderUrl(page.url);
    const url = document.createElement("span");
    url.textContent = shortReaderUrl(page.url);
    copy.append(title, url);
    option.append(number, copy);
    return option;
  }));
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  const rect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  menu.style.top = `${Math.round(rect.bottom + 8)}px`;
  menu.style.left = `${Math.round(Math.max(12, Math.min(rect.left, window.innerWidth - menuRect.width - 12)))}px`;
  (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild)?.focus();
}

function togglePageMenu() {
  if ($("#reader-page-menu").hidden) openPageMenu();
  else closePageMenu();
}

function stepPage(delta) {
  const next = currentPageIndex + delta;
  if (next < 0 || next >= (pack?.pages?.length || 0)) return;
  setReaderPage(next, { historyMode: "push" });
}

function toggleScripts() {
  scriptsPreferred = !interactiveAttempt;
  announceMode(scriptsPreferred ? "Loading this page with its saved scripts." : "Loading the plain offline snapshot.");
  renderSnapshot(currentPageIndex, { runScripts: scriptsPreferred });
}

function openOriginal(url) {
  if (!/^https?:\/\//i.test(String(url || ""))) return;
  chrome.tabs.create({ url }, () => void chrome.runtime.lastError);
}

/* ------------------------------------------------------------------ *
 * Link handling
 * ------------------------------------------------------------------ */

function hideUnsavedLinkNotice() {
  unsavedLinkHref = "";
  $("#reader-unsaved-note").hidden = true;
}

function showUnsavedLinkNotice(url) {
  unsavedLinkHref = url;
  const detail = $("#reader-unsaved-url");
  detail.textContent = shortReaderUrl(url);
  detail.title = url;
  $("#reader-unsaved-note").hidden = false;
}

function pageIndexForUrl(url) {
  return packPageIndexForUrl(pack, url, pack?.pages?.[currentPageIndex]?.url);
}

async function handleLink(href) {
  let url;
  try {
    url = new URL(href, currentPage()?.url || location.href);
  } catch {
    return;
  }
  if (!/^https?:$/i.test(url.protocol)) {
    window.open(url.href, "_blank", "noopener");
    return;
  }
  const samePackIndex = pageIndexForUrl(url.href);
  if (samePackIndex >= 0) {
    setReaderPage(samePackIndex, { historyMode: "push" });
    return;
  }
  const match = await findSavedUrl(url.href).catch(() => null);
  if (match) {
    hideUnsavedLinkNotice();
    if (match.packId === pack.id) setReaderPage(match.pageIndex, { historyMode: "push" });
    else location.href = chrome.runtime.getURL(viewerUrlForPage(match.packId, match.pageIndex));
    return;
  }
  showUnsavedLinkNotice(url.href);
}

function initializeFrameMessaging() {
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) return;
    const frame = $("#reader-frame");
    if (frame && event.source && event.source !== frame.contentWindow) return;
    if (message.source === "pagepack-sandbox" && message.type === "ready") {
      frameReady = true;
      sendMarkup();
      return;
    }
    if (message.source === "pagepack-sandbox" && message.type === "rendered") {
      if (message.renderAttempt !== renderAttempt) return;
      if (!message.hasContent && message.phase !== "settled") return;
      if (!message.hasContent) {
        if (interactiveAttempt) {
          announceMode("The saved scripts produced an empty page. Showing the plain snapshot instead.");
          scriptsPreferred = false;
          renderSnapshot(currentPageIndex, { runScripts: false });
        } else {
          pageFailed = true;
          showError(new Error("This saved page has no readable content."));
        }
        return;
      }
      showRenderedPage();
      return;
    }
    if (message.source === "pagepack-sandbox" && message.type === "scroll") {
      if (message.renderAttempt === renderAttempt && pageRendered) noteScrollPosition(message.top);
      return;
    }
    if (message.source === "pagepack-sandbox" && message.type === "key") {
      if (message.key === "ArrowLeft") stepPage(-1);
      if (message.key === "ArrowRight") stepPage(1);
      return;
    }
    if (message.source === "pagepack-saved-page" && message.type === "link") {
      handleLink(message.href).catch(() => openOriginal(message.href));
    }
    if (message.source === "pagepack-saved-page" && message.type === "form") {
      handleLink(message.action).catch(() => {});
    }
  });
}

function requestedPageIndex(value) {
  const pages = pack?.pages || [];
  if (/^\d+$/.test(String(value || ""))) return Math.min(Number(value), Math.max(0, pages.length - 1));
  if (value) {
    const match = pageIndexForUrl(value);
    if (match >= 0) return match;
  }
  return -1;
}

function handleReaderHistory() {
  if (!pack) return;
  const params = new URLSearchParams(location.search);
  if (params.get("pack") !== pack.id) {
    location.reload();
    return;
  }
  const index = Math.max(0, requestedPageIndex(params.get("page")));
  if (index === currentPageIndex) return;
  setReaderPage(index, { historyMode: "none" });
}

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

function isEditableTarget(node) {
  if (!node || node.nodeType !== 1) return false;
  return node.isContentEditable || /^(?:input|textarea|select)$/i.test(node.tagName || "");
}

function wireControls() {
  $("#retry-reader").addEventListener("click", () => location.reload());
  $("#reader-library-button").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html#library") }, () => void chrome.runtime.lastError);
  });
  $("#reader-prev").addEventListener("click", () => stepPage(-1));
  $("#reader-next").addEventListener("click", () => stepPage(1));
  $("#reader-page-button").addEventListener("click", togglePageMenu);
  $("#reader-sidebar-button").addEventListener("click", toggleSidebar);
  $("#reader-sidebar-list").addEventListener("click", (event) => {
    const option = event.target.closest("[data-page-index]");
    if (!option) return;
    setReaderPage(Number(option.dataset.pageIndex), { historyMode: "push" });
  });
  $("#reader-page-menu").addEventListener("click", (event) => {
    const option = event.target.closest("[data-page-index]");
    if (!option) return;
    closePageMenu();
    setReaderPage(Number(option.dataset.pageIndex), { historyMode: "push" });
  });
  $("#reader-page-menu").addEventListener("keydown", (event) => {
    const options = [...$("#reader-page-menu").querySelectorAll("[data-page-index]")];
    const index = options.indexOf(event.target);
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
      closePageMenu();
      $("#reader-page-button").focus();
    }
  });
  $("#reader-scripts-button").addEventListener("click", toggleScripts);
  $("#reader-open-original").addEventListener("click", () => openOriginal(currentPage()?.url));
  $("#reader-open-link-button").addEventListener("click", () => {
    openOriginal(unsavedLinkHref);
    hideUnsavedLinkNotice();
  });
  $("#reader-dismiss-unsaved-button").addEventListener("click", hideUnsavedLinkNotice);
  document.addEventListener("pointerdown", (event) => {
    if (!$("#reader-page-menu").contains(event.target) && event.target !== $("#reader-page-button")) closePageMenu();
  }, true);
  // ← and → move between the pages of a save. The sandbox forwards the same
  // keys when the saved page has focus, which is most of the time.
  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!$("#reader-page-menu").hidden || isEditableTarget(event.target)) return;
    if (event.key === "ArrowLeft") stepPage(-1);
    else if (event.key === "ArrowRight") stepPage(1);
  });
  window.addEventListener("pagehide", flushScrollPosition);
}

async function repairStylesIfNeeded() {
  const needsRepair = pack.pages.some((page) => Object.values(page.resourceMap || {})
    .some((value) => /^data:text\/css(?:;|,)/i.test(String(value || "")) && /https?:/i.test(String(value || ""))));
  if (!needsRepair) return;
  await withTimeout(sendRuntimeMessage({ type: "REPAIR_PACK", id: pack.id }), 20000, "Saved style repair took too long.")
    .catch(() => null);
  const repaired = await withTimeout(getPack(pack.id), 30000, "Saved pack storage took too long to respond.").catch(() => null);
  if (repaired) pack = repaired;
}

async function init() {
  initializeFrameMessaging();
  preloadSandboxFrame();
  wireControls();
  sidebarOpen = readSidebarPreference();
  const params = new URLSearchParams(location.search);
  const packId = params.get("pack");
  if (!packId) throw new Error("This reader link does not name a saved page.");
  pack = await withTimeout(getPack(packId), 30000, "Saved pack storage took too long to respond.");
  if (!pack) throw new Error("This save is missing its data. Delete it from your library and save the page again.");
  if (!Array.isArray(pack.pages) || !pack.pages.length) throw new Error("This save contains no readable pages.");
  readingState = await getReadingState(packId).catch(() => null);
  await repairStylesIfNeeded();
  // A link that names a page opens that page; a bare link to the save resumes
  // where it was last left.
  const requested = requestedPageIndex(params.get("page"));
  const resumed = Math.min(Number(readingState?.pageIndex) || 0, pack.pages.length - 1);
  setReaderPage(requested >= 0 ? requested : resumed, { historyMode: "replace" });
}

window.addEventListener("popstate", handleReaderHistory);
init().catch(showError);

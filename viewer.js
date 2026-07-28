import { findSavedUrl, getPack } from "./storage.js";

const $ = (selector) => document.querySelector(selector);
const CHUNK_SIZE = 4 * 1024 * 1024;
const RENDER_TIMEOUT = 3500;
const FRAME_SANDBOX = "allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts";
const LEGEND_TIMEOUT = 7000;

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

function announceMode(message) {
  const node = $("#reader-mode-status");
  if (node) node.textContent = message || "";
}

function currentPage() {
  return pack?.pages?.[currentPageIndex] || null;
}

/* ------------------------------------------------------------------ *
 * Markup preparation
 * ------------------------------------------------------------------ */

function escapeAttribute(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function resourceMapFor(page) {
  if (page.resourceMap && typeof page.resourceMap === "object") return page.resourceMap;
  const source = page.resources || pack?.resources || {};
  if (!Array.isArray(source)) return source;
  return Object.fromEntries(source.map((resource) => [resource.token, resource.dataUrl || resource.data || resource.value || ""]));
}

function stripPageScripts(markup) {
  return String(markup || "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\s(on[a-z][\w:-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

function stripModuleScripts(markup) {
  // Captured module files are stored as data URLs. Relative imports from a data
  // URL have no hierarchical base, so running them only creates noisy errors
  // and cannot reproduce the original module graph offline.
  return String(markup || "").replace(/<script\b(?=[^>]*\btype\s*=\s*(?:"module"|'module'|module\b))[^>]*>[\s\S]*?<\/script\s*>/gi, "");
}

function stripUnresolvedStylesheets(markup) {
  return String(markup || "").replace(/<link\b(?=[^>]*\brel\s*=\s*(?:"[^"]*stylesheet[^"]*"|'[^']*stylesheet[^']*'|[^\s>]*stylesheet[^\s>]*))(?=[^>]*\bhref\s*=\s*(?:"https?:[^"]*"|'https?:[^']*'|https?:[^\s>]+))[^>]*>/gi, "");
}

function packHasSavedScripts() {
  if (pack?.runScripts === false) return false;
  return pack?.runScripts === true || (pack?.pages || []).some((page) => /<script\b/i.test(String(page.html || ""))
    || (Array.isArray(page.resources) && page.resources.some((resource) => resource?.kind === "script"))
    || Object.values(page.resourceMap || {}).some((value) => /^data:(?:text|application)\/javascript/i.test(String(value || ""))));
}

function canonicalViewerUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    if (!/^https?:$/i.test(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function annotateSavedLinks(markup, pageUrl) {
  const savedUrls = new Set((pack?.pages || []).map((page) => canonicalViewerUrl(page.url, pageUrl)).filter(Boolean));
  const currentUrl = canonicalViewerUrl(pageUrl, pageUrl);
  if (savedUrls.size < 2) return markup;
  return String(markup || "").replace(/<a\b([^>]*)>/gi, (full, attributes) => {
    const hrefMatch = attributes.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    if (!hrefMatch || hrefMatch[2].trim().startsWith("#")) return full;
    const targetUrl = canonicalViewerUrl(hrefMatch[2].trim(), pageUrl);
    if (!targetUrl || targetUrl === currentUrl || !savedUrls.has(targetUrl) || /\bdata-pagepack-saved-link\s*=/i.test(attributes)) return full;
    const title = /\btitle\s*=/i.test(attributes) ? "" : ' title="Saved in this pack"';
    return `<a${attributes} data-pagepack-saved-link="true"${title}>`;
  });
}

function savedLinkStyle() {
  return '<style data-pagepack-link-marker>'
    + 'a[data-pagepack-saved-link="true"]{text-decoration-line:underline!important;text-decoration-style:solid!important;'
    + 'text-decoration-thickness:2px!important;text-decoration-color:#007aff!important;text-underline-offset:3px;}'
    + 'a[data-pagepack-saved-link="true"]::after{content:"\\2713 Saved";display:inline-block;margin-left:.38em;'
    + 'padding:.1em .34em;border:1px solid rgba(0,122,255,.5);border-radius:999px;background:rgba(0,122,255,.12);'
    + 'color:#007aff;font-size:.62em;font-weight:800;line-height:1.25;letter-spacing:.02em;text-decoration:none;'
    + 'vertical-align:.12em;white-space:nowrap;}'
    + '</style>';
}

function hydrateMarkup(page, { runScripts = true } = {}) {
  let markup = String(page.html || "");
  // Strip script tags before expanding resource tokens so the static fallback
  // never copies tens of megabytes of script data into the markup.
  if (!runScripts) markup = stripPageScripts(markup);
  else markup = stripModuleScripts(markup);
  for (const [token, dataUrl] of Object.entries(resourceMapFor(page))) {
    markup = markup.split(token).join(dataUrl || "");
  }
  if (!runScripts) markup = stripUnresolvedStylesheets(markup);
  markup = annotateSavedLinks(markup, page.url);
  const head = `<base href="${escapeAttribute(page.url)}">${savedLinkStyle()}`;
  const storageShield = `<script>(function(){
    function memoryStorage(){
      var values = Object.create(null);
      return { get length(){ return Object.keys(values).length; }, key:function(index){ return Object.keys(values)[index] || null; }, getItem:function(key){ return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; }, setItem:function(key,value){ values[String(key)] = String(value); }, removeItem:function(key){ delete values[String(key)]; }, clear:function(){ values = Object.create(null); } };
    }
    try { Object.defineProperty(window, 'localStorage', { configurable:true, value:memoryStorage() }); } catch (_) {}
    try { Object.defineProperty(window, 'sessionStorage', { configurable:true, value:memoryStorage() }); } catch (_) {}
  }());<\/script>`;
  const prelude = `${head}${runScripts ? storageShield : ""}`;
  if (/<head\b[^>]*>/i.test(markup)) markup = markup.replace(/<head\b[^>]*>/i, (match) => `${match}${prelude}`);
  else markup = `${prelude}${markup}`;
  const bridge = `<script>(function(){
    document.addEventListener('click', function(event){
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var target = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
      var link = target && target.closest ? target.closest('a[href]') : null;
      if (!link || link.target === '_blank') return;
      var href = link.getAttribute('href');
      if (!href || href.charAt(0) === '#') return;
      event.preventDefault();
      parent.postMessage({source:'pagepack-saved-page', type:'link', href:new URL(href, document.baseURI).href}, '*');
    }, true);
    document.addEventListener('submit', function(event){
      var form = event.target;
      if (!form || !form.action) return;
      event.preventDefault();
      parent.postMessage({source:'pagepack-saved-page', type:'form', action:form.getAttribute('action') || form.action}, '*');
    }, true);
  }());<\/script>`;
  if (/<\/head>/i.test(markup)) return markup.replace(/<\/head>/i, `${bridge}</head>`);
  if (/<\/body>/i.test(markup)) return markup.replace(/<\/body>/i, `${bridge}</body>`);
  return `${markup}${bridge}`;
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
  frame.contentWindow.postMessage({ source: "pagepack-viewer", type: "load-start", runScripts, renderAttempt }, "*");
  for (let index = 0; index < markup.length; index += CHUNK_SIZE) {
    frame.contentWindow.postMessage({ source: "pagepack-viewer", type: "load-chunk", renderAttempt, chunk: markup.slice(index, index + CHUNK_SIZE) }, "*");
  }
  frame.contentWindow.postMessage({ source: "pagepack-viewer", type: "load-end", renderAttempt }, "*");
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
  pageRendered = true;
  clearTimeout(frameTimer);
  $("#reader-loading").hidden = true;
  $("#reader-error").hidden = true;
  $("#reader-main").hidden = false;
  renderBar();
  showSavedLinkLegend();
}

function renderSnapshot(index, { runScripts }) {
  const frame = $("#reader-frame");
  if (!frame || !pack?.pages?.[index]) return;
  const attempt = ++renderAttempt;
  interactiveAttempt = Boolean(runScripts);
  pageRendered = false;
  pageFailed = false;
  clearTimeout(frameTimer);
  showLoading(
    runScripts ? "Starting saved scripts…" : "Opening your save…",
    runScripts ? "The plain snapshot stays available if this needs the network." : "Reading it from this device.",
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
    showError(new Error("This snapshot took too long to open. Try reloading the tab."));
  }, RENDER_TIMEOUT);
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
  currentPageIndex = index;
  recordHistory(historyMode, index);
  hideUnsavedLinkNotice();
  hideSavedLinkLegend();
  closePageMenu();
  renderSnapshot(index, { runScripts: scriptsPreferred && packHasSavedScripts() });
}

function viewerUrlForPage(packId, pageIndex) {
  const params = new URLSearchParams(location.search);
  params.set("pack", packId);
  params.set("page", String(pageIndex));
  return `viewer.html?${params.toString()}`;
}

/* ------------------------------------------------------------------ *
 * Reader bar
 * ------------------------------------------------------------------ */

function renderBar() {
  const page = currentPage();
  if (!page) return;
  const total = pack.pages.length;
  $("#reader-bar").hidden = false;
  $("#reader-title").textContent = page.title || shortReaderUrl(page.url);
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
    : "Run the scripts saved with this page. Some need the network and may not work.";
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
  const target = canonicalViewerUrl(url, pack?.pages?.[currentPageIndex]?.url);
  if (!target) return -1;
  return (pack?.pages || []).findIndex((page) => canonicalViewerUrl(page.url, page.url) === target);
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
  return 0;
}

function handleReaderHistory() {
  if (!pack) return;
  const params = new URLSearchParams(location.search);
  if (params.get("pack") !== pack.id) {
    location.reload();
    return;
  }
  const index = requestedPageIndex(params.get("page"));
  if (index === currentPageIndex) return;
  setReaderPage(index, { historyMode: "none" });
}

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

function wireControls() {
  $("#retry-reader").addEventListener("click", () => location.reload());
  $("#reader-library-button").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html#library") }, () => void chrome.runtime.lastError);
  });
  $("#reader-prev").addEventListener("click", () => stepPage(-1));
  $("#reader-next").addEventListener("click", () => stepPage(1));
  $("#reader-page-button").addEventListener("click", togglePageMenu);
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
}

async function repairStylesIfNeeded() {
  const needsRepair = pack.pages.some((page) => Object.values(page.resourceMap || {})
    .some((value) => /^data:text\/css(?:;|,)/i.test(String(value || "")) && /https?:/i.test(String(value || ""))));
  if (!needsRepair) return;
  await withTimeout(sendRuntimeMessage({ type: "REPAIR_PACK", id: pack.id }), 20000, "Saved style repair took too long.")
    .catch(() => null);
  const repaired = await withTimeout(getPack(pack.id), 12000, "Saved pack storage took too long to respond.").catch(() => null);
  if (repaired) pack = repaired;
}

async function init() {
  initializeFrameMessaging();
  preloadSandboxFrame();
  wireControls();
  const params = new URLSearchParams(location.search);
  const packId = params.get("pack");
  if (!packId) throw new Error("This reader link does not name a saved page.");
  pack = await withTimeout(getPack(packId), 12000, "Saved pack storage took too long to respond.");
  if (!pack) throw new Error("This save is missing its data. Delete it from your library and save the page again.");
  if (!Array.isArray(pack.pages) || !pack.pages.length) throw new Error("This save contains no readable pages.");
  await repairStylesIfNeeded();
  setReaderPage(requestedPageIndex(params.get("page") || "0"), { historyMode: "replace" });
}

window.addEventListener("popstate", handleReaderHistory);
init().catch(showError);

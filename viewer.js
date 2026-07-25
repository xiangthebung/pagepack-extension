import { findSavedUrl, getPack } from "./storage.js";

const $ = (selector) => document.querySelector(selector);
const CHUNK_SIZE = 4 * 1024 * 1024;
const STATIC_RENDER_TIMEOUT = 3500;
const INTERACTIVE_RENDER_TIMEOUT = 3500;
const SCRIPT_FRAME_SANDBOX = "allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts";
let pack = null;
let currentPageIndex = 0;
let pageRendered = false;
let pageFailed = false;
let scriptFallbackUsed = false;
let frameReady = false;
let interactiveAttempt = false;
let frameTimer = null;
let renderAttempt = 0;
let fallbackNoteTimer = null;
let fallbackNoteFadeTimer = null;
let savedLinkLegendTimer = null;
let unsavedLinkHref = "";

function showError(error) {
  window.PagePackViewer?.showError(error);
}

function sendRuntimeMessage(message) {
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
    return `${url.hostname}${url.pathname}${url.search}`.replace(/\/$/, "") || url.hostname;
  } catch {
    return String(value || "");
  }
}

function hideUnsavedLinkNotice() {
  unsavedLinkHref = "";
  const notice = $("#reader-unsaved-note");
  if (notice) notice.hidden = true;
}

function showUnsavedLinkNotice(url) {
  unsavedLinkHref = url;
  const notice = $("#reader-unsaved-note");
  const detail = $("#reader-unsaved-url");
  if (!notice) return;
  if (detail) {
    detail.textContent = `Not in this pack: ${shortReaderUrl(url)}`;
    detail.title = url;
  }
  notice.hidden = false;
}

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
  // Captured module files are stored as data URLs. Relative imports from a
  // data URL have no hierarchical base, so running them only creates noisy
  // errors and cannot reproduce the original module graph offline.
  return String(markup || "").replace(/<script\b(?=[^>]*\btype\s*=\s*(?:"module"|'module'|module\b))[^>]*>[\s\S]*?<\/script\s*>/gi, "");
}

function stripUnresolvedStylesheets(markup) {
  return String(markup || "").replace(/<link\b(?=[^>]*\brel\s*=\s*(?:"[^"]*stylesheet[^\"]*"|'[^']*stylesheet[^']*'|[^\s>]*stylesheet[^\s>]*))(?=[^>]*\bhref\s*=\s*(?:"https?:[^\"]*"|'https?:[^']*'|https?:[^\s>]+))[^>]*>/gi, "");
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
  if (!savedUrls.size) return markup;
  return String(markup || "").replace(/<a\b([^>]*)>/gi, (full, attributes) => {
    const hrefMatch = attributes.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    if (!hrefMatch || hrefMatch[2].trim().startsWith("#")) return full;
    const targetUrl = canonicalViewerUrl(hrefMatch[2].trim(), pageUrl);
    if (!targetUrl || targetUrl === currentUrl || !savedUrls.has(targetUrl) || /\bdata-pagepack-saved-link\s*=/i.test(attributes)) return full;
    const title = /\btitle\s*=/i.test(attributes) ? "" : " title=\"Saved in this pack\"";
    return `<a${attributes} data-pagepack-saved-link=\"true\"${title}>`;
  });
}

function addSavedLinkMarkerStyle(markup) {
  const style = `<style data-pagepack-link-marker>\n    a[data-pagepack-saved-link=\"true\"] { color: #007aff !important; text-decoration-line: underline !important; text-decoration-style: solid !important; text-decoration-thickness: 2px !important; text-decoration-color: #007aff !important; text-underline-offset: 3px; }\n    a[data-pagepack-saved-link=\"true\"]::after { content: \"✓ Saved\"; display: inline-block; margin-left: .38em; padding: .1em .34em; border: 1px solid rgba(0,122,255,.5); border-radius: 999px; background: rgba(0,122,255,.12); color: #007aff; font-size: .62em; font-weight: 800; line-height: 1.25; letter-spacing: .02em; text-decoration: none; vertical-align: .12em; white-space: nowrap; }\n  </style>`;
  if (/<head\b[^>]*>/i.test(markup)) return String(markup).replace(/<head\b[^>]*>/i, (match) => `${match}${style}`);
  return `${style}${markup}`;
}

function hydrateMarkup(page, { runScripts = true } = {}) {
  let markup = String(page.html || "");
  // Strip script tags before expanding resource tokens. This avoids copying
  // tens of megabytes of script data into the static fallback markup.
  if (!runScripts) markup = stripPageScripts(markup);
  else markup = stripModuleScripts(markup);
  for (const [token, dataUrl] of Object.entries(resourceMapFor(page))) {
    markup = markup.split(token).join(dataUrl || "");
  }
  if (!runScripts) markup = stripUnresolvedStylesheets(markup);
  markup = annotateSavedLinks(markup, page.url);
  markup = addSavedLinkMarkerStyle(markup);
  const base = `<base href="${escapeAttribute(page.url)}">`;
  const storageShield = `<script>(function(){
    function memoryStorage(){
      var values = Object.create(null);
      return { get length(){ return Object.keys(values).length; }, key:function(index){ return Object.keys(values)[index] || null; }, getItem:function(key){ return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; }, setItem:function(key,value){ values[String(key)] = String(value); }, removeItem:function(key){ delete values[String(key)]; }, clear:function(){ values = Object.create(null); } };
    }
    try { Object.defineProperty(window, 'localStorage', { configurable:true, value:memoryStorage() }); } catch (_) {}
    try { Object.defineProperty(window, 'sessionStorage', { configurable:true, value:memoryStorage() }); } catch (_) {}
  }());<\/script>`;
  if (/<head\b[^>]*>/i.test(markup)) markup = markup.replace(/<head\b[^>]*>/i, (match) => `${match}${base}${runScripts ? storageShield : ""}`);
  else markup = `${base}${runScripts ? storageShield : ""}${markup}`;
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

function sendMarkup() {
  const frame = $("#reader-frame");
  const page = pack?.pages?.[currentPageIndex];
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
  frame.setAttribute("sandbox", SCRIPT_FRAME_SANDBOX);
  frame.src = `${chrome.runtime.getURL("sandbox.html")}?render=preload&mode=static`;
}

function viewerUrlForPage(packId, pageIndex) {
  const params = new URLSearchParams(location.search);
  params.set("pack", packId);
  params.set("page", String(pageIndex));
  return `viewer.html?${params.toString()}`;
}

function setLoadingCopy(title, message) {
  const titleNode = $("#reader-loading-title");
  const textNode = $("#reader-loading-text");
  if (titleNode) titleNode.textContent = title;
  if (textNode) textNode.textContent = message;
}

function hideFallbackNote() {
  const note = $("#reader-fallback-note");
  if (!note) return;
  clearTimeout(fallbackNoteTimer);
  clearTimeout(fallbackNoteFadeTimer);
  fallbackNoteTimer = null;
  if (note.hidden) {
    note.classList.remove("is-closing");
    return;
  }
  note.classList.add("is-closing");
  fallbackNoteFadeTimer = setTimeout(() => {
    note.hidden = true;
    note.classList.remove("is-closing");
    fallbackNoteFadeTimer = null;
  }, 220);
}

function showSavedLinkLegend() {
  const legend = $("#reader-link-legend");
  if (!legend) return;
  clearTimeout(savedLinkLegendTimer);
  legend.hidden = (pack?.pages?.length || 0) < 2;
  if (legend.hidden) return;
  savedLinkLegendTimer = setTimeout(() => {
    legend.hidden = true;
    savedLinkLegendTimer = null;
  }, 8000);
}

function hideSavedLinkLegend() {
  clearTimeout(savedLinkLegendTimer);
  savedLinkLegendTimer = null;
  const legend = $("#reader-link-legend");
  if (legend) legend.hidden = true;
}

function showFallbackNote() {
  const note = $("#reader-fallback-note");
  if (!note) return;
  clearTimeout(fallbackNoteTimer);
  clearTimeout(fallbackNoteFadeTimer);
  note.classList.remove("is-closing");
  note.hidden = false;
  const tryScripts = $("#try-scripts-button");
  const hasSavedScripts = packHasSavedScripts();
  if (tryScripts) tryScripts.hidden = !hasSavedScripts;
  const scriptInfo = $("#script-info-button");
  if (scriptInfo) scriptInfo.hidden = !hasSavedScripts;
  if (!hasSavedScripts) fallbackNoteTimer = setTimeout(hideFallbackNote, 6500);
}

function showRenderedPage() {
  if (pageFailed) return;
  pageRendered = true;
  clearTimeout(frameTimer);
  $("#reader-loading").hidden = true;
  $("#reader-error").hidden = true;
  $("#reader-main").hidden = false;
  showSavedLinkLegend();
  if (scriptFallbackUsed && packHasSavedScripts()) showFallbackNote();
  else hideFallbackNote();
}

function loadStaticSnapshot(index) {
  const frame = $("#reader-frame");
  const page = pack?.pages?.[index];
  if (!frame || !page) return;
  const attempt = ++renderAttempt;
  scriptFallbackUsed = true;
  interactiveAttempt = false;
  pageRendered = false;
  pageFailed = false;
  clearTimeout(frameTimer);
  setLoadingCopy("Opening offline snapshot…", "Preparing the saved page without network-dependent scripts.");
  $("#reader-loading").hidden = false;
  $("#reader-error").hidden = true;
  $("#reader-main").hidden = true;
  hideFallbackNote();
  frame.setAttribute("sandbox", SCRIPT_FRAME_SANDBOX);
  if (!frameReady) {
    frame.src = `${chrome.runtime.getURL("sandbox.html")}?render=${Date.now()}_${index}&mode=static`;
  } else {
    sendMarkup();
  }
  frameTimer = setTimeout(() => {
    if (attempt !== renderAttempt || pageRendered) return;
    pageFailed = true;
    showError(new Error("The saved page snapshot took too long to render. Try reopening the pack."));
  }, STATIC_RENDER_TIMEOUT);
}

function loadInteractiveSnapshot(index) {
  if (!packHasSavedScripts()) return;
  const frame = $("#reader-frame");
  const page = pack?.pages?.[index];
  if (!frame || !page) return;
  const attempt = ++renderAttempt;
  interactiveAttempt = true;
  scriptFallbackUsed = false;
  pageRendered = false;
  pageFailed = false;
  clearTimeout(frameTimer);
  hideFallbackNote();
  setLoadingCopy("Trying saved scripts…", "The offline snapshot stays available if this page needs the network.");
  $("#reader-loading").hidden = false;
  $("#reader-error").hidden = true;
  $("#reader-main").hidden = true;
  frame.setAttribute("sandbox", SCRIPT_FRAME_SANDBOX);
  if (!frameReady) {
    frame.src = `${chrome.runtime.getURL("sandbox.html")}?render=${Date.now()}_${index}&mode=interactive`;
  } else {
    sendMarkup();
  }
  frameTimer = setTimeout(() => {
    if (attempt !== renderAttempt || pageRendered) return;
    loadStaticSnapshot(index);
  }, INTERACTIVE_RENDER_TIMEOUT);
}

function setReaderPage(index, { historyMode = "replace" } = {}) {
  const pages = pack?.pages || [];
  if (!pages[index]) return;
  currentPageIndex = index;
  const viewerUrl = viewerUrlForPage(pack.id, index);
  if (historyMode === "push") window.history.pushState({ packId: pack.id, pageIndex: index }, "", viewerUrl);
  if (historyMode === "replace") window.history.replaceState({ packId: pack.id, pageIndex: index }, "", viewerUrl);
  hideUnsavedLinkNotice();
  pageRendered = false;
  pageFailed = false;
  scriptFallbackUsed = false;
  interactiveAttempt = false;
  setLoadingCopy("Loading pack…", "Opening your saved page.");
  $("#reader-loading").hidden = false;
  $("#reader-error").hidden = true;
  $("#reader-main").hidden = true;
  hideSavedLinkLegend();
  hideFallbackNote();
  loadStaticSnapshot(index);
}

function requestedPageIndex(value) {
  const pages = pack?.pages || [];
  if (/^\d+$/.test(String(value || ""))) {
    return Math.min(Number(value), Math.max(0, pages.length - 1));
  }
  if (value) {
    try {
      const target = new URL(value, pages[0]?.url || location.href);
      target.hash = "";
      const match = pages.findIndex((page) => {
        try {
          const pageUrl = new URL(page.url);
          pageUrl.hash = "";
          return pageUrl.href === target.href;
        } catch {
          return false;
        }
      });
      if (match >= 0) return match;
    } catch {
      // Fall back to the root page when an old link contains an invalid page value.
    }
  }
  return 0;
}

function navigateToSavedPage(match) {
  hideUnsavedLinkNotice();
  if (match.packId === pack.id) {
    setReaderPage(match.pageIndex, { historyMode: "push" });
    return;
  }
  location.href = chrome.runtime.getURL(viewerUrlForPage(match.packId, match.pageIndex));
}

async function handleLink(href) {
  let url;
  try {
    url = new URL(href, pack.pages[currentPageIndex].url);
  } catch {
    return;
  }
  if (!/^https?:$/i.test(url.protocol)) {
    window.open(url.href, "_blank", "noopener");
    return;
  }
  const savedUrl = new URL(url.href);
  savedUrl.hash = "";
  const samePackIndex = pack.pages.findIndex((page) => {
    try {
      const pageUrl = new URL(page.url);
      pageUrl.hash = "";
      return pageUrl.href === savedUrl.href;
    } catch {
      return false;
    }
  });
  if (samePackIndex >= 0) {
    setReaderPage(samePackIndex, { historyMode: "push" });
    return;
  }
  const match = await findSavedUrl(savedUrl.href).catch(() => null);
  if (match) {
    navigateToSavedPage(match);
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
        if (interactiveAttempt) loadStaticSnapshot(currentPageIndex);
        else {
          pageFailed = true;
          showError(new Error("The saved page did not contain readable content."));
        }
        return;
      }
      showRenderedPage();
    }
    if (message.source === "pagepack-saved-page" && message.type === "link") {
      handleLink(message.href).catch(() => chrome.tabs.create({ url: message.href }, () => void chrome.runtime.lastError));
    }
    if (message.source === "pagepack-saved-page" && message.type === "form") {
      handleLink(message.action).catch(() => {});
    }
  });
}

function handleReaderHistory() {
  if (!pack) return;
  const params = new URLSearchParams(location.search);
  if (params.get("pack") !== pack.id) {
    location.reload();
    return;
  }
  setReaderPage(requestedPageIndex(params.get("page")), { historyMode: "none" });
}

async function init() {
  initializeFrameMessaging();
  preloadSandboxFrame();
  const params = new URLSearchParams(location.search);
  const packId = params.get("pack");
  const requestedPage = params.get("page") || "0";
  if (!packId) throw new Error("This reader link does not include a saved pack.");
  pack = await withTimeout(getPack(packId), 12000, "Saved pack storage took too long to respond.");
  if (!pack) throw new Error("The saved pack data is missing. Delete it from the library and save the page again.");
  if (!Array.isArray(pack.pages) || !pack.pages.length) throw new Error("This saved pack contains no readable pages.");
  if (pack.pages.some((page) => Object.values(page.resourceMap || {}).some((value) => /^data:text\/css(?:;|,)/i.test(String(value || "")) && /https?:/i.test(String(value || ""))))) {
    await withTimeout(sendRuntimeMessage({ type: "REPAIR_PACK", id: pack.id }), 20000, "Saved style repair took too long.").catch(() => null);
    const repairedPack = await withTimeout(getPack(pack.id), 12000, "Saved pack storage took too long to respond.").catch(() => null);
    if (repairedPack) pack = repairedPack;
  }
  $("#retry-reader").addEventListener("click", () => location.reload());
  $("#try-scripts-button").addEventListener("click", () => loadInteractiveSnapshot(currentPageIndex));
  $("#dismiss-fallback-note").addEventListener("click", hideFallbackNote);
  $("#reader-open-link-button").addEventListener("click", () => {
    if (/^https?:\/\//i.test(String(unsavedLinkHref || ""))) {
      chrome.tabs.create({ url: unsavedLinkHref }, () => void chrome.runtime.lastError);
    }
    hideUnsavedLinkNotice();
  });
  $("#reader-dismiss-unsaved-button").addEventListener("click", hideUnsavedLinkNotice);
  setReaderPage(requestedPageIndex(requestedPage), { historyMode: "replace" });
}

window.addEventListener("popstate", handleReaderHistory);
init().catch(showError);

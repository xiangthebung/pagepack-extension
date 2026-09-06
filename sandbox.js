/**
 * Where a saved page is actually rendered, under the manifest's sandbox policy.
 *
 * The reader sends the page in two parts: the markup, with every resource still
 * written as a `__PAGEPACK_RESOURCE_n__` token, and the resources themselves as
 * Blobs. The tokens are resolved *after* parsing, against blob: URLs minted here,
 * so no document ever contains the base64 of a 30 MB page. The markup used to
 * arrive with every resource already inlined and go through `document.write`,
 * which is why a page that saved fine could not be opened.
 *
 * Two ways in, chosen by whether the saved scripts are meant to run:
 *
 *   - A plain snapshot is parsed by `DOMParser` into an inert document, the
 *     tokens are replaced in that tree, and the tree is adopted in one move.
 *     Nothing fetches during the parse, and no script runs at all.
 *   - A page with its scripts on goes through `document.write`, because that is
 *     the only way an inline `document.write` in the page lands where the author
 *     put it. The tokens are replaced in the string in a single pass first.
 *
 * The link bridge lives here rather than inside the saved page, so it is
 * installed the same way on both paths and re-installed after `document.open`
 * erases every listener.
 */
const chunks = [];
let pageScriptErrors = 0;
let blockedResourceCount = 0;
let activeRenderAttempt = null;
let activeRunScripts = false;
let activePageUrl = "";
let activeScrollTop = 0;
let resources = null;
let objectUrls = [];
let scrollTimer = 0;
let programmaticTop = -1;
let userScrolled = false;

const RESOURCE_TOKEN = /__PAGEPACK_RESOURCE_\d+__/g;
const TOKEN_MARKER = "__PAGEPACK_RESOURCE_";
const SCROLL_REPORT_INTERVAL = 400;

function isExpectedOfflineScriptError(value) {
  const message = String(value?.message || value?.reason?.message || value?.reason || value || "");
  return /sandboxed and lacks the 'allow-same-origin' flag|Invalid relative url or base scheme isn't hierarchical/i.test(message);
}

function isExpectedOfflineResourceError(event) {
  const tagName = String(event?.target?.tagName || "").toUpperCase();
  return ["IMG", "LINK", "VIDEO", "AUDIO", "SOURCE", "TRACK", "OBJECT", "EMBED", "SCRIPT"].includes(tagName);
}

function isExpectedOfflinePolicyViolation(event) {
  const blockedUri = String(event?.blockedURI || "");
  return /^(?:https?:|about:invalid)/i.test(blockedUri);
}

function onError(event) {
  if (isExpectedOfflineScriptError(event)) {
    event.preventDefault?.();
    return;
  }
  if (isExpectedOfflineResourceError(event)) {
    blockedResourceCount += 1;
    event.preventDefault?.();
    return;
  }
  pageScriptErrors += 1;
}

function onRejection(event) {
  if (isExpectedOfflineScriptError(event)) {
    event.preventDefault?.();
    return;
  }
  pageScriptErrors += 1;
}

function onPolicyViolation(event) {
  if (isExpectedOfflinePolicyViolation(event)) {
    blockedResourceCount += 1;
    event.preventDefault?.();
    return;
  }
  pageScriptErrors += 1;
}

function post(message) {
  window.parent.postMessage({ source: "pagepack-sandbox", ...message }, "*");
}

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

function releaseObjectUrls() {
  for (const url of objectUrls) {
    try { URL.revokeObjectURL(url); } catch { /* already gone */ }
  }
  objectUrls = [];
}

function resolveToken(token) {
  if (!resources) return "";
  const value = resources.get(token);
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    const url = URL.createObjectURL(value);
    objectUrls.push(url);
    resources.set(token, url);
    return url;
  } catch {
    return "";
  }
}

function substituteText(text) {
  const source = String(text || "");
  if (!resources || source.indexOf(TOKEN_MARKER) === -1) return source;
  return source.replace(RESOURCE_TOKEN, (token) => resolveToken(token));
}

function substituteTree(root) {
  if (!resources || !root?.querySelectorAll) return;
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes || [])) {
      if (attribute.value.indexOf(TOKEN_MARKER) === -1) continue;
      const value = substituteText(attribute.value);
      if (value) attribute.value = value;
      else element.removeAttribute(attribute.name);
    }
    if (element.localName === "style" && String(element.textContent || "").indexOf(TOKEN_MARKER) !== -1) {
      element.textContent = substituteText(element.textContent);
    }
  }
}

/* ------------------------------------------------------------------ *
 * The bridge back to the reader
 * ------------------------------------------------------------------ */

function onClick(event) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
  const link = target && target.closest ? target.closest("a[href]") : null;
  if (!link) return;
  const href = link.getAttribute("href");
  if (!href || href.charAt(0) === "#") return;
  event.preventDefault();
  try {
    window.parent.postMessage({ source: "pagepack-saved-page", type: "link", href: new URL(href, activePageUrl || undefined).href }, "*");
  } catch {
    // An address that cannot be resolved goes nowhere, which is the safe outcome.
  }
}

function onSubmit(event) {
  const form = event.target;
  if (!form || !form.action) return;
  event.preventDefault();
  window.parent.postMessage({ source: "pagepack-saved-page", type: "form", action: form.getAttribute("action") || form.action }, "*");
}

function onScroll() {
  const top = window.scrollY || document.documentElement?.scrollTop || 0;
  if (programmaticTop >= 0 && Math.abs(top - programmaticTop) <= 2) programmaticTop = -1;
  else userScrolled = true;
  if (scrollTimer) return;
  scrollTimer = setTimeout(() => {
    scrollTimer = 0;
    post({ type: "scroll", renderAttempt: activeRenderAttempt, top: window.scrollY || 0 });
  }, SCROLL_REPORT_INTERVAL);
}

function isEditable(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.isContentEditable) return true;
  return /^(?:input|textarea|select)$/i.test(node.tagName || "");
}

function onKey(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (isEditable(event.target)) return;
  post({ type: "key", key: event.key });
}

function installWindowListeners() {
  window.removeEventListener("message", handleViewerMessage);
  window.addEventListener("message", handleViewerMessage);
  window.removeEventListener("error", onError);
  window.addEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  window.addEventListener("unhandledrejection", onRejection);
  window.removeEventListener("securitypolicyviolation", onPolicyViolation);
  window.addEventListener("securitypolicyviolation", onPolicyViolation);
  window.removeEventListener("scroll", onScroll);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.removeEventListener("keydown", onKey, true);
  window.addEventListener("keydown", onKey, true);
}

function installBridge() {
  document.removeEventListener("click", onClick, true);
  document.addEventListener("click", onClick, true);
  document.removeEventListener("submit", onSubmit, true);
  document.addEventListener("submit", onSubmit, true);
}

function restoreScroll() {
  if (!(activeScrollTop > 0) || userScrolled) return;
  programmaticTop = activeScrollTop;
  try { window.scrollTo(0, activeScrollTop); } catch { /* a document with no body yet */ }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function reportRendered(phase, renderAttempt = activeRenderAttempt) {
  if (renderAttempt !== activeRenderAttempt) return;
  restoreScroll();
  const body = document.body;
  const text = String(body?.innerText || "").replace(/\s+/g, " ").trim();
  const mediaCount = body?.querySelectorAll?.("img,svg,canvas,video,audio,object,embed")?.length || 0;
  post({
    type: "rendered",
    renderAttempt,
    phase,
    hasContent: text.length > 0 || mediaCount > 0,
    textLength: text.length,
    mediaCount,
    scriptErrors: pageScriptErrors,
    blockedResources: blockedResourceCount,
  });
}

function installStatic(html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  substituteTree(parsed);
  const root = document.adoptNode(parsed.documentElement);
  document.replaceChild(root, document.documentElement);
}

function installInteractive(html) {
  const markup = substituteText(html);
  document.open();
  document.write(markup);
  document.close();
}

function renderFailed(renderAttempt) {
  installWindowListeners();
  post({ type: "rendered", renderAttempt, phase: "settled", hasContent: false, textLength: 0, mediaCount: 0, scriptErrors: pageScriptErrors + 1 });
}

function handleViewerMessage(event) {
  const message = event.data;
  if (!message || message.source !== "pagepack-viewer") return;
  if (message.type === "load-start") {
    chunks.length = 0;
    releaseObjectUrls();
    resources = null;
    activeRenderAttempt = message.renderAttempt ?? null;
    activeRunScripts = message.runScripts === true;
    activePageUrl = typeof message.pageUrl === "string" ? message.pageUrl : "";
    activeScrollTop = Number(message.scrollTop) > 0 ? Number(message.scrollTop) : 0;
    userScrolled = false;
    programmaticTop = -1;
    return;
  }
  if (message.renderAttempt != null && message.renderAttempt !== activeRenderAttempt) return;
  if (message.type === "load-chunk") {
    chunks.push(String(message.chunk || ""));
    return;
  }
  if (message.type === "load-resources") {
    if (!resources) resources = new Map();
    for (const [token, value] of Object.entries(message.resources || {})) resources.set(token, value);
    return;
  }
  if (message.type === "scroll-to") {
    activeScrollTop = Number(message.top) > 0 ? Number(message.top) : 0;
    userScrolled = false;
    restoreScroll();
    return;
  }
  if (message.type === "load-end") {
    const html = chunks.join("");
    chunks.length = 0;
    const renderedAttempt = activeRenderAttempt;
    try {
      if (activeRunScripts) installInteractive(html);
      else installStatic(html);
    } catch {
      renderFailed(renderedAttempt);
      return;
    }
    // document.open() removes every listener on the window and the document, so
    // both sets are put back before the page's own scripts can notice.
    installWindowListeners();
    installBridge();
    restoreScroll();
    setTimeout(() => reportRendered("initial", renderedAttempt), activeRunScripts ? 250 : 0);
    setTimeout(() => reportRendered("settled", renderedAttempt), 1500);
  }
}

installWindowListeners();
installBridge();

post({ type: "ready" });

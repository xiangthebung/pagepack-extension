const chunks = [];
let pageScriptErrors = 0;
let blockedResourceCount = 0;
let activeRenderAttempt = null;
let activeRunScripts = false;

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

window.addEventListener("error", (event) => {
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
});
window.addEventListener("unhandledrejection", (event) => {
  if (isExpectedOfflineScriptError(event)) {
    event.preventDefault?.();
    return;
  }
  pageScriptErrors += 1;
});
window.addEventListener("securitypolicyviolation", (event) => {
  if (isExpectedOfflinePolicyViolation(event)) {
    blockedResourceCount += 1;
    event.preventDefault?.();
    return;
  }
  pageScriptErrors += 1;
});

function reportRendered(phase, renderAttempt = activeRenderAttempt) {
  const body = document.body;
  const text = String(body?.innerText || "").replace(/\s+/g, " ").trim();
  const mediaCount = body?.querySelectorAll?.("img,svg,canvas,video,audio,object,embed")?.length || 0;
  window.parent.postMessage({
    source: "pagepack-sandbox",
    type: "rendered",
    renderAttempt,
    phase,
    hasContent: text.length > 0 || mediaCount > 0,
    textLength: text.length,
    mediaCount,
    scriptErrors: pageScriptErrors,
    blockedResources: blockedResourceCount,
  }, "*");
}

function handleViewerMessage(event) {
  const message = event.data;
  if (!message || message.source !== "pagepack-viewer") return;
  if (message.type === "load-start") {
    chunks.length = 0;
    activeRenderAttempt = message.renderAttempt ?? null;
    activeRunScripts = message.runScripts === true;
    return;
  }
  if (message.type === "load-chunk") {
    if (message.renderAttempt != null && message.renderAttempt !== activeRenderAttempt) return;
    chunks.push(String(message.chunk || ""));
    return;
  }
  if (message.type === "load-end") {
    if (message.renderAttempt != null && message.renderAttempt !== activeRenderAttempt) return;
    const html = chunks.join("");
    try {
      document.open();
      document.write(html);
      document.close();
    } catch {
      window.addEventListener("message", handleViewerMessage);
      window.parent.postMessage({ source: "pagepack-sandbox", type: "rendered", renderAttempt: activeRenderAttempt, phase: "settled", hasContent: false, textLength: 0, mediaCount: 0, scriptErrors: pageScriptErrors + 1 }, "*");
      return;
    }
    // document.open() removes window listeners, so restore the receiver for
    // the next page before the old document's script context is discarded.
    window.addEventListener("message", handleViewerMessage);
    const renderedAttempt = activeRenderAttempt;
    setTimeout(() => reportRendered("initial", renderedAttempt), activeRunScripts ? 250 : 0);
    setTimeout(() => reportRendered("settled", renderedAttempt), 1500);
  }
}

window.addEventListener("message", handleViewerMessage);

window.parent.postMessage({ source: "pagepack-sandbox", type: "ready" }, "*");

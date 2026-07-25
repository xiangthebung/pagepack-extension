(() => {
if (globalThis.__pagepackCaptureInstalled) return;
globalThis.__pagepackCaptureInstalled = true;

const HTML_CHUNK_SIZE = 4 * 1024 * 1024;

function canonicalUrl(value) {
  try {
    const url = new URL(value, location.href);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function isHttpUrl(value) {
  return /^https?:/i.test(String(value || ""));
}

function replaceCssUrls(cssText, collect, baseUrl) {
  const withImports = String(cssText || "").replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s]+)\1\s*\)?/gi, (full, quote, value) => {
    const token = collect(value.trim(), "style", baseUrl);
    return token ? full.replace(value, token) : full;
  });
  return withImports.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (full, quote, value) => {
    if (/^(data|blob):/i.test(value) || value.startsWith("#")) return full;
    const token = collect(value.trim(), "asset", baseUrl);
    return token ? `url(${token})` : full;
  });
}

function rewriteSrcset(value, collect, baseUrl) {
  return String(value || "").split(",").map((candidate) => {
    const parts = candidate.trim().split(/\s+/);
    const token = collect(parts[0], "image", baseUrl);
    if (!token) return candidate;
    parts[0] = token;
    return parts.join(" ");
  }).join(", ");
}

function prepareDocument(options) {
  const pageUrl = canonicalUrl(location.href);
  const clone = document.documentElement.cloneNode(true);
  const resources = [];
  const known = new Map();
  let tokenIndex = 0;
  const collect = (value, kind, baseUrl = pageUrl) => {
    if (!value || /^(data|blob):/i.test(value) || value.startsWith("#")) return null;
    let url;
    try {
      url = canonicalUrl(new URL(value, baseUrl).href);
    } catch {
      return null;
    }
    if (!isHttpUrl(url)) return null;
    const key = `${kind}:${url}`;
    if (known.has(key)) return known.get(key);
    const token = `__PAGEPACK_RESOURCE_${tokenIndex++}__`;
    known.set(key, token);
    resources.push({ token, url, kind });
    return token;
  };

  clone.querySelectorAll("noscript, base, iframe, frame, meta[http-equiv='Content-Security-Policy' i]").forEach((node) => node.remove());
  if (!options.runScripts) {
    clone.querySelectorAll("script").forEach((node) => node.remove());
    clone.querySelectorAll("*").forEach((node) => [...node.attributes].forEach((attribute) => {
      if (attribute.name.toLowerCase().startsWith("on")) node.removeAttribute(attribute.name);
    }));
  } else {
    clone.querySelectorAll("script[src]").forEach((node) => {
      const token = collect(node.getAttribute("src"), "script");
      if (token) node.setAttribute("src", token);
    });
  }

  clone.querySelectorAll("link").forEach((node) => {
    if (!node.matches("[rel~='stylesheet' i]")) {
      node.remove();
      return;
    }
    const token = collect(node.getAttribute("href"), "style");
    if (token) node.setAttribute("href", token);
  });
  clone.querySelectorAll("img, input[type='image']").forEach((node) => {
    const token = collect(node.getAttribute("src"), "image");
    if (token) node.setAttribute("src", token);
    if (node.hasAttribute("srcset")) node.setAttribute("srcset", rewriteSrcset(node.getAttribute("srcset"), collect, pageUrl));
  });
  clone.querySelectorAll("source").forEach((node) => {
    const parent = node.parentElement?.localName;
    const kind = parent === "video" || parent === "audio" ? "media" : "image";
    if (kind === "media" && !options.captureMedia) {
      node.removeAttribute("src");
      node.removeAttribute("srcset");
      return;
    }
    const token = collect(node.getAttribute("src"), kind);
    if (token) node.setAttribute("src", token);
    if (node.hasAttribute("srcset")) node.setAttribute("srcset", rewriteSrcset(node.getAttribute("srcset"), collect, pageUrl));
  });
  clone.querySelectorAll("video, audio").forEach((node) => {
    if (!options.captureMedia) {
      node.removeAttribute("src");
      node.removeAttribute("poster");
      return;
    }
    const sourceToken = collect(node.getAttribute("src"), "media");
    const posterToken = collect(node.getAttribute("poster"), "image");
    if (sourceToken) node.setAttribute("src", sourceToken);
    if (posterToken) node.setAttribute("poster", posterToken);
  });
  clone.querySelectorAll("object[data], embed[src]").forEach((node) => {
    const attribute = node.hasAttribute("data") ? "data" : "src";
    const token = options.captureMedia ? collect(node.getAttribute(attribute), "media") : null;
    if (token) node.setAttribute(attribute, token);
    else node.removeAttribute(attribute);
  });
  clone.querySelectorAll("[style]").forEach((node) => node.setAttribute("style", replaceCssUrls(node.getAttribute("style"), collect, pageUrl)));
  clone.querySelectorAll("style").forEach((node) => { node.textContent = replaceCssUrls(node.textContent, collect, pageUrl); });

  return {
    url: pageUrl,
    title: document.title || pageUrl,
    resources,
    html: `<!doctype html>\n${clone.outerHTML}`,
  };
}

async function capturePage(request) {
  const payload = prepareDocument(request.options || {});
  const port = chrome.runtime.connect({ name: "pagepack-capture" });
  let disconnected = false;
  port.onDisconnect.addListener(() => { disconnected = true; });
  port.postMessage({ type: "capture-start", requestId: request.requestId, meta: { url: payload.url, title: payload.title, resources: payload.resources } });
  for (let index = 0; index < payload.html.length; index += HTML_CHUNK_SIZE) {
    if (disconnected) return;
    port.postMessage({ type: "capture-chunk", requestId: request.requestId, chunk: payload.html.slice(index, index + HTML_CHUNK_SIZE) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (disconnected) return;
  port.postMessage({ type: "capture-end", requestId: request.requestId });
  await new Promise((resolve) => setTimeout(resolve, 0));
  port.disconnect();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "PAGEPACK_CAPTURE_REQUEST") return false;
  sendResponse({ accepted: true });
  capturePage(message).catch((error) => {
    try {
      chrome.runtime.sendMessage({ type: "CAPTURE_STREAM_ERROR", requestId: message.requestId, message: error.message });
    } catch {
      // The background timeout remains the fallback if the service worker closed.
    }
  });
  return false;
});
})();

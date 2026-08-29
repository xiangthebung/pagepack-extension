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
  const withUrls = withImports.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (full, quote, value) => {
    if (/^(data|blob):/i.test(value) || value.startsWith("#")) return full;
    const token = collect(value.trim(), "asset", baseUrl);
    return token ? `url(${token})` : full;
  });
  // The bare-string form of `image-set()` — `image-set("a.png" 1x)` — carries a
  // URL with no `url()` around it, so the pass above walks straight past it. It
  // runs after that pass, never before, or it would re-quote a token that the
  // `url()` rewriting had already produced. Mirrors `rewriteImageSet` in
  // `url-surface.js`; the service worker imports that copy, an injected script
  // cannot import anything, and `tests/offline-guarantee.test.mjs` renders a page
  // through this file in a real browser so the two cannot quietly disagree.
  return withUrls.replace(/((?:-webkit-)?image-set\()([^)]*(?:\([^)]*\)[^)]*)*)(\))/gi, (full, open, body, close) => {
    const rewritten = body.replace(/(["'])([^"']+)\1/g, (quoted, quote, value) => {
      if (/^(data|blob):/i.test(value) || value.startsWith("#") || /^__PAGEPACK_RESOURCE_\d+__$/.test(value)) return quoted;
      const token = collect(value.trim(), "asset", baseUrl);
      return token ? `${quote}${token}${quote}` : quoted;
    });
    return `${open}${rewritten}${close}`;
  });
}

/**
 * Tokenise every candidate URL in a `srcset` value.
 *
 * Deliberately identical to `rewriteSrcset` in `background.js`, which does the
 * same job for a page fetched as a followed link. The two cannot share one
 * module: that file is the module service worker, this one is injected into the
 * page by `chrome.scripting.executeScript`, and an injected file cannot carry
 * `import`. Injecting a second file to share it would put the helper on the
 * page's own globals, which is a worse trade than a copy. Keep the two bodies
 * byte-identical — `tests/srcset.test.mjs` compares them and fails if they drift
 * — because a `srcset` the browser parses differently from PagePack is a broken
 * image offline, and that is the whole reason this function exists.
 *
 * Splitting is by the HTML rules, not by commas: a candidate's URL runs to the
 * next whitespace, so a comma inside a URL stays in it, and only a comma at the
 * end of the URL ends the candidate. Everything that is not a URL — separators,
 * descriptors, newlines — is copied through untouched, because whitespace is what
 * tells a URL from its descriptor.
 */
function rewriteSrcset(value, collect, baseUrl) {
  const source = String(value || "");
  let output = "";
  let index = 0;
  while (index < source.length) {
    const separatorStart = index;
    while (index < source.length && /[\s,]/.test(source[index])) index += 1;
    output += source.slice(separatorStart, index);
    const urlStart = index;
    while (index < source.length && !/\s/.test(source[index])) index += 1;
    const rawUrl = source.slice(urlStart, index);
    const url = rawUrl.replace(/,+$/, "");
    const token = url ? collect(url, "image", baseUrl) : null;
    output += `${token || url}${rawUrl.slice(url.length)}`;
    const descriptorStart = index;
    // Parentheses can hold a comma that does not end the candidate.
    let depth = 0;
    while (index < source.length && (depth > 0 || source[index] !== ",")) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")") depth = Math.max(0, depth - 1);
      index += 1;
    }
    output += source.slice(descriptorStart, index);
  }
  return output;
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

  // Everything that embeds a document or navigates away. Kept in step with
  // `NETWORK_ELEMENTS` in `url-surface.js`, which is what the service worker's
  // fetched-page path strips and what the offline audit checks for.
  //
  // `meta[http-equiv=refresh]` is the important one and the reason this list is
  // not just about tidiness: every other construct here loads a subresource, and
  // a subresource is refused by the reader's content-security policy even if
  // capture misses it. A refresh *navigates*, and no CSP directive in any
  // shipping browser stops a sandboxed frame navigating itself. If one survives
  // capture, opening the save walks the reader onto the live page.
  clone.querySelectorAll([
    "noscript", "base", "iframe", "frame", "frameset", "portal", "object", "embed", "applet",
    "meta[http-equiv='Content-Security-Policy' i]",
    "meta[http-equiv='refresh' i]",
  ].join(", ")).forEach((node) => node.remove());
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
  // `<object>` and `<embed>` used to be saved as media here. They are removed
  // above instead, because the reader refuses them outright — `object-src 'none'`
  // — so a saved copy of their bytes could never be shown and only inflated the
  // pack. The README says so under Important limits.
  clone.querySelectorAll("track[src]").forEach((node) => {
    // Captions are small and are the one part of a video that still works when
    // the media itself was skipped, so they are saved either way.
    const token = collect(node.getAttribute("src"), "media");
    if (token) node.setAttribute("src", token);
    else node.removeAttribute("src");
  });
  // An SVG <image> or <use> addresses its target with `href`, and with
  // `xlink:href` on anything authored before SVG 2. Both still fetch, and both
  // used to be left pointing at the network.
  clone.querySelectorAll("image, use").forEach((node) => {
    for (const attribute of ["href", "xlink:href"]) {
      const value = node.getAttribute(attribute);
      if (value === null) continue;
      // A same-document fragment reaches nothing and is usually load-bearing —
      // `<use href="#icon">` is the common case — so it stays as it is.
      if (value.trim().startsWith("#")) continue;
      // A <use> pointing into another document is dropped rather than saved:
      // browsers refuse a cross-document <use> target and a data: URL is
      // cross-document, so the bytes could never render. See `classifyResource`
      // in `background.js`, which makes the same call for a fetched page.
      if (node.localName === "use") {
        node.removeAttribute(attribute);
        continue;
      }
      const token = collect(value, "image");
      if (token) node.setAttribute(attribute, token);
      else node.removeAttribute(attribute);
    }
  });
  // The obsolete `background` attribute still loads in every current browser.
  clone.querySelectorAll("[background]").forEach((node) => {
    const token = collect(node.getAttribute("background"), "image");
    if (token) node.setAttribute("background", token);
    else node.removeAttribute("background");
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

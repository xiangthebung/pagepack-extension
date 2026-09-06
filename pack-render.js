/**
 * Turning a stored pack back into markup, without the extension APIs.
 *
 * Two readers need this: the reader page (`viewer.js`), which hands the result
 * to the sandbox, and the library's "Export as HTML", which writes it to a file.
 * Neither `viewer.js` nor `popup.js` can be imported by a Node test, so the pure
 * half lives here where `tests/export.test.mjs` can reach it.
 *
 * The one rule that matters: a token is only ever replaced in a single pass.
 * The reader used to `split(token).join(dataUrl)` once per resource, which copies
 * the whole document every time — for sixty images in a 30 MB page that was
 * gigabytes of string copying, and the reason a page that saved fine could not be
 * opened. `substituteResources` walks the markup once.
 */
import { stripNetworkElements } from "./url-surface.js";

export const RESOURCE_TOKEN_PATTERN = /__PAGEPACK_RESOURCE_\d+__/g;
const TOKEN_MARKER = "__PAGEPACK_RESOURCE_";

export function resourceMapFor(page, pack) {
  if (page?.resourceMap && typeof page.resourceMap === "object") return page.resourceMap;
  const source = page?.resources || pack?.resources || {};
  if (!Array.isArray(source)) return source;
  return Object.fromEntries(source.map((resource) => [resource.token, resource.dataUrl || resource.data || resource.value || ""]));
}

export function stripPageScripts(markup) {
  return String(markup || "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\s(on[a-z][\w:-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

export function stripModuleScripts(markup) {
  // Captured module files are stored as data URLs. Relative imports from a data
  // URL have no hierarchical base, so running them only creates noisy errors
  // and cannot reproduce the original module graph offline.
  return String(markup || "").replace(/<script\b(?=[^>]*\btype\s*=\s*(?:"module"|'module'|module\b))[^>]*>[\s\S]*?<\/script\s*>/gi, "");
}

export function stripUnresolvedStylesheets(markup) {
  return String(markup || "").replace(/<link\b(?=[^>]*\brel\s*=\s*(?:"[^"]*stylesheet[^"]*"|'[^']*stylesheet[^']*'|[^\s>]*stylesheet[^\s>]*))(?=[^>]*\bhref\s*=\s*(?:"https?:[^"]*"|'https?:[^']*'|https?:[^\s>]+))[^>]*>/gi, "");
}

export function canonicalPageUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    if (!/^https?:$/i.test(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

/** Index of the pack page a link points at, or -1. */
export function pageIndexForUrl(pack, value, baseUrl) {
  const target = canonicalPageUrl(value, baseUrl);
  if (!target) return -1;
  return (pack?.pages || []).findIndex((page) => canonicalPageUrl(page.url, page.url) === target);
}

/**
 * Mark links that point at another page of the same pack, so the reader can
 * badge them "✓ Saved". `rewrite`, when given, replaces the href — the export
 * uses it to turn in-pack links into `#page-N` anchors that work from a file.
 */
export function annotateSavedLinks(markup, pack, pageUrl, rewrite = null) {
  const pages = pack?.pages || [];
  const currentUrl = canonicalPageUrl(pageUrl, pageUrl);
  if (pages.length < 2) return markup;
  return String(markup || "").replace(/<a\b([^>]*)>/gi, (full, attributes) => {
    const hrefMatch = attributes.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    if (!hrefMatch || hrefMatch[2].trim().startsWith("#")) return full;
    const targetUrl = canonicalPageUrl(hrefMatch[2].trim(), pageUrl);
    if (!targetUrl || targetUrl === currentUrl || /\bdata-pagepack-saved-link\s*=/i.test(attributes)) return full;
    const index = pages.findIndex((page) => canonicalPageUrl(page.url, page.url) === targetUrl);
    if (index < 0) return full;
    const title = /\btitle\s*=/i.test(attributes) ? "" : ' title="Saved in this pack"';
    let rewritten = attributes;
    if (rewrite) {
      const replacement = rewrite(index, targetUrl);
      rewritten = attributes.replace(hrefMatch[0], `href="${replacement.href}"`).replace(/\starget\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
      if (replacement.target) rewritten += ` target="${replacement.target}"`;
    }
    return `<a${rewritten} data-pagepack-saved-link="true"${title}>`;
  });
}

export function savedLinkStyle() {
  return '<style data-pagepack-link-marker>'
    + 'a[data-pagepack-saved-link="true"]{text-decoration-line:underline!important;text-decoration-style:solid!important;'
    + 'text-decoration-thickness:2px!important;text-decoration-color:#007aff!important;text-underline-offset:3px;}'
    + 'a[data-pagepack-saved-link="true"]::after{content:"\\2713 Saved";display:inline-block;margin-left:.38em;'
    + 'padding:.1em .34em;border:1px solid rgba(0,122,255,.5);border-radius:999px;background:rgba(0,122,255,.12);'
    + 'color:#007aff;font-size:.62em;font-weight:800;line-height:1.25;letter-spacing:.02em;text-decoration:none;'
    + 'vertical-align:.12em;white-space:nowrap;}'
    + '</style>';
}

/** Put `prelude` at the top of `<head>`, or at the top of the document when there is none. */
export function prependToHead(markup, prelude) {
  if (!prelude) return markup;
  if (/<head\b[^>]*>/i.test(markup)) return markup.replace(/<head\b[^>]*>/i, (match) => `${match}${prelude}`);
  return `${prelude}${markup}`;
}

/**
 * Replace every resource token in one pass. `resolve` answers a token with the
 * value to write; anything it does not know becomes nothing, never a live URL.
 */
export function substituteResources(markup, resolve) {
  const source = String(markup || "");
  if (source.indexOf(TOKEN_MARKER) === -1) return source;
  return source.replace(RESOURCE_TOKEN_PATTERN, (token) => {
    const value = resolve(token);
    return typeof value === "string" ? value : "";
  });
}

/** A resolver over a page's map that only ever answers with inert values. */
export function inertResolver(resourceMap) {
  return (token) => {
    const value = resourceMap?.[token];
    if (typeof value !== "string") return "";
    // A legacy pack could hold a remote address for a resource that failed; the
    // reader refuses it anyway, so writing nothing is the same picture with no
    // request attempted.
    return /^(?:data|blob):/i.test(value) ? value : "";
  };
}

/** How much a page weighs as stored: markup plus every inlined resource. */
export function pageBytes(page) {
  let total = String(page?.html || "").length;
  for (const value of Object.values(resourceMapFor(page))) total += String(value || "").length;
  return total;
}

export function packBytes(pack) {
  return (pack?.pages || []).reduce((total, page) => total + pageBytes(page), 0);
}

/**
 * Decode a data URL into a Blob, or null for anything that is not one.
 *
 * The reader minted its saved bytes into the document as base64 text; a Blob is
 * what lets it hand them to the sandbox by reference instead, and lets the
 * browser hold them outside the JavaScript heap.
 */
export function dataUrlToBlob(value) {
  const match = /^data:([^,]*?),([\s\S]*)$/.exec(String(value || ""));
  if (!match) return null;
  const meta = match[1];
  const payload = match[2];
  const base64 = /;base64$/i.test(meta);
  const mimeType = meta.replace(/;base64$/i, "") || "application/octet-stream";
  try {
    if (!base64) return new Blob([decodeURIComponent(payload)], { type: mimeType });
    const clean = payload.replace(/\s+/g, "");
    if (typeof Uint8Array.fromBase64 === "function") return new Blob([Uint8Array.fromBase64(clean)], { type: mimeType });
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function safeFileName(title, extension = "html") {
  const base = String(title || "saved-page")
    .replace(/[\\/:*?"<>| -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "saved-page";
  return `${base}.${extension}`;
}

/**
 * One saved page as a document that stands on its own: scripts out, every
 * resource inlined, nothing left that would fetch.
 */
export function buildPageExport(pack, pageIndex, { linkRewrite = null } = {}) {
  const page = pack?.pages?.[pageIndex];
  if (!page) throw new Error("That page is not in the save.");
  let markup = stripPageScripts(String(page.html || ""));
  markup = substituteResources(markup, inertResolver(resourceMapFor(page, pack)));
  markup = stripUnresolvedStylesheets(markup);
  markup = stripNetworkElements(markup);
  markup = annotateSavedLinks(markup, pack, page.url, linkRewrite);
  const savedAt = new Date(Number(pack.updatedAt) || Number(pack.savedAt) || Date.now()).toISOString();
  const stamp = `<!-- Saved with PagePack from ${escapeHtml(page.url)} on ${savedAt}. Self-contained: every image, style and font is inlined. -->\n`;
  if (!/<meta\s[^>]*charset/i.test(markup)) markup = prependToHead(markup, '<meta charset="utf-8">');
  markup = prependToHead(markup, savedLinkStyle());
  return `${stamp}${markup}`;
}

/**
 * A whole pack in one file: a page list down the side and each page held as
 * inert text until it is shown. Links between pages of the save work from the
 * file; links elsewhere are left as the user wrote them.
 */
export function buildPackExport(pack) {
  const pages = pack?.pages || [];
  if (!pages.length) throw new Error("This save contains no pages.");
  if (pages.length === 1) return buildPageExport(pack, 0);
  const title = pack.title || pages[0].title || pack.rootUrl;
  const savedAt = new Date(Number(pack.updatedAt) || Number(pack.savedAt) || Date.now());
  const rewrite = (index) => ({ href: `#page-${index}`, target: "_top" });
  const items = pages.map((page, index) => `<li><a href="#page-${index}" data-page="${index}"><strong>${escapeHtml(page.title || page.url)}</strong><span>${escapeHtml(page.url)}</span></a></li>`).join("\n");
  const holders = pages.map((page, index) => {
    const html = buildPageExport(pack, index, { linkRewrite: rewrite }).replace(/<\/script/gi, "<\\/script");
    return `<script type="text/pagepack-page" id="page-${index}" data-url="${escapeHtml(page.url)}">${html}</script>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<!-- Saved with PagePack on ${savedAt.toISOString()}. ${pages.length} pages, self-contained. -->
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; grid-template-columns: 280px minmax(0, 1fr); background: #f2f2f6; color: #1d1d1f; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  nav { overflow-y: auto; padding: 18px 14px; border-right: .5px solid rgba(60, 60, 67, .16); }
  nav h1 { margin: 0 0 4px; font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
  nav p { margin: 0 0 14px; color: #6a6a70; font-size: 12px; }
  nav ol { margin: 0; padding: 0; list-style: none; counter-reset: page; }
  nav li { counter-increment: page; }
  nav a { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; align-items: center; padding: 7px 8px; border-radius: 9px; color: inherit; text-decoration: none; }
  nav a::before { content: counter(page); color: #6a6a70; font-size: 11px; font-weight: 650; }
  nav a strong { display: block; overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  nav a span { display: block; overflow: hidden; color: #6a6a70; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  nav a:hover { background: rgba(0, 122, 255, .1); }
  nav a.is-current { background: #007aff; color: #fff; }
  nav a.is-current::before, nav a.is-current span { color: rgba(255, 255, 255, .8); }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
  @media (max-width: 720px) { body { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); } nav { max-height: 40vh; border-right: 0; border-bottom: .5px solid rgba(60, 60, 67, .16); } }
</style>
</head>
<body>
<nav>
  <h1>${escapeHtml(title)}</h1>
  <p>${pages.length} pages · saved ${escapeHtml(savedAt.toLocaleDateString())} with PagePack</p>
  <ol>
${items}
  </ol>
</nav>
<!-- The frame is sandboxed with no scripts, so nothing in a page can run.
     It shares the file's origin because a link between two saved pages is a
     top-level navigation to this same file, and Chromium refuses a file: URL
     from any initiator that is not itself file:. -->
<iframe id="page" title="Saved page" sandbox="allow-same-origin allow-top-navigation"></iframe>
${holders}
<script>
(function () {
  var frame = document.getElementById("page");
  var links = Array.prototype.slice.call(document.querySelectorAll("nav a[data-page]"));
  function show() {
    var match = /^#page-(\\d+)$/.exec(location.hash);
    var index = match ? Number(match[1]) : 0;
    var source = document.getElementById("page-" + index);
    if (!source) return;
    frame.srcdoc = source.textContent.replace(/<\\\\\\/script/gi, "<" + "/script");
    links.forEach(function (link) { link.className = Number(link.getAttribute("data-page")) === index ? "is-current" : ""; });
    document.title = (source.getAttribute("data-url") ? links[index].querySelector("strong").textContent : "") || document.title;
  }
  window.addEventListener("hashchange", show);
  show();
}());
</script>
</body>
</html>
`;
}

/** The export for a pack: one file, which is the page itself when there is only one. */
export function buildExportDocument(pack) {
  return buildPackExport(pack);
}

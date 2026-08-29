/**
 * Every way a saved page can reach the network, in one place.
 *
 * PagePack's whole claim is that opening a save makes no network request. That
 * claim is not kept by the capture code being careful; it is kept by three
 * layers, and this module is the enumeration all three are built from:
 *
 *   1. Capture removes the elements that navigate or embed (`NETWORK_ELEMENTS`,
 *      `stripNetworkElements`). A `<meta http-equiv="refresh">` is the one that
 *      matters most and the one a content-security policy cannot stop — see
 *      below.
 *   2. Capture rewrites every attribute and CSS construct that loads a
 *      subresource, so the saved copy points at bytes in the pack.
 *   3. The reader renders into a sandboxed frame whose policy is `default-src
 *      'none'` with an explicit allowance for `data:` only, so anything missed
 *      by 1 and 2 is refused by the browser rather than fetched.
 *
 * Layer 3 is why the guarantee holds even when layer 2 has a gap, and layer 2 is
 * why the page still *looks* right. Do not treat either as redundant.
 *
 * **Why `<meta http-equiv="refresh">` is special.** Every other construct here
 * loads a subresource, and a subresource is governed by a CSP fetch directive.
 * A meta refresh performs a *navigation*, and no CSP directive in any shipping
 * browser stops a sandboxed frame navigating itself (`navigate-to` was dropped
 * from the spec). A saved page carrying one would move the reader onto the live
 * site. It has to be removed at capture time; there is no second line for it.
 *
 * `auditOfflineMarkup` is the independent reader of this list. It deliberately
 * does not share regexes with the rewriters: a scanner built from the same
 * expression as the thing it checks agrees with it by construction and proves
 * nothing. `tests/offline-guarantee.test.mjs` drives it.
 */

/**
 * Elements dropped from a saved page entirely, with the reason each one is here.
 * `<base>` is on the list because the reader injects its own — a page's own base
 * would silently re-point every relative URL that survived capture at the live
 * origin, which is the exact failure this module exists to prevent.
 */
export const NETWORK_ELEMENTS = Object.freeze({
  iframe: "embeds a document; would fetch it",
  frame: "embeds a document; would fetch it",
  frameset: "holds frames",
  portal: "embeds and can navigate to a document",
  object: "embeds arbitrary content by URL",
  embed: "embeds arbitrary content by URL",
  applet: "obsolete, still parsed, loads by URL",
  base: "would override the reader's own base and re-point relative URLs at the live origin",
  noscript: "its markup renders whenever saved scripts are off, and it commonly holds a tracking pixel",
});

/**
 * Attributes that cause a load, by element. Consumed by `auditOfflineMarkup`,
 * and the checklist the rewriters in `background.js` and `content.js` are
 * written against.
 */
export const URL_ATTRIBUTES = Object.freeze({
  src: ["img", "script", "video", "audio", "source", "track", "input", "iframe", "frame", "embed"],
  srcset: ["img", "source"],
  poster: ["video"],
  data: ["object"],
  href: ["link", "image", "use"],
  "xlink:href": ["image", "use"],
  background: ["body", "table", "td", "th"],
});

/** Lazy-loading attributes. Inert on their own; a saved script turns them into a `src`. */
export const LAZY_URL_ATTRIBUTES = Object.freeze([
  "data-src", "data-srcset", "data-original", "data-lazy-src", "data-bg", "data-background-image",
]);

const RESOURCE_TOKEN = /^__PAGEPACK_RESOURCE_\d+__$/;

/** A reference that cannot reach the network: a pack token, a data URL, a fragment, or nothing. */
export function isInertReference(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return true;
  if (RESOURCE_TOKEN.test(raw)) return true;
  if (/^(?:data|blob|about|javascript):/i.test(raw)) return true;
  return raw.startsWith("#");
}

/** Every candidate URL in a `srcset`, by the HTML rules: a URL runs to the next whitespace. */
function srcsetCandidates(value) {
  return String(value ?? "")
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .map((url) => url.replace(/,+$/, ""))
    .filter(Boolean);
}

function* eachTag(html) {
  const pattern = /<([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    yield { tag: match[1].toLowerCase(), attributes: match[2], text: match[0], index: match.index };
  }
}

/**
 * The value of one attribute, or `null` if the element does not carry it.
 *
 * The name must start at a whitespace or a slash, never at a word boundary: `\b`
 * matches between the hyphen and the `s` of `data-srcset`, so a boundary-anchored
 * search for `srcset` found `data-srcset` and reported a lazy attribute as a live
 * one. Attribute names are alphanumeric plus `-` and `:`, so no escaping is needed
 * beyond the colon, which is not special in a character-free position.
 */
function attributeValue(attributes, name) {
  const match = attributes.match(new RegExp(`(?:^|[\\s/])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/**
 * Report every remote-capable reference left in saved markup.
 *
 * Returns `{ construct, element, value, reason }` for each finding, empty when the
 * markup is safe to open offline. `<a href>` and `<form action>` are excluded on
 * purpose: the reader intercepts both before they navigate, and a saved page has
 * to keep its links for the "✓ Saved" badge to mean anything.
 *
 * @param {string} html markup after capture-time rewriting, before the reader hydrates tokens
 * @param {{ allowLazyAttributes?: boolean }} [options] lazy attributes are only a
 *   finding when the pack kept its scripts, since nothing else acts on them
 */
export function auditOfflineMarkup(html, { allowLazyAttributes = true } = {}) {
  const source = String(html ?? "");
  const findings = [];
  const report = (construct, element, value, reason) => findings.push({ construct, element, value: String(value).slice(0, 200), reason });

  for (const { tag, attributes, text } of eachTag(source)) {
    if (tag in NETWORK_ELEMENTS) {
      report("element", tag, text.slice(0, 120), NETWORK_ELEMENTS[tag]);
      continue;
    }

    if (tag === "meta" && /\bhttp-equiv\s*=\s*(?:"refresh"|'refresh'|refresh\b)/i.test(attributes)) {
      report("meta-refresh", tag, attributeValue(attributes, "content") ?? "", "navigates the reader to the live page; no CSP directive stops it");
      continue;
    }

    for (const [attribute, elements] of Object.entries(URL_ATTRIBUTES)) {
      if (!elements.includes(tag)) continue;
      const value = attributeValue(attributes, attribute);
      if (value === null) continue;
      // A `<link>` that is not a stylesheet should have been removed outright;
      // report it as the element it is rather than as a stray href.
      if (attribute === "srcset") {
        for (const candidate of srcsetCandidates(value)) {
          if (!isInertReference(candidate)) report("srcset-candidate", tag, candidate, "loads an image");
        }
        continue;
      }
      if (!isInertReference(value)) report(`attribute:${attribute}`, tag, value, "loads a subresource");
    }

    if (!allowLazyAttributes) {
      for (const attribute of LAZY_URL_ATTRIBUTES) {
        const value = attributeValue(attributes, attribute);
        if (value !== null && !isInertReference(value)) {
          report(`attribute:${attribute}`, tag, value, "a saved script would promote this to a live src");
        }
      }
    }

    const style = attributeValue(attributes, "style");
    if (style) findings.push(...auditCss(style, `${tag}[style]`));
  }

  for (const [, css] of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    findings.push(...auditCss(css, "style element"));
  }

  return findings;
}

/**
 * Report every remote-capable reference in a stylesheet or inline style value.
 *
 * `image-set()` is checked separately from `url()` because its bare-string form —
 * `image-set("a.png" 1x)` — carries a URL with no `url()` around it, so a scan
 * that only looks for `url(` walks straight past it.
 */
export function auditCss(cssText, element = "css") {
  const css = String(cssText ?? "");
  const findings = [];

  for (const match of css.matchAll(/@import\s+(?:url\(\s*)?(["']?)([^"')\s]+)\1\s*\)?/gi)) {
    if (!isInertReference(match[2])) findings.push({ construct: "css:@import", element, value: match[2], reason: "loads a stylesheet" });
  }
  for (const match of css.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi)) {
    if (!isInertReference(match[2])) findings.push({ construct: "css:url()", element, value: match[2], reason: "loads an asset" });
  }
  // `url()` contents are blanked before the `image-set()` scan so a URL written as
  // `image-set(url("a.png") 1x)` is reported once, by the `url()` rule that owns
  // it, instead of twice. Blanking preserves length, so nothing else shifts.
  const withoutUrlFunctions = css.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (match) => " ".repeat(match.length));
  for (const match of withoutUrlFunctions.matchAll(/(?:-webkit-)?image-set\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi)) {
    for (const candidate of match[1].matchAll(/(["'])([^"']+)\1/g)) {
      if (!isInertReference(candidate[2])) findings.push({ construct: "css:image-set()", element, value: candidate[2], reason: "loads an image" });
    }
  }
  return findings;
}

/**
 * Rewrite the bare-string form of `image-set()`. The `url()` form is already
 * covered by the ordinary `url()` rewriting, so only quoted strings are touched
 * here, and only inside an `image-set()`.
 */
export function rewriteImageSet(cssText, collect, baseUrl) {
  return String(cssText ?? "").replace(/((?:-webkit-)?image-set\()([^)]*(?:\([^)]*\)[^)]*)*)(\))/gi, (full, open, body, close) => {
    const rewritten = body.replace(/(["'])([^"']+)\1/g, (quoted, quote, value) => {
      if (isInertReference(value)) return quoted;
      const token = collect(value.trim(), "asset", baseUrl);
      return token ? `${quote}${token}${quote}` : quoted;
    });
    return `${open}${rewritten}${close}`;
  });
}

/**
 * Remove the elements that embed or navigate, and any `<meta http-equiv="refresh">`.
 *
 * Content is removed with the element. An `<iframe>` whose start tag were merely
 * deleted would leave its fallback content behind, and an `<object>` would leave
 * the `<param>` elements naming the URL it was going to load.
 */
export function stripNetworkElements(html) {
  let result = String(html ?? "");
  for (const element of Object.keys(NETWORK_ELEMENTS)) {
    // Void elements have no closing tag; `<base>` is the one that matters.
    if (element === "base") {
      result = result.replace(/<base\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi, "");
      continue;
    }
    result = result
      .replace(new RegExp(`<${element}\\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\\s\\S]*?<\\/${element}\\s*>`, "gi"), "")
      // A start tag with no matching close still has to go, or its attributes stay.
      .replace(new RegExp(`<\\/?${element}\\b(?:"[^"]*"|'[^']*'|[^>"'])*>`, "gi"), "");
  }
  return result.replace(/<meta\b(?=(?:"[^"]*"|'[^']*'|[^>"'])*\bhttp-equiv\s*=\s*(?:"refresh"|'refresh'|refresh\b))(?:"[^"]*"|'[^']*'|[^>"'])*>/gi, "");
}

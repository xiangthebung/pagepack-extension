import {
  DEFAULT_FOLDER_ID,
  deleteFolder,
  deleteCapture,
  deleteJourney,
  deletePack,
  findSavedUrl,
  FOLDER_NAME_LIMIT,
  getPack,
  getPackIssues,
  getCapture,
  getJourney,
  getSetting,
  listCaptures,
  listFolders,
  listJourneySummaries,
  listPacks,
  makePackId,
  makeFolderId,
  moveAndReorderPack,
  movePack,
  removePackPage,
  putCapture,
  putJourney,
  putFolder,
  putPack,
  renameFolder,
  searchPackText,
  setSetting,
  reorderFolders,
} from "./storage.js";
import {
  consumeFreePages,
  DEFAULT_PACK_LIMITS,
  effectivePackLimits,
  getMonetizationState,
  normalizePackLimits,
  openPaymentPage,
  PRICING,
} from "./monetization.js";
import {
  ignoreAllPackIssues as applyIgnoreAllPackIssues,
  ignorePackIssue as applyIgnorePackIssue,
  retryPackIssue as applyRetryPackIssue,
} from "./retry.js";
import {
  enqueueJourneyItem,
  journeyQueueSummary,
  normalizeJourneyUrl,
  pendingJourneyItems,
  removeJourneyItem,
} from "./journey-queue.js";
import { rewriteImageSet, stripNetworkElements } from "./url-surface.js";

const MAX_RESOURCE_BYTES = 128 * 1024 * 1024;
// A host that accepts a connection and then never answers used to stall a whole
// save: child pages are fetched one after another, so one unresponsive server
// held the queue open with the badge still lit and no way out but cancelling.
// Treat silence as a failed resource, which the pack already knows how to
// report and retry.
const FETCH_TIMEOUT_MS = 30000;
// Same-site link following. Beyond three levels the per-pack page cap is always
// reached first, so a deeper setting only promises something it cannot keep.
const MAX_CAPTURE_DEPTH = 3;
const MAX_LINKS_PER_PAGE = 100;
const RESOURCE_CONCURRENCY = 4;
const CAPTURE_PREFERENCES_KEY = "capture-preferences";
const DEFAULT_CAPTURE_PREFERENCES = Object.freeze({
  depth: 0,
  runScripts: true,
  captureMode: "page",
  folderId: null,
  ...DEFAULT_PACK_LIMITS,
});
const captureStreams = new Map();
const captureJobs = new Map();
const cancelledCaptureIds = new Set();
const journeyJobs = new Map();
const journeyLocks = new Map();
const journeyTabTrackingJobs = new Map();
const journeyFinishingIds = new Set();
let journeyNavigationChain = Promise.resolve();
let captureStarting = false;
const WORKER_ID = `worker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const ACTIVE_CAPTURE_STATES = new Set(["queued", "reading", "saving", "finishing"]);
const ACTIVE_JOURNEY_STATES = new Set(["recording", "finishing"]);

function clampDepth(value) {
  const depth = Math.floor(Number(value));
  return Number.isFinite(depth) ? Math.max(0, Math.min(MAX_CAPTURE_DEPTH, depth)) : 0;
}

function normalizeCapturePreferences(value = {}) {
  const packLimits = normalizePackLimits(value);
  return {
    depth: clampDepth(value.depth),
    runScripts: value.runScripts !== false,
    captureMode: value.captureMode === "journey" ? "journey" : "page",
    folderId: typeof value.folderId === "string" && value.folderId ? value.folderId : null,
    ...packLimits,
  };
}

function formatPackSize(bytes) {
  const gib = Number(bytes || 0) / (1024 * 1024 * 1024);
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
}

class CaptureCancelledError extends Error {
  constructor() {
    super("The save was cancelled.");
    this.name = "CaptureCancelledError";
    this.code = "CAPTURE_CANCELLED";
  }
}

function isCaptureCancelled(requestId) {
  return cancelledCaptureIds.has(requestId) || captureJobs.get(requestId)?.cancelled === true;
}

function throwIfCaptureCancelled(requestId) {
  if (isCaptureCancelled(requestId)) throw new CaptureCancelledError();
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function normalizeUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function sendPopupMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch {
    // The popup may have closed between progress updates.
  }
}

function captureErrorMessage(error) {
  const message = String(error?.message || error || "The page could not be saved.");
  if (/cannot access contents|extensions gallery cannot be scripted|missing host permission/i.test(message)) {
    return "Chrome does not allow extensions to save this protected page.";
  }
  if (/receiving end does not exist|message port closed|page closed before capture/i.test(message)) {
    return "The page changed before the save finished. Open it again and retry.";
  }
  /* Running out of room. IndexedDB reports this as a `QuotaExceededError`, or on
     some platforms as a plain abort naming the backing store, and the raw text is
     Chrome's own — "Encountered full disk while opening backing store for
     indexedDB.open" was what the popup used to print. It says nothing a person can
     act on, so it is replaced with the one thing they can do. */
  if (error?.name === "QuotaExceededError" || /quota|full disk|storage transaction was aborted/i.test(message)) {
    return "There is not enough room left to store this save. Delete a few saved pages, or free up disk space, and try again.";
  }
  return message;
}

async function recoverStaleCaptures() {
  const captures = await listCaptures();
  await Promise.all(captures
    .filter((capture) => ACTIVE_CAPTURE_STATES.has(capture.state) && capture.workerId !== WORKER_ID)
    .map((capture) => putCapture({
      ...capture,
      state: "interrupted",
      message: "That save stopped early, so nothing was added. Open the page again and try once more.",
      error: "The capture worker stopped before it finished.",
      updatedAt: Date.now(),
      workerId: WORKER_ID,
    })));
}

const recoveryReady = recoverStaleCaptures().catch(() => {});
listJourneySummaries().then(async (journeys) => {
  const active = journeys.find((journey) => ACTIVE_JOURNEY_STATES.has(journey.state));
  if (!active) {
    updateJourneyBadge(0, false);
    return;
  }
  let journey = await getJourney(active.id);
  if (journey?.state === "finishing" && journey.workerId !== WORKER_ID) {
    journey = await updateJourney(journey.id, {
      state: "recording",
      message: "Collection restored. Pages still waiting will keep saving.",
    });
  }
  updateJourneyBadge(journeyQueueSummary(journey || active).pageCount, true);
  if (journey?.captureQueue?.length) drainJourneyQueue(journey.id).catch(() => {});
}).catch(() => {});

async function updateCapture(requestId, update) {
  const capture = await getCapture(requestId);
  if (!capture) return;
  await putCapture({ ...capture, ...update, updatedAt: Date.now(), workerId: WORKER_ID });
}

function sendTabMessage(tabId, message) {
  if (!Number.isInteger(tabId)) {
    return Promise.reject(new Error("The active tab is no longer available."));
  }
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.accepted) {
        reject(new Error(response?.error || "The page could not be captured."));
        return;
      }
      resolve(response);
    });
  });
}

async function readTabMessage(tabId, message) {
  try {
    return await sendTabMessage(tabId, message);
  } catch (error) {
    if (!/receiving end does not exist|could not establish connection/i.test(error.message)) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return sendTabMessage(tabId, message);
  }
}

function parseTitle(html, fallbackUrl) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = match?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || fallbackUrl;
}

function makeToken(index) {
  return `__PAGEPACK_RESOURCE_${index}__`;
}

/**
 * What a URL-bearing attribute should become in the saved copy.
 *
 * Returns the resource kind to save it as, `"drop"` to delete the attribute, or
 * `null` to leave it alone. `"drop"` earns its place: leaving a remote address on
 * an element whose content is not in the pack is never right, and returning
 * `null` for that case used to keep a live `<video src>` in a saved page whenever
 * media capture was off — exactly the reference the reader must not hold.
 *
 * The complete list of attributes that load something is in `url-surface.js`, and
 * `tests/offline-guarantee.test.mjs` fails if this function stops covering one.
 */
function classifyResource(tagName, attrName, tagText, options) {
  const tag = tagName.toLowerCase();
  const attr = attrName.toLowerCase();
  if (tag === "script" && attr === "src") return options.runScripts ? "script" : "drop";
  if (tag === "link" && attr === "href") {
    return /rel\s*=\s*["'][^"']*stylesheet/i.test(tagText) ? "style" : "drop";
  }
  // An SVG <image> or <use> addresses its target with `href`, and with
  // `xlink:href` on anything authored before SVG 2. Both still fetch.
  if (tag === "image" && (attr === "href" || attr === "xlink:href")) return "image";
  // A <use> pointing into another document is dropped rather than saved. Browsers
  // refuse a cross-document <use> target and a data: URL is cross-document, so the
  // bytes could never render — saving them would only inflate the pack while
  // leaving the sprite blank either way. A same-document `#id` reference works
  // offline and is preserved by the fragment check at the call site.
  if (tag === "use" && (attr === "href" || attr === "xlink:href")) return "drop";
  // <input type="image"> is a submit button that loads a picture like an <img>.
  if (tag === "input" && attr === "src") return /type\s*=\s*["']?image/i.test(tagText) ? "image" : "drop";
  // The obsolete `background` attribute still loads in every current browser.
  if (["body", "table", "td", "th"].includes(tag) && attr === "background") return "image";
  if (["img", "source", "video", "audio", "track"].includes(tag) && ["src", "poster"].includes(attr)) {
    if (["img", "source"].includes(tag)) return "media";
    return options.captureMedia ? "media" : "drop";
  }
  return null;
}

/**
 * Tokenise every candidate URL in a `srcset` value.
 *
 * Deliberately identical to `rewriteSrcset` in `content.js`, which does the same
 * job for a page read out of the live tab. The two cannot share one module: this
 * file is the module service worker, that one is injected into the page by
 * `chrome.scripting.executeScript`, and an injected file cannot carry `import`.
 * Injecting a second file to share it would put the helper on the page's own
 * globals, which is a worse trade than a copy. Keep the two bodies byte-identical
 * — `tests/srcset.test.mjs` compares them and fails if they drift — because a
 * `srcset` the browser parses differently from PagePack is a broken image
 * offline, and that is the whole reason this function exists.
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

function tokenizeCss(cssText, pageUrl, registerResource) {
  const withImports = String(cssText || "").replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s]+)\1\s*\)?/gi, (full, quote, value) => {
    const token = registerResource(value.trim(), "style", pageUrl);
    return token ? full.replace(value, token) : full;
  });
  const withUrls = withImports.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (full, quote, value) => {
    if (/^(data|blob):/i.test(value) || value.startsWith("#")) return full;
    const token = registerResource(value.trim(), "asset", pageUrl);
    return token ? `url(${token})` : full;
  });
  // After the `url()` pass, so a `url()` nested inside an `image-set()` is already
  // a bare token by the time this runs. What is left is the bare-string form —
  // `image-set("a.png" 1x)` — which carries a URL with no `url()` around it, and
  // so walked straight past a rewriter that only looked for `url(`.
  return rewriteImageSet(withUrls, registerResource, pageUrl);
}

// Exported for `tests/srcset.test.mjs`, which reads a fetched page through this
// function rather than asserting against a copy of its parsing.
export function extractAndTokenizeResources(html, pageUrl, options) {
  let resourceIndex = 0;
  const resources = [];
  const seen = new Map();
  const registerResource = (value, kind, baseUrl) => {
    const raw = String(value ?? "").trim();
    /* Nothing to fetch. `normalizeUrl` clears the hash, so a placeholder like
       `<img src="#">` or `<a href="#top">` resolved to the page's own address,
       passed the http check, and was saved into the pack as an image of the page
       it came from. */
    if (!raw || raw.startsWith("#")) return null;
    const url = normalizeUrl(raw, baseUrl);
    if (!url || !isHttpUrl(url)) return null;
    const key = `${kind}:${url}`;
    let token = seen.get(key);
    if (!token) {
      token = makeToken(resourceIndex++);
      seen.set(key, token);
      resources.push({ token, url, kind });
    }
    return token;
  };
  const tagPattern = /<([a-z][\w:-]*)\b[^>]*>/gi;
  // Elements that embed or navigate go first, before any attribute is looked at.
  // A page fetched as a followed link used to keep its `<iframe>`, its `<object>`,
  // its `<base>` and — worst — its `<meta http-equiv="refresh">`. That last one is
  // the only construct in a saved page that no content-security policy can stop,
  // because it navigates rather than loads: opening such a save moved the reader
  // onto the live site. The live-tab path in `content.js` had removed frames all
  // along; this path never did, and the README claimed it for both.
  let result = stripNetworkElements(String(html || "")).replace(tagPattern, (tagText, tagName) => {
    const tag = tagName.toLowerCase();
    if (["a", "meta", "form"].includes(tag)) return tagText;
    if (tag === "link" && !/rel\s*=\s*["'][^"']*stylesheet/i.test(tagText)) return "";
    // Global. Without the `g` this rewrote the first of `src`, `href` and `poster`
    // on a tag and stopped, so `<video src poster>` kept a remote poster and the
    // reader drew a broken frame offline for exactly the markup a video needs.
    const rewritten = tagText.replace(/\s(src|href|poster|xlink:href|background)\s*=\s*(["'])(.*?)\2/gi, (whole, attrName, quote, rawUrl) => {
      const kind = classifyResource(tagName, attrName, tagText, options);
      // A same-document fragment reaches nothing and is often load-bearing —
      // `<use href="#icon">` is the common case — so it is never dropped.
      if (kind === "drop") return String(rawUrl).trim().startsWith("#") ? whole : "";
      const token = kind ? registerResource(rawUrl, kind, pageUrl) : null;
      if (!token) return whole;
      return ` ${attrName}=${quote}${token}${quote}`;
    });
    // `srcset` as well as `src`, and on the same two elements `content.js` covers:
    // the browser prefers a candidate from `srcset`, so leaving it alone left the
    // saved page pointing at the network and broken offline.
    if (tag !== "img" && tag !== "source") return rewritten;
    // Candidates are registered under the kind this path already gives the
    // element's own `src`, so the candidate that repeats the `src` — which is most
    // responsive markup — is one resource rather than a second copy of the same
    // bytes in the pack.
    const classified = classifyResource(tag, "src", tagText, options);
    const candidateKind = classified && classified !== "drop" ? classified : "image";
    const collectCandidate = (value, _kind, baseUrl) => registerResource(value, candidateKind, baseUrl);
    return rewritten.replace(/\ssrcset\s*=\s*(["'])([\s\S]*?)\1/i, (whole, quote, rawValue) =>
      ` srcset=${quote}${rewriteSrcset(rawValue, collectCandidate, pageUrl)}${quote}`);
  });
  result = result.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (full, start, css, end) => `${start}${tokenizeCss(css, pageUrl, registerResource)}${end}`);
  result = result.replace(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (full, quote, css) => ` style=${quote}${tokenizeCss(css, pageUrl, registerResource)}${quote}`);
  if (!options.runScripts) {
    result = result.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/\s(on[a-z]+)\s*=\s*(["'])[^"']*\2/gi, "");
  }
  return { html: result, resources };
}

function dataUrlFromBytes(bytes, mimeType) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${mimeType || "application/octet-stream"};base64,${btoa(binary)}`;
}

function textFromDataUrl(value) {
  const match = String(value || "").match(/^data:([^,]*?),(.*)$/s);
  if (!match) return null;
  try {
    if (/;base64/i.test(match[1])) {
      const binary = atob(match[2]);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

/**
 * `fetch` with a deadline, on top of whatever cancel signal the caller already has.
 *
 * A timeout is reported as an ordinary failure, never as an abort. The cancel
 * paths key off the capture's own signal, and a slow host surfacing as a
 * cancellation would throw away every page saved so far — so the two have to stay
 * distinguishable even though both arrive as an `AbortError`.
 */
function fetchWithTimeout(url, init = {}) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(url, { ...init, signal }).catch((error) => {
    if (timeout.aborted && !init.signal?.aborted) {
      throw new Error(`no response after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  });
}

async function fetchResource(resource, resourceCache, visiting = new Set(), signal) {
  const cacheKey = `${resource.kind}:${resource.url}`;
  if (resourceCache.has(cacheKey)) return resourceCache.get(cacheKey);
  if (visiting.has(cacheKey)) throw new Error("cyclic resource reference");
  visiting.add(cacheKey);
  const response = await fetchWithTimeout(resource.url, { credentials: "include", redirect: "follow", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_RESOURCE_BYTES) throw new Error("resource is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESOURCE_BYTES) throw new Error("resource is too large");
  let outputBytes = bytes.byteLength;
  let outputData = bytes;
  let mimeType = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
  if (resource.kind === "style" || /css/i.test(mimeType)) {
    let css = new TextDecoder().decode(bytes);
    const stylesheetUrl = normalizeUrl(response.url || resource.url);
    const cssImports = [...css.matchAll(/@import\s+(?:url\(\s*)?(["']?)([^"')\s]+)\1\s*\)?([^;]*)(;?)/gi)];
    const importReplacements = new Map();
    for (const match of cssImports) {
      const rawUrl = match[2].trim();
      const nestedUrl = normalizeUrl(rawUrl, stylesheetUrl);
      if (!isHttpUrl(nestedUrl) || importReplacements.has(match[0])) continue;
      try {
        const nested = await fetchResource({ url: nestedUrl, kind: "style" }, resourceCache, visiting, signal);
        importReplacements.set(match[0], `@import url("${nested.dataUrl}")${match[3] || ""}${match[4] || ""}`);
      } catch (error) {
        if (signal?.aborted) throw error;
        // Drop an unavailable remote import instead of leaving a CSP-blocked URL.
        importReplacements.set(match[0], "");
      }
    }
    for (const [from, to] of importReplacements) css = css.split(from).join(to);

    const cssUrls = [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)];
    const replacements = new Map();
    for (const match of cssUrls) {
      const rawUrl = match[2].trim();
      if (/^(data|blob):/i.test(rawUrl) || rawUrl.startsWith("#")) continue;
      const nestedUrl = normalizeUrl(rawUrl, stylesheetUrl);
      if (!isHttpUrl(nestedUrl)) continue;
      if (!replacements.has(match[0])) {
        try {
          const nested = await fetchResource({ url: nestedUrl, kind: "asset" }, resourceCache, visiting, signal);
          replacements.set(match[0], `url("${nested.dataUrl}")`);
          outputBytes += nested.bytes;
        } catch (error) {
          if (signal?.aborted) throw error;
          // Remove unavailable dependencies instead of leaving CSP-blocked URLs.
          replacements.set(match[0], "url(\"\")");
        }
      }
    }
    for (const [from, to] of replacements) css = css.split(from).join(to);
    outputBytes += new TextEncoder().encode(css).byteLength - bytes.byteLength;
    outputBytes = Math.max(outputBytes, bytes.byteLength);
    outputData = new TextEncoder().encode(css);
    mimeType = "text/css";
  }
  const result = { dataUrl: dataUrlFromBytes(outputData, mimeType), bytes: outputBytes };
  resourceCache.set(cacheKey, result);
  return result;
}

async function repairCssDataUrl(dataUrl, baseUrl, resourceCache) {
  const originalCss = textFromDataUrl(dataUrl);
  if (originalCss === null || !/https?:/i.test(originalCss)) return dataUrl;
  let css = originalCss;
  let changed = false;
  const cssImports = [...css.matchAll(/@import\s+(?:url\(\s*)?(["']?)([^"')\s]+)\1\s*\)?([^;]*)(;?)/gi)];
  for (const match of cssImports) {
    const nestedUrl = normalizeUrl(match[2].trim(), baseUrl);
    if (!isHttpUrl(nestedUrl)) continue;
    try {
      const nested = await fetchResource({ url: nestedUrl, kind: "style" }, resourceCache);
      css = css.replace(match[0], `@import url("${nested.dataUrl}")${match[3] || ""}${match[4] || ""}`);
      changed = true;
    } catch {
      // Leave an unavailable import untouched; a future repair can retry it.
    }
  }
  const cssUrls = [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)];
  for (const match of cssUrls) {
    const rawUrl = match[2].trim();
    if (/^(data|blob):/i.test(rawUrl) || rawUrl.startsWith("#")) continue;
    const nestedUrl = normalizeUrl(rawUrl, baseUrl);
    if (!isHttpUrl(nestedUrl)) continue;
    try {
      const nested = await fetchResource({ url: nestedUrl, kind: "asset" }, resourceCache);
      css = css.replace(match[0], `url("${nested.dataUrl}")`);
      changed = true;
    } catch {
      // Leave an unavailable dependency untouched; the existing fallback remains usable online.
    }
  }
  return changed ? dataUrlFromBytes(new TextEncoder().encode(css), "text/css") : dataUrl;
}

async function repairPackResources(pack) {
  if (!pack?.pages?.length) return pack;
  const resourceCache = new Map();
  let changed = false;
  for (const page of pack.pages) {
    if (!page.resourceMap || typeof page.resourceMap !== "object") continue;
    for (const [token, value] of Object.entries(page.resourceMap)) {
      if (!/^data:text\/css(?:;|,)/i.test(String(value || ""))) continue;
      const repaired = await repairCssDataUrl(value, page.url, resourceCache);
      if (repaired !== value) {
        page.resourceMap[token] = repaired;
        changed = true;
      }
    }
  }
  if (changed) await putPack(pack);
  return pack;
}

async function retryPackIssue(packId, issueIndex) {
  const pack = await getPack(String(packId || ""));
  if (!pack) throw new Error("The saved pack could not be found.");
  return applyRetryPackIssue(pack, issueIndex, {
    fetchPageSource,
    fetchResource,
    hydrateResources,
    maxTotalBytes: normalizePackLimits(pack.limits).maxTotalBytes,
    putPack,
  });
}

async function ignorePackIssue(packId, issueIndex) {
  const pack = await getPack(String(packId || ""));
  if (!pack) throw new Error("The saved pack could not be found.");
  return applyIgnorePackIssue(pack, issueIndex, putPack);
}

async function ignoreAllPackIssues(packId) {
  const pack = await getPack(String(packId || ""));
  if (!pack) throw new Error("The saved pack could not be found.");
  return applyIgnoreAllPackIssues(pack, putPack);
}

async function hydrateResources(page, resourceCache, options, onProgress) {
  const resources = page.resources || [];
  let nextIndex = 0;
  let completed = 0;
  let totalBytes = 0;
  const failures = [];
  onProgress?.(0, resources.length);
  async function worker() {
    while (nextIndex < resources.length) {
      throwIfCaptureCancelled(options.requestId);
      const resource = resources[nextIndex++];
      const cacheKey = `${resource.kind}:${resource.url}`;
      try {
        let cached = resourceCache.get(cacheKey);
        if (!cached) {
          cached = await fetchResource(resource, resourceCache, new Set(), options.signal);
        }
        throwIfCaptureCancelled(options.requestId);
        page.resourceMap[resource.token] = cached.dataUrl;
        totalBytes += cached.bytes;
      } catch (error) {
        if (options.signal?.aborted || isCaptureCancelled(options.requestId)) throw new CaptureCancelledError();
        failures.push({ url: resource.url, kind: resource.kind, message: error.message });
        /* A resource that could not be fetched resolves to nothing.

           It used to resolve to its original address, described as a recoverable
           fallback, which put a live URL inside the saved page: every failed
           image left the pack holding a reference to the network, on the one
           screen that promises it holds none. The fallback could not work in any
           case — the reader refuses a remote image under `img-src 'self' data:
           blob:`, so it never loaded, it only made the claim untrue.

           Nothing is lost by dropping it. Retry finds the resource through the
           `failures` entry recorded just above and the page's own `resources`
           list — see `retryPackResourceIssue` in `retry.js` — not through this
           map. */
        page.resourceMap[resource.token] = "";
      }
      completed += 1;
      onProgress?.(completed, resources.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(RESOURCE_CONCURRENCY, resources.length) }, worker));
  return { bytes: totalBytes, failures };
}

/**
 * Suffixes under which each subdomain is a different owner's site.
 *
 * Two groups, both serving the same purpose. The first is registry suffixes where
 * registrations happen at the third level. The second is hosting platforms, and
 * that group is the one with teeth: without it every GitHub Pages site keyed to
 * `github.io`, so following links from one person's site walked into other
 * people's — a save that quietly collected pages the user never asked for, from
 * sites they had never visited.
 *
 * This is a curated subset of the Public Suffix List, not the list itself. The
 * full list is around 200 kB and changes weekly, which is a poor trade for a
 * check whose only job is to decide when to stop crawling: being wrong costs an
 * unfollowed link or an extra subdomain, not a broken save. Add entries when a
 * real site is misjudged.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // Registry suffixes with third-level registration.
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.nz", "org.nz", "net.nz", "ac.nz", "govt.nz",
  "co.za", "org.za", "net.za", "web.za",
  "com.br", "net.br", "org.br", "gov.br",
  "co.in", "net.in", "org.in", "gen.in", "firm.in",
  "co.kr", "or.kr", "ne.kr", "go.kr",
  "com.mx", "org.mx", "gob.mx",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.tr", "com.ar", "com.sg", "com.hk", "com.tw", "com.pl", "com.ua", "com.ph", "com.my", "com.vn",
  // Hosting platforms: one subdomain, one owner.
  "github.io", "gitlab.io", "blogspot.com", "wordpress.com", "tumblr.com",
  "vercel.app", "netlify.app", "netlify.com", "herokuapp.com", "web.app",
  "firebaseapp.com", "pages.dev", "workers.dev", "glitch.me", "surge.sh",
  "neocities.org", "readthedocs.io", "gitbook.io", "notion.site", "substack.com",
  "s3.amazonaws.com", "cloudfront.net", "azurewebsites.net", "appspot.com",
  "myshopify.com", "squarespace.com", "webflow.io", "wixsite.com", "weebly.com",
  "bandcamp.com", "itch.io", "medium.com",
]);

// Exported for `tests/crawl-scope.test.mjs`. What counts as "the same site" is
// what decides when a save stops following links, so it is worth pinning down.
export function siteKey(hostname) {
  const labels = String(hostname || "").toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  // The longest matching suffix wins, so a three-label entry has to be tried
  // before the two-label one: `bucket.s3.amazonaws.com` is its own site, and
  // testing `amazonaws.com` first would never reach that conclusion.
  if (labels.length >= 4 && MULTI_LABEL_SUFFIXES.has(labels.slice(-3).join("."))) return labels.slice(-4).join(".");
  const suffix = labels.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(suffix) ? labels.slice(-3).join(".") : suffix;
}

function isLinkInScope(url, pageUrl) {
  const target = new URL(url);
  const source = new URL(pageUrl);
  return siteKey(target.hostname) === siteKey(source.hostname);
}

/**
 * In-scope links on a page, up to `MAX_LINKS_PER_PAGE`.
 *
 * Returns `{ links, truncated }`. `truncated` used to be nothing at all: a page
 * with four hundred links had three hundred dropped with no record anywhere, so a
 * save could silently omit most of a section index and look complete. The count
 * is reported as an issue by `runCapture` so the user can see it happened.
 */
function linksFromMarkup(markup, pageUrl) {
  const links = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match;
  let truncated = false;
  while ((match = pattern.exec(markup))) {
    if (links.length >= MAX_LINKS_PER_PAGE) {
      truncated = true;
      break;
    }
    const url = normalizeUrl(match[2], pageUrl);
    if (!isHttpUrl(url) || seen.has(url)) continue;
    if (!isLinkInScope(url, pageUrl)) continue;
    seen.add(url);
    links.push(url);
  }
  return { links, truncated };
}

async function fetchPageSource(url, options) {
  throwIfCaptureCancelled(options.requestId);
  const response = await fetchWithTimeout(url, { credentials: "include", redirect: "follow", signal: options.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("html") && !contentType.includes("xhtml")) throw new Error("not an HTML page");
  const html = await response.text();
  throwIfCaptureCancelled(options.requestId);
  const prepared = extractAndTokenizeResources(html, url, options);
  return {
    url: normalizeUrl(response.url || url),
    title: parseTitle(html, url),
    html: prepared.html,
    resources: prepared.resources,
  };
}

function streamPageFromTab(tabId, requestId, options) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      captureStreams.delete(requestId);
      reject(new Error("The page did not respond. Try reloading the page and saving again."));
    }, 45000);
    captureStreams.set(requestId, {
      chunks: [],
      meta: null,
      timeout,
      resolve,
      reject,
    });
    readTabMessage(tabId, { type: "PAGEPACK_CAPTURE_REQUEST", requestId, options })
      .catch((error) => {
        clearTimeout(timeout);
        captureStreams.delete(requestId);
        reject(error);
      });
  });
}

async function captureLivePage(tabId, requestId, { runScripts, captureMedia }) {
  const root = await streamPageFromTab(tabId, requestId, { runScripts, captureMedia });
  const page = {
    url: normalizeUrl(root.meta?.url),
    title: root.meta?.title || root.meta?.url,
    html: root.html,
    resources: root.meta?.resources || [],
    resourceMap: {},
    capturedAt: Date.now(),
  };
  if (!page.url) throw new Error("The page URL could not be recorded.");
  const resourceCache = new Map();
  const resourceResult = await hydrateResources(page, resourceCache, { runScripts, captureMedia, requestId }, () => {});
  return {
    page,
    bytes: resourceResult.bytes,
    resources: resourceCache.size,
    failures: resourceResult.failures,
  };
}

let journeyBadge = { count: 0, active: false };
let captureBadge = { active: false, pages: 0, following: false };

/** What a running save shows when it has no page count to report. */
export const CAPTURE_WORKING_BADGE = "•";

/**
 * The badge text for a save in progress.
 *
 * Split out and exported so `tests/badge.test.mjs` can decide it exhaustively.
 * The single-page rule cannot be tested through the browser: for a save with no
 * linked pages, `pages` only reaches 1 after the last asset lands, and the badge
 * is cleared a few milliseconds later, so the difference between counting and not
 * counting is never on screen long enough to sample. An end-to-end assertion
 * about it passed whether the rule was there or not — which is worse than no
 * assertion, so the rule lives here where it can be checked directly.
 */
export function captureBadgeText({ following, pages }) {
  if (!following || !(Number(pages) > 0)) return CAPTURE_WORKING_BADGE;
  return Number(pages) > 99 ? "99+" : String(Number(pages));
}

/**
 * The toolbar badge. The only signal left once the popup closes.
 *
 * Three states, and the colour is what separates the modes — not the glyph. At
 * badge size a colour is legible at a glance and the difference between a dot and
 * a digit is not, so red always means a collection is accumulating and blue
 * always means a save is running.
 *
 * A link-following save counts pages as they land. It used to show a dot for the
 * whole run, which answers "is it working" but not "is it stuck" — and those look
 * identical for the several minutes a depth-3 crawl can take with the popup shut.
 * A number that moves is the only liveness signal available there, and it matters
 * more since resource fetches gained a deadline: a save that hits a slow host now
 * recovers, and the badge is where that becomes visible.
 *
 * A single-page save keeps the dot. The count would read "1" for an instant at
 * the very end and tell nobody anything, so the dot stays where it means
 * something: working, one page, no progress to report.
 *
 * The number is pages *saved so far*, never pages remaining — it only goes up,
 * which is the same thing the journey badge means, so the two modes do not read
 * as different kinds of number.
 */
function paintActionBadge() {
  try {
    if (journeyBadge.active) {
      const count = journeyBadge.count;
      chrome.action.setBadgeBackgroundColor({ color: "#b85c5c" });
      chrome.action.setBadgeText({ text: count > 99 ? "99+" : String(count) });
      chrome.action.setTitle({ title: `PagePack is collecting ${count} ${count === 1 ? "page" : "pages"}` });
      return;
    }
    if (captureBadge.active) {
      const text = captureBadgeText(captureBadge);
      chrome.action.setBadgeBackgroundColor({ color: "#0a84ff" });
      chrome.action.setBadgeText({ text });
      chrome.action.setTitle({
        title: text === CAPTURE_WORKING_BADGE
          ? "PagePack is saving this page"
          : `PagePack has saved ${captureBadge.pages} ${captureBadge.pages === 1 ? "page" : "pages"} so far`,
      });
      return;
    }
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "Save this page offline" });
  } catch {
    // Badge updates are only a visual enhancement.
  }
}

function updateJourneyBadge(count = 0, active = true) {
  journeyBadge = { count: Number(count) || 0, active: Boolean(active) };
  paintActionBadge();
}

function setCaptureBadge(active, { following = false } = {}) {
  captureBadge = { active: Boolean(active), pages: 0, following: Boolean(following) };
  paintActionBadge();
}

/**
 * Report a page landing in the save being captured.
 *
 * Repaints only when the number actually changes, which is once per page — at
 * most a few hundred times across a whole save, against the four-a-second the
 * progress messages already run at. It is deliberately not driven from
 * `publishProgress`: that fires on asset completion too, and would repaint the
 * badge thousands of times to show the same digit.
 */
function setCaptureBadgePages(pages) {
  const count = Number(pages) || 0;
  if (!captureBadge.active || count === captureBadge.pages) return;
  captureBadge = { ...captureBadge, pages: count };
  paintActionBadge();
}

async function getActiveJourney() {
  const journeys = await listJourneySummaries().catch(() => []);
  const summary = journeys.find((journey) => ACTIVE_JOURNEY_STATES.has(journey.state));
  return summary ? getJourney(summary.id) : null;
}

async function withJourneyLock(id, operation) {
  const previous = journeyLocks.get(id) || Promise.resolve();
  const running = previous.catch(() => {}).then(operation);
  journeyLocks.set(id, running);
  try {
    return await running;
  } finally {
    if (journeyLocks.get(id) === running) journeyLocks.delete(id);
  }
}

async function updateJourney(id, update) {
  return withJourneyLock(id, async () => {
    const journey = await getJourney(id);
    if (!journey) return null;
    const candidate = typeof update === "function" ? await update(journey) : { ...journey, ...update };
    if (!candidate) return journey;
    const next = { ...journey, ...candidate, updatedAt: Date.now(), workerId: WORKER_ID };
    await putJourney(next);
    updateJourneyBadge(journeyQueueSummary(next).pageCount, ACTIVE_JOURNEY_STATES.has(next.state));
    return next;
  });
}

function journeyProgressMessage(journey) {
  const summary = journeyQueueSummary(journey);
  const saved = `${summary.savedCount} saved`;
  const waiting = summary.pendingCount ? ` · ${summary.pendingCount} waiting` : "";
  const failed = summary.failedCount ? ` · ${summary.failedCount} failed` : "";
  return `${saved}${waiting}${failed}`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function captureQueuedJourneyTarget(journey, item) {
  const expectedUrl = normalizeJourneyUrl(item.url);
  const requestId = `journey_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let tab = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      tab = await chrome.tabs.get(item.tabId);
    } catch {
      tab = null;
      break;
    }
    if (normalizeJourneyUrl(tab.url) !== expectedUrl || tab.status === "complete") break;
    await wait(150);
  }

  let liveCaptureError = null;
  if (tab && normalizeJourneyUrl(tab.url) === expectedUrl) {
    try {
      const result = await captureLivePage(item.tabId, requestId, {
        runScripts: journey.runScripts,
        captureMedia: journey.captureMedia !== false,
      });
      if (normalizeJourneyUrl(result.page.url) === expectedUrl) return result;
    } catch (error) {
      liveCaptureError = error;
    }
  }

  const options = {
    runScripts: journey.runScripts,
    captureMedia: journey.captureMedia !== false,
    requestId,
  };
  try {
    const fetched = await fetchPageSource(expectedUrl, options);
    const page = { ...fetched, url: expectedUrl, resourceMap: {}, capturedAt: Date.now() };
    const resourceCache = new Map();
    const resourceResult = await hydrateResources(page, resourceCache, options, () => {});
    return {
      page,
      bytes: resourceResult.bytes,
      resources: resourceCache.size,
      failures: resourceResult.failures,
    };
  } catch (error) {
    throw liveCaptureError || error;
  }
}

async function processJourneyQueueItem(journeyId, item) {
  const journey = await getJourney(journeyId);
  if (!journey || !ACTIVE_JOURNEY_STATES.has(journey.state)) return;
  const packLimits = normalizePackLimits(journey);
  const url = normalizeJourneyUrl(item.url);
  const alreadySaved = (journey.pages || []).some((page) => normalizeJourneyUrl(page.url) === url);
  if (alreadySaved) {
    await updateJourney(journeyId, (latest) => removeJourneyItem(latest, item.id));
    return;
  }
  await updateJourney(journeyId, (latest) => {
    if (!ACTIVE_JOURNEY_STATES.has(latest.state)) return null;
    const captureQueue = (latest.captureQueue || []).map((queuedItem) => queuedItem.id === item.id
      ? { ...queuedItem, state: "saving" }
      : queuedItem);
    return { ...latest, captureQueue, message: `Saving ${item.title || url}…` };
  });
  if ((journey.pages || []).length >= packLimits.maxPages) {
    await updateJourney(journeyId, (latest) => {
      const next = { ...latest, captureQueue: (latest.captureQueue || []).map((queuedItem) => queuedItem.id === item.id
        ? { ...queuedItem, state: "failed" }
        : queuedItem) };
      next.failures = [...(latest.failures || []), {
        type: "page-limit",
        url,
        message: `This collection reached PagePack’s ${packLimits.maxPages}-page safety limit.`,
      }];
      next.message = "This collection reached its page limit. Save it now to keep what you have.";
      return next;
    });
    return;
  }

  sendPopupMessage({ type: "JOURNEY_PROGRESS", journeyId, message: `Saving ${item.title || url}…` });
  let result;
  try {
    result = await captureQueuedJourneyTarget(journey, item);
  } catch (error) {
    const message = captureErrorMessage(error);
    const attempts = Math.max(0, Number(item.attempts) || 0);
    if (attempts < 2) {
      await updateJourney(journeyId, (latest) => {
      if (!ACTIVE_JOURNEY_STATES.has(latest.state)) return null;
        const captureQueue = (latest.captureQueue || []).map((queuedItem) => queuedItem.id === item.id
          ? { ...queuedItem, state: "retrying", attempts: attempts + 1 }
          : queuedItem);
        return {
          ...latest,
          captureQueue,
          message: `Retrying ${item.title || url}…`,
        };
      });
      await wait(300 * (attempts + 1));
      return;
    }
    await updateJourney(journeyId, (latest) => {
      if (!ACTIVE_JOURNEY_STATES.has(latest.state)) return null;
      const next = { ...latest, captureQueue: (latest.captureQueue || []).map((queuedItem) => queuedItem.id === item.id
        ? { ...queuedItem, state: "failed" }
        : queuedItem) };
      next.failures = [...(latest.failures || []), { type: "page", url, message }];
      next.message = `Couldn’t save ${item.title || url}. Keep browsing, or save what you have.`;
      return next;
    });
    sendPopupMessage({ type: "JOURNEY_ERROR", journeyId, message });
    return;
  }

  let savedPage = null;
  const updated = await updateJourney(journeyId, (latest) => {
    if (!ACTIVE_JOURNEY_STATES.has(latest.state)) return null;
    const pages = [...(latest.pages || [])];
    const pageIndex = pages.findIndex((page) => normalizeJourneyUrl(page.url) === normalizeJourneyUrl(result.page.url));
    const capturedNewPage = pageIndex < 0;
    if (capturedNewPage && Number(latest.totalBytes || 0) + result.bytes > packLimits.maxTotalBytes) {
      const next = { ...latest, captureQueue: (latest.captureQueue || []).map((queuedItem) => queuedItem.id === item.id
        ? { ...queuedItem, state: "failed" }
        : queuedItem) };
      next.failures = [...(latest.failures || []), {
        type: "pack-limit",
        url: result.page.url,
        message: `This collection reached PagePack’s ${formatPackSize(packLimits.maxTotalBytes)} size limit.`,
      }];
      next.message = "This collection reached its size limit. Save it now to keep what you have.";
      return next;
    }
    let next = removeJourneyItem(latest, item.id);
    if (capturedNewPage) pages.push({ ...result.page, bytes: result.bytes, resourceCount: result.resources });
    savedPage = result.page;
    const visits = [...(latest.visits || []), {
      pageUrl: result.page.url,
      parentUrl: item.parentUrl || null,
      tabId: item.tabId,
      capturedAt: Date.now(),
    }];
    const previousTabState = { ...(latest.tabState?.[item.tabId] || {}) };
    const tabState = {
      ...(latest.tabState || {}),
      [item.tabId]: { ...previousTabState, lastCapturedUrl: result.page.url },
    };
    next = {
      ...next,
      pages,
      visits,
      tabState,
      failures: [
        ...(latest.failures || []),
        ...result.failures.map((failure) => ({ ...failure, type: "resource", pageUrl: result.page.url })),
      ],
      totalBytes: Number(latest.totalBytes || 0) + (capturedNewPage ? result.bytes : 0),
      totalResources: Number(latest.totalResources || 0) + (capturedNewPage ? result.resources : 0),
    };
    next.message = journeyProgressMessage(next);
    return next;
  });
  if (updated && savedPage) {
    const summary = journeyQueueSummary(updated);
    sendPopupMessage({
      type: "JOURNEY_UPDATED",
      journeyId,
      pages: summary.pageCount,
      page: { url: savedPage.url, title: savedPage.title },
    });
  }
}

async function drainJourneyQueue(journeyId) {
  if (journeyJobs.has(journeyId)) return journeyJobs.get(journeyId);
  const job = (async () => {
    while (true) {
      const journey = await getJourney(journeyId);
      if (!journey || !ACTIVE_JOURNEY_STATES.has(journey.state)) return;
      const item = pendingJourneyItems(journey)[0] || null;
      if (!item) return;
      await processJourneyQueueItem(journeyId, item);
    }
  })();
  journeyJobs.set(journeyId, job);
  try {
    await job;
  } catch (error) {
    const latest = await getJourney(journeyId).catch(() => null);
    if (latest?.state === "recording") {
      await updateJourney(journeyId, { message: captureErrorMessage(error) }).catch(() => {});
    }
  } finally {
    if (journeyJobs.get(journeyId) === job) journeyJobs.delete(journeyId);
    const latest = await getJourney(journeyId).catch(() => null);
    if (latest && ACTIVE_JOURNEY_STATES.has(latest.state) && pendingJourneyItems(latest).length) {
      drainJourneyQueue(journeyId).catch(() => {});
    }
  }
}

async function enqueueJourneyCapture(journeyId, tabId, url, parentUrl = null, title = "") {
  let queuedItem = null;
  const updated = await updateJourney(journeyId, (journey) => {
    if (journey.state !== "recording" || !journey.trackedTabIds?.includes(tabId)) return null;
    const queued = enqueueJourneyItem(journey, { tabId, url, parentUrl, title });
    if (!queued.queued) return null;
    queuedItem = queued.item;
    return { ...queued.journey, message: journeyProgressMessage(queued.journey) };
  });
  if (!queuedItem) return false;
  const summary = journeyQueueSummary(updated);
  sendPopupMessage({
    type: "JOURNEY_PROGRESS",
    journeyId,
    pages: summary.pageCount,
    message: updated.message,
  });
  drainJourneyQueue(journeyId).catch(() => {});
  return true;
}

async function waitForJourneyQueue(journeyId) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const journey = await getJourney(journeyId);
    if (!journey) return;
    if (!pendingJourneyItems(journey).length && !journeyJobs.has(journeyId)) return;
    try {
      await drainJourneyQueue(journeyId);
    } catch {
      await wait(50);
    }
  }
  throw new Error("Some collected pages are still being saved. Try again in a moment.");
}

async function trackJourneyTab(journeyId, tabId, parentTabId = null) {
  if (!Number.isInteger(tabId)) return null;
  return updateJourney(journeyId, (journey) => {
    if (!ACTIVE_JOURNEY_STATES.has(journey.state)) return null;
    if (journey.trackedTabIds?.includes(tabId)) return null;
    const trackedTabIds = [...(journey.trackedTabIds || []), tabId];
    const tabState = { ...(journey.tabState || {}) };
    if (parentTabId !== null && tabState[parentTabId]) tabState[tabId] = { ...tabState[parentTabId] };
    return { ...journey, trackedTabIds, tabState };
  });
}

async function startJourney(message) {
  if (!Number.isInteger(message.tabId) || !isHttpUrl(message.pageUrl)) {
    throw new Error("This page cannot start a collection.");
  }
  if (captureStarting) throw new Error("Another save is already starting. Wait for it to finish.");
  const current = await getActiveJourney();
  if (current) throw new Error("You’re already collecting pages. Save or discard that collection first.");
  const captures = await listCaptures();
  if (captures.some((capture) => ACTIVE_CAPTURE_STATES.has(capture.state))) {
    throw new Error("Another page is already being saved. Wait for it to finish.");
  }
  const monetization = await getMonetizationState({ refresh: true });
  const isPaid = monetization.entitlement.paid;
  if (!isPaid && monetization.remaining < 1) {
    throw new Error(`You’ve used all ${PRICING.freePagesPerMonth} free saves this month. Upgrade to Pro to keep saving.`);
  }
  const packLimits = effectivePackLimits(message, isPaid);
  const journey = {
    id: `journey_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    state: "recording",
    rootUrl: normalizeUrl(message.pageUrl),
    title: message.pageTitle || message.pageUrl,
    folderId: message.folderId || DEFAULT_FOLDER_ID,
    runScripts: Boolean(message.runScripts),
    captureMedia: true,
    trackedTabIds: [message.tabId],
    tabState: {},
    captureQueue: [],
    pages: [],
    visits: [],
    failures: [],
    totalBytes: 0,
    totalResources: 0,
    ...packLimits,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    message: "Collecting…",
    countAgainstQuota: !isPaid,
  };
  await putJourney(journey);
  updateJourneyBadge(0, true);
  await enqueueJourneyCapture(journey.id, message.tabId, message.pageUrl, null, message.pageTitle);
  return { journeyId: journey.id };
}

async function finishJourney(journeyId, excludedUrls = []) {
  const journey = await getJourney(journeyId);
  if (!journey || !ACTIVE_JOURNEY_STATES.has(journey.state)) throw new Error("That collection is no longer active.");
  if (journeyFinishingIds.has(journeyId)) throw new Error("That collection is already being saved.");
  journeyFinishingIds.add(journeyId);
  await updateJourney(journeyId, { state: "finishing", message: "Saving your collection…" });
  await waitForJourneyQueue(journeyId);
  const latest = await getJourney(journeyId);
  if (!latest) throw new Error("That collection could not be found.");
  if (!latest.pages?.length) {
    await deleteJourney(journeyId);
    journeyFinishingIds.delete(journeyId);
    updateJourneyBadge(0, false);
    return { empty: true };
  }
  const excluded = new Set((Array.isArray(excludedUrls) ? excludedUrls : []).map((url) => normalizeUrl(url)).filter(Boolean));
  // The journey's starting page is always part of the saved journey, even if
  // an older client sends it in the exclusion list.
  const pages = latest.pages.filter((page, index) => index === 0 || !excluded.has(normalizeUrl(page.url)));
  if (!pages.length) throw new Error("Keep at least one page in the collection.");
  const pageUrls = new Set(pages.map((page) => normalizeUrl(page.url)));
  const visits = (latest.visits || []).filter((visit) => pageUrls.has(normalizeUrl(visit.pageUrl)));
  const packLimits = normalizePackLimits(latest);
  const pack = {
    id: makePackId(),
    rootUrl: pages[0].url,
    title: pages[0].title || latest.title || latest.rootUrl,
    savedAt: Date.now(),
    depth: 0,
    captureMode: "journey",
    runScripts: Boolean(latest.runScripts),
    scope: "journey",
    sortOrder: -1,
    folderId: latest.folderId || DEFAULT_FOLDER_ID,
    pages,
    failures: latest.failures || [],
    visits,
    limits: packLimits,
    stats: {
      pages: pages.length,
      bytes: pages.reduce((sum, page) => sum + Number(page.bytes || 0), 0) || latest.totalBytes || 0,
      resources: pages.reduce((sum, page) => sum + Number(page.resourceCount || 0), 0) || latest.totalResources || 0,
      failed: (latest.failures || []).length,
    },
  };
  await putPack(pack);
  if (latest.countAgainstQuota) await consumeFreePages(latest.pages.length).catch(() => {});
  await deleteJourney(journeyId);
  journeyFinishingIds.delete(journeyId);
  updateJourneyBadge(0, false);
  // Never send the saved pages over runtime messaging. Chrome caps a single
  // extension message at 64 MiB; the full pack is already safely in IndexedDB.
  sendPopupMessage({
    type: "JOURNEY_COMPLETE",
    journeyId,
    packId: pack.id,
    pages: pack.stats.pages,
    failed: pack.stats.failed,
  });
  return { pack };
}

async function discardJourney(journeyId) {
  const journey = await getJourney(journeyId);
  if (!journey) throw new Error("That collection is no longer active.");
  await deleteJourney(journeyId);
  journeyFinishingIds.delete(journeyId);
  updateJourneyBadge(0, false);
  sendPopupMessage({ type: "JOURNEY_DISCARDED", journeyId });
}

const CAPTURE_PHASE_STATES = Object.freeze({
  queued: "queued",
  reading: "reading",
  assets: "saving",
  finishing: "finishing",
});

function captureProgressMessage({ phase, pagesDone, pagesTotal, assetsDone, assetsTotal }) {
  if (phase === "reading") return "Reading this page…";
  if (phase === "finishing") return "Finishing up…";
  const files = assetsTotal ? `${assetsDone} of ${assetsTotal} files` : "collecting files";
  if (pagesTotal > 1) return `Page ${Math.min(pagesDone + 1, pagesTotal)} of ${pagesTotal} · ${files}`;
  return `Saving ${files}`;
}

function cancelCaptureStream(requestId) {
  const session = captureStreams.get(requestId);
  if (!session) return;
  clearTimeout(session.timeout);
  captureStreams.delete(requestId);
  session.reject(new CaptureCancelledError());
  try {
    session.port?.disconnect();
  } catch {
    // The content script may already have disconnected.
  }
}

async function runCapture({ tabId, pageUrl, depth, runScripts, captureMedia, folderId, requestId, maxPages, maxTotalBytes, countAgainstQuota }) {
  const job = {
    abortController: new AbortController(),
    cancelled: cancelledCaptureIds.has(requestId),
    committed: false,
  };
  captureJobs.set(requestId, job);
  // Only a link-following save has a page count worth showing; a single-page
  // save keeps the plain dot.
  setCaptureBadge(true, { following: clampDepth(depth) > 0 });
  const progress = {
    phase: "reading",
    pagesDone: 0,
    pagesTotal: 1,
    assetsDone: 0,
    assetsTotal: 0,
    // Link-following discovers pages as it goes, so only a single-page save can
    // promise an honest percentage.
    determinate: Number(depth) === 0,
  };
  let lastProgressAt = 0;
  const publishProgress = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 250) return;
    lastProgressAt = now;
    const payload = { ...progress, message: captureProgressMessage(progress) };
    sendPopupMessage({ type: "CAPTURE_PROGRESS", requestId, ...payload });
    await updateCapture(requestId, { state: CAPTURE_PHASE_STATES[progress.phase] || "saving", ...payload }).catch(() => {});
  };
  try {
    throwIfCaptureCancelled(requestId);
    await publishProgress(true);
  const options = { runScripts, captureMedia, requestId, signal: job.abortController.signal };
  let root;
  try {
    root = await streamPageFromTab(tabId, requestId, { runScripts, captureMedia });
  } catch (liveError) {
    // A content script can be unavailable on a page even though the page can
    // still be fetched. Keep the save useful by falling back to the network
    // snapshot before surfacing the error.
    try {
      const fetched = await fetchPageSource(pageUrl, options);
      root = {
        meta: { url: fetched.url, title: fetched.title, resources: fetched.resources },
        html: fetched.html,
      };
    } catch {
      throw liveError;
    }
  }
  const resourceCache = new Map();
  const pages = [];
  const failures = [];
  let totalBytes = 0;
  let processedPages = 0;
  let pageLimitReached = false;
  let byteLimitReached = false;
  // Pages whose resources were actually fetched. A page left in the queue when
  // the size ceiling stopped the run has markup made only of unresolved tokens,
  // so it must not reach the library.
  const hydratedPages = new Set();
  const packLimits = normalizePackLimits({ maxPages, maxTotalBytes });
  const capturePageLimit = packLimits.maxPages;
  const rootPage = {
    url: normalizeUrl(root.meta.url),
    title: root.meta.title || root.meta.url,
    html: root.html,
    resources: root.meta.resources || [],
    resourceMap: {},
  };
  // `captureLivePage` guards this for the live tab; this path did not, and an
  // address `normalizeUrl` could not parse produced an empty string that reached
  // `isLinkInScope`, where `new URL("")` threw a bare TypeError and failed the
  // whole save with a message about an invalid URL.
  if (!rootPage.url) throw new Error("This page's address could not be read, so it cannot be saved.");
  pages.push(rootPage);

  const visited = new Set([rootPage.url]);
  const queue = [{ url: rootPage.url, level: 0 }];
  while (queue.length) {
    throwIfCaptureCancelled(requestId);
    const current = queue.shift();
    if (current.level > depth) continue;
    const page = pages.find((item) => item.url === current.url);
    if (!page) continue;
    progress.phase = "assets";
    progress.pagesTotal = pages.length;
    const assetsBefore = progress.assetsDone;
    const assetTotalBefore = progress.assetsTotal;
    await publishProgress(true);
    const resourceResult = await hydrateResources(page, resourceCache, options, (done, total) => {
      progress.assetsDone = assetsBefore + done;
      progress.assetsTotal = assetTotalBefore + total;
      publishProgress();
    });
    throwIfCaptureCancelled(requestId);
    processedPages += 1;
    progress.pagesDone = processedPages;
    setCaptureBadgePages(processedPages);
    totalBytes += resourceResult.bytes;
    failures.push(...resourceResult.failures.map((failure) => ({ ...failure, type: "resource", pageUrl: page.url })));
    hydratedPages.add(page);
    /* Stop, keep what is already saved, and say so.

       This used to `throw`, which failed the whole capture and wrote nothing: a
       249-page crawl that crossed the ceiling on page 250 discarded all 249 and
       told the user only that the save was too large. The page cap immediately
       below had always degraded gracefully instead. There was no reason for the
       two ceilings to behave differently, and the destructive one was the
       surprise. Pages fetched but not yet hydrated are dropped below, because
       their markup is all unresolved tokens. */
    if (totalBytes > packLimits.maxTotalBytes) {
      byteLimitReached = true;
      break;
    }
    // Nothing more will be added once the page cap is reached, so there is no
    // point re-reading the links of every page still in the queue.
    if (current.level >= depth || pageLimitReached) continue;
    const pageLinks = linksFromMarkup(page.html, page.url);
    if (pageLinks.truncated) {
      failures.push({
        type: "page-limit",
        pageUrl: page.url,
        message: `This page had more than ${MAX_LINKS_PER_PAGE} links, so only the first ${MAX_LINKS_PER_PAGE} were followed.`,
      });
    }
    for (const url of pageLinks.links) {
      throwIfCaptureCancelled(requestId);
      if (visited.has(url)) continue;
      if (pages.length >= capturePageLimit) {
        pageLimitReached = true;
        break;
      }
      visited.add(url);
      try {
        const fetched = await fetchPageSource(url, options);
        const child = { ...fetched, resourceMap: {} };
        pages.push(child);
        queue.push({ url: child.url, level: current.level + 1 });
      } catch (error) {
        if (isCaptureCancelled(requestId)) throw error;
        failures.push({ type: "page", url, message: error.message || "The linked page could not be saved." });
      }
    }
  }

  if (pageLimitReached) {
    failures.push({
      type: "page-limit",
      message: `This pack reached PagePack’s ${packLimits.maxPages}-page safety limit.`,
    });
  }

  // A page that was fetched but never hydrated has markup made entirely of
  // unresolved resource tokens, so it would open blank. Only reachable when the
  // size ceiling stopped the run early.
  const droppedPages = pages.length - hydratedPages.size;
  const savedPages = droppedPages ? pages.filter((page) => hydratedPages.has(page)) : pages;
  if (byteLimitReached) {
    failures.push({
      type: "pack-limit",
      message: `This save reached PagePack’s ${formatPackSize(packLimits.maxTotalBytes)} size limit, so it stopped early`
        + `${droppedPages ? ` and left out ${droppedPages} page${droppedPages === 1 ? "" : "s"}` : ""}.`
        + " The pages already saved were kept. Raise the limit under Options, or save fewer linked pages.",
    });
  }

  const pack = {
    id: makePackId(),
    rootUrl: rootPage.url,
    title: rootPage.title,
    savedAt: Date.now(),
    depth,
    runScripts: Boolean(runScripts),
    scope: "site",
    sortOrder: -1,
    folderId: folderId || DEFAULT_FOLDER_ID,
    limits: packLimits,
    pages: savedPages,
    failures,
    stats: { pages: savedPages.length, bytes: totalBytes, resources: resourceCache.size, failed: failures.length },
  };
  throwIfCaptureCancelled(requestId);
  progress.phase = "finishing";
  progress.pagesTotal = savedPages.length;
  await publishProgress(true);
  await putPack(pack);
  job.committed = true;
  // The allowance is charged for what was kept, not for what was fetched.
  if (countAgainstQuota) await consumeFreePages(savedPages.length).catch(() => {});
  await deleteCapture(requestId).catch(() => {});
  // Keep completion messages small. The popup reloads the compact library
  // index instead of receiving the captured HTML through the message bus.
  sendPopupMessage({
    type: "CAPTURE_COMPLETE",
    requestId,
    packId: pack.id,
    pages: pack.stats.pages,
    failed: pack.stats.failed,
  });
  } finally {
    captureJobs.delete(requestId);
    setCaptureBadge(false);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pagepack-capture") return;
  const onMessage = (message) => {
    if (message?.type !== "capture-start" && message?.type !== "capture-chunk" && message?.type !== "capture-end") return;
    const session = captureStreams.get(message.requestId);
    if (!session) return;
    session.port = port;
    if (message.type === "capture-start") session.meta = message.meta;
    if (message.type === "capture-chunk") session.chunks.push(String(message.chunk || ""));
    if (message.type === "capture-end") {
      clearTimeout(session.timeout);
      captureStreams.delete(message.requestId);
      if (!session.meta) {
        session.reject(new Error("The page capture was incomplete."));
        return;
      }
      session.resolve({ meta: session.meta, html: session.chunks.join("") });
    }
  };
  const onDisconnect = () => {
    for (const [requestId, session] of captureStreams) {
      if (session.port === port) {
        clearTimeout(session.timeout);
        captureStreams.delete(requestId);
        session.reject(new Error("The page closed before capture finished."));
      }
    }
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
});

async function prepareCapture(message) {
  if (captureStarting) throw new Error("Another page is already being saved. Wait for it to finish.");
  captureStarting = true;
  try {
    await recoveryReady;
    const captures = await listCaptures();
    if (captures.some((capture) => ACTIVE_CAPTURE_STATES.has(capture.state))) {
      throw new Error("Another page is already being saved. Wait for it to finish.");
    }
    if (await getActiveJourney()) {
      throw new Error("You’re collecting pages right now. Save or discard that collection first.");
    }
    await Promise.all(captures
      .filter((capture) => capture.state === "failed" || capture.state === "interrupted")
      .map((capture) => deleteCapture(capture.id)));

    const monetization = await getMonetizationState({ refresh: true });
    const isPaid = monetization.entitlement.paid;
    if (!isPaid && monetization.remaining < 1) {
      throw new Error(`You’ve used all ${PRICING.freePagesPerMonth} free saves this month. Upgrade to Pro to keep saving.`);
    }
    const packLimits = effectivePackLimits(message, isPaid);

    const requestId = `capture_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const capture = {
      id: requestId,
      state: "queued",
      phase: "queued",
      message: "Starting save…",
      error: null,
      tabId: message.tabId,
      pageUrl: message.pageUrl || "",
      pageTitle: message.pageTitle || "",
      depth: clampDepth(message.depth),
      ...packLimits,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      workerId: WORKER_ID,
    };
    await putCapture(capture);
    return {
      requestId,
      depth: clampDepth(message.depth),
      ...packLimits,
      countAgainstQuota: !isPaid,
      captureMedia: true,
    };
  } finally {
    captureStarting = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CAPTURE_STREAM_ERROR") {
    const session = captureStreams.get(message.requestId);
    if (session) {
      clearTimeout(session.timeout);
      captureStreams.delete(message.requestId);
      session.reject(new Error(message.message || "The page capture failed."));
    }
    return false;
  }
  if (message?.type === "CANCEL_CAPTURE") {
    (async () => {
      const requestId = String(message.requestId || "");
      const capture = await getCapture(requestId);
      if (!capture || !ACTIVE_CAPTURE_STATES.has(capture.state)) {
        sendResponse({ error: "This save is no longer active." });
        return;
      }
      const job = captureJobs.get(requestId);
      if (job?.committed) {
        sendResponse({ error: "This save has already finished." });
        return;
      }
      cancelledCaptureIds.add(requestId);
      if (job) {
        job.cancelled = true;
        job.abortController.abort();
      }
      cancelCaptureStream(requestId);
      if (!job) {
        await deleteCapture(requestId).catch(() => {});
        sendPopupMessage({ type: "CAPTURE_CANCELLED", requestId });
      }
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ error: error.message || "The save could not be cancelled." }));
    return true;
  }
  if (message?.type === "START_JOURNEY") {
    startJourney(message)
      .then((access) => sendResponse({ accepted: true, journeyId: access.journeyId }))
      .catch((error) => sendResponse({ error: captureErrorMessage(error) }));
    return true;
  }
  if (message?.type === "FINISH_JOURNEY") {
    const journeyId = String(message.journeyId || "");
    finishJourney(journeyId, message.excludedUrls)
      .then((result) => sendResponse({ ok: true, empty: Boolean(result.empty), packId: result.pack?.id || null }))
      .catch(async (error) => {
        journeyFinishingIds.delete(journeyId);
        await updateJourney(journeyId, { state: "recording", message: `${captureErrorMessage(error)} Keep browsing and try again.` }).catch(() => {});
        sendResponse({ error: captureErrorMessage(error) });
      });
    return true;
  }
  if (message?.type === "DISCARD_JOURNEY") {
    discardJourney(String(message.journeyId || ""))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: captureErrorMessage(error) }));
    return true;
  }
  if (message?.type === "START_CAPTURE") {
    prepareCapture(message)
      .then((access) => {
        sendResponse({ accepted: true, requestId: access.requestId });
        runCapture({ ...message, ...access }).catch(async (error) => {
          if (isCaptureCancelled(access.requestId) || error?.code === "CAPTURE_CANCELLED") {
            await deleteCapture(access.requestId).catch(() => {});
            cancelledCaptureIds.delete(access.requestId);
            sendPopupMessage({ type: "CAPTURE_CANCELLED", requestId: access.requestId });
            return;
          }
          const messageText = captureErrorMessage(error);
          await updateCapture(access.requestId, {
            state: "failed",
            phase: "failed",
            message: messageText,
            error: messageText,
          }).catch(() => {});
          sendPopupMessage({ type: "CAPTURE_ERROR", requestId: access.requestId, message: messageText });
        });
      })
      .catch((error) => {
        sendResponse({ error: captureErrorMessage(error) });
      });
    return true;
  }
  if (message?.type === "GET_MONETIZATION") {
    getMonetizationState({ refresh: Boolean(message.refresh) })
      .then((state) => sendResponse({ state }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "OPEN_PRO_PAGE") {
    openPaymentPage(message.mode)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "LIST_LIBRARY") {
    Promise.all([recoveryReady, listPacks(), listFolders(), listCaptures(), listJourneySummaries()])
      .then(([, packs, folders, captures, journeys]) => sendResponse({ packs, folders, captures, journeys }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "SEARCH_LIBRARY") {
    searchPackText(message.query)
      .then((packIds) => sendResponse({ packIds }))
      .catch(() => sendResponse({ packIds: [] }));
    return true;
  }
  if (message?.type === "GET_PACK_ISSUES") {
    getPackIssues(String(message.packId || ""))
      .then((issues) => sendResponse({ issues }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "RENAME_FOLDER") {
    renameFolder(String(message.id || ""), message.name)
      .then((folder) => sendResponse({ ok: true, folder }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "GET_CAPTURE_PREFERENCES") {
    getSetting(CAPTURE_PREFERENCES_KEY, DEFAULT_CAPTURE_PREFERENCES)
      .then((preferences) => sendResponse({ preferences: normalizeCapturePreferences(preferences) }))
      .catch((error) => sendResponse({ error: error.message || "Capture preferences could not be loaded." }));
    return true;
  }
  if (message?.type === "SET_CAPTURE_PREFERENCES") {
    const preferences = normalizeCapturePreferences(message.preferences);
    setSetting(CAPTURE_PREFERENCES_KEY, preferences)
      .then(() => sendResponse({ ok: true, preferences }))
      .catch((error) => sendResponse({ error: error.message || "Capture preferences could not be saved." }));
    return true;
  }
  if (message?.type === "RETRY_PACK_ISSUE") {
    retryPackIssue(message.packId, message.issueIndex)
      .then((pack) => sendResponse({ ok: true, packId: pack.id }))
      .catch((error) => sendResponse({ error: captureErrorMessage(error) }));
    return true;
  }
  if (message?.type === "IGNORE_PACK_ISSUE") {
    ignorePackIssue(message.packId, message.issueIndex)
      .then((pack) => sendResponse({ ok: true, packId: pack.id }))
      .catch((error) => sendResponse({ error: captureErrorMessage(error) }));
    return true;
  }
  if (message?.type === "IGNORE_ALL_PACK_ISSUES") {
    ignoreAllPackIssues(message.packId)
      .then((pack) => sendResponse({ ok: true, packId: pack.id }))
      .catch((error) => sendResponse({ error: captureErrorMessage(error) }));
    return true;
  }
  if (message?.type === "REPAIR_PACK") {
    getPack(message.id)
      .then((pack) => repairPackResources(pack))
      .then((pack) => sendResponse({ ok: true, packId: pack.id }))
      .catch((error) => sendResponse({ error: error.message || "Could not repair saved resources." }));
    return true;
  }
  if (message?.type === "DELETE_PACK") {
    deletePack(message.id).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "REMOVE_PACK_PAGE") {
    removePackPage(message.id, message.pageIndex)
      .then((pack) => sendResponse({ ok: true, packId: pack.id }))
      .catch((error) => sendResponse({ error: captureErrorMessage(error) }));
    return true;
  }
  if (message?.type === "CREATE_FOLDER") {
    const name = String(message.name || "").trim().slice(0, FOLDER_NAME_LIMIT);
    if (!name) {
      sendResponse({ error: "Give the folder a name." });
      return false;
    }
    listFolders()
      .then((folders) => {
        const sortOrder = folders.reduce((highest, folder, index) => {
          const value = Number(folder.sortOrder);
          return Math.max(highest, Number.isFinite(value) ? value : index);
        }, -1) + 1;
        return { id: makeFolderId(), name, createdAt: Date.now(), sortOrder };
      })
      .then((folder) => putFolder(folder).then(() => sendResponse({ folder })))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "DELETE_FOLDER") {
    deleteFolder(message.id).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "MOVE_PACK") {
    movePack(message.id, message.folderId).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "MOVE_AND_REORDER_PACK") {
    moveAndReorderPack(message.id, message.folderId, message.orderedIds)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "REORDER_FOLDERS") {
    reorderFolders(message.folderIds).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  return false;
});

async function offlineReaderUrl(match) {
  let pageIndex = Number(match?.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    const pack = await getPack(match?.packId).catch(() => null);
    const pageUrl = normalizeUrl(match?.pageUrl || match?.url);
    pageIndex = pack?.pages?.findIndex((page) => normalizeUrl(page.url) === pageUrl) ?? -1;
  }
  if (!Number.isInteger(pageIndex) || pageIndex < 0) pageIndex = 0;
  return chrome.runtime.getURL(`viewer.html?pack=${encodeURIComponent(match.packId)}&page=${pageIndex}`);
}

function maybeRedirectOffline(details) {
  if (details.frameId !== 0 || !isHttpUrl(details.url)) return;
  findSavedUrl(details.url).then(async (match) => {
    if (!match) return;
    chrome.tabs.update(details.tabId, { url: await offlineReaderUrl(match) }, () => void chrome.runtime.lastError);
  }).catch(() => {});
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (navigator.onLine === false) maybeRedirectOffline(details);
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0 || !isHttpUrl(details.url)) return;
  const message = String(details.error || "");
  if (/ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|CONNECTION|ADDRESS_UNREACHABLE|TIMED_OUT)/i.test(message)) {
    maybeRedirectOffline(details);
  }
});

async function handleJourneyNavigation(details) {
  if (details.frameId !== 0 || !isHttpUrl(details.url)) return;
  const trackingJob = journeyTabTrackingJobs.get(details.tabId);
  if (trackingJob) await trackingJob.catch(() => {});
  const journeys = await listJourneySummaries().catch(() => []);
  for (const summary of journeys.filter((journey) => journey.state === "recording")) {
    if (!summary.id) continue;
    const journey = await getJourney(summary.id).catch(() => null);
    if (!journey?.trackedTabIds?.includes(details.tabId) || journey.state !== "recording") continue;
    const parentUrl = journey.tabState?.[details.tabId]?.lastQueuedUrl
      || journey.tabState?.[details.tabId]?.lastCapturedUrl
      || journey.rootUrl
      || null;
    await enqueueJourneyCapture(journey.id, details.tabId, details.url, parentUrl);
  }
}

function queueJourneyNavigation(details) {
  journeyNavigationChain = journeyNavigationChain
    .catch(() => {})
    .then(() => handleJourneyNavigation(details));
}

chrome.webNavigation.onCommitted.addListener((details) => {
  queueJourneyNavigation(details);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  queueJourneyNavigation(details);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  queueJourneyNavigation(details);
});

chrome.tabs.onCreated.addListener((tab) => {
  const trackingJob = getActiveJourney().then(async (journey) => {
    if (!journey || journey.state !== "recording" || !Number.isInteger(tab.openerTabId)) return;
    if (!journey.trackedTabIds?.includes(tab.openerTabId)) return;
    await trackJourneyTab(journey.id, tab.id, tab.openerTabId);
    const initialUrl = tab.pendingUrl || tab.url || "";
    const parentUrl = journey.tabState?.[tab.openerTabId]?.lastQueuedUrl
      || journey.tabState?.[tab.openerTabId]?.lastCapturedUrl
      || journey.rootUrl;
    if (isHttpUrl(initialUrl)) await enqueueJourneyCapture(journey.id, tab.id, initialUrl, parentUrl, tab.title);
  }).catch(() => {});
  journeyTabTrackingJobs.set(tab.id, trackingJob);
  trackingJob.finally(() => {
    if (journeyTabTrackingJobs.get(tab.id) === trackingJob) journeyTabTrackingJobs.delete(tab.id);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getActiveJourney().then(async (journey) => {
    if (!journey?.trackedTabIds?.includes(tabId)) return;
    await updateJourney(journey.id, (latest) => {
      const trackedTabIds = (latest.trackedTabIds || []).filter((id) => id !== tabId);
      const tabState = { ...(latest.tabState || {}) };
      delete tabState[tabId];
      return { ...latest, trackedTabIds, tabState };
    });
  }).catch(() => {});
});

export function normalizeJourneyUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/i.test(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

export function enqueueJourneyItem(journey, item) {
  const url = normalizeJourneyUrl(item?.url);
  const tabId = Number(item?.tabId);
  if (!url || !Number.isInteger(tabId)) return { journey, queued: false, item: null };

  const savedUrls = new Set((journey.pages || []).map((page) => normalizeJourneyUrl(page.url)).filter(Boolean));
  const captureQueue = Array.isArray(journey.captureQueue) ? journey.captureQueue : [];
  const alreadyQueued = captureQueue.some((queuedItem) => normalizeJourneyUrl(queuedItem.url) === url);
  if (savedUrls.has(url) || alreadyQueued) return { journey, queued: false, item: null };

  const tabState = { ...(journey.tabState || {}) };
  const previousState = { ...(tabState[tabId] || {}) };
  const rootUrl = normalizeJourneyUrl(journey.rootUrl);
  const isUncapturedRoot = url === rootUrl && !previousState.lastQueuedUrl && !previousState.lastCapturedUrl;
  const parentUrl = isUncapturedRoot
    ? null
    : normalizeJourneyUrl(item.parentUrl)
      || normalizeJourneyUrl(previousState.lastQueuedUrl)
      || normalizeJourneyUrl(previousState.lastCapturedUrl)
      || rootUrl
      || null;
  const queuedItem = {
    id: String(item.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    tabId,
    url,
    title: String(item.title || url),
    parentUrl,
    queuedAt: Number(item.queuedAt) || Date.now(),
    attempts: Math.max(0, Number(item.attempts) || 0),
  };
  tabState[tabId] = { ...previousState, lastQueuedUrl: url };
  return {
    journey: { ...journey, captureQueue: [...captureQueue, queuedItem], tabState },
    queued: true,
    item: queuedItem,
  };
}

export function removeJourneyItem(journey, itemId) {
  const captureQueue = (Array.isArray(journey.captureQueue) ? journey.captureQueue : [])
    .filter((item) => item.id !== itemId);
  return { ...journey, captureQueue };
}

export function pendingJourneyItems(journey) {
  return (Array.isArray(journey?.captureQueue) ? journey.captureQueue : [])
    .filter((item) => item.state !== "failed");
}

export function journeyQueueSummary(journey) {
  const savedPages = Array.isArray(journey.pages) ? journey.pages : [];
  const savedUrls = new Set(savedPages.map((page) => normalizeJourneyUrl(page.url)).filter(Boolean));
  const queuedPages = (Array.isArray(journey.captureQueue) ? journey.captureQueue : [])
    .filter((item) => !savedUrls.has(normalizeJourneyUrl(item.url)));
  const pendingPages = queuedPages.filter((item) => item.state !== "failed");
  const failedPages = queuedPages.filter((item) => item.state === "failed");
  return {
    savedCount: savedPages.length,
    queuedCount: queuedPages.length,
    pendingCount: pendingPages.length,
    failedCount: failedPages.length,
    pageCount: savedPages.length + queuedPages.length,
    pageTitles: [
      ...savedPages.map((page) => ({
        url: page.url,
        title: page.title || page.url,
        state: page.state || "saved",
      })),
      ...queuedPages.map((item) => ({
        url: item.url,
        title: item.title || item.url,
        state: item.state || "queued",
        attempts: Number(item.attempts) || 0,
      })),
    ].slice(0, 250),
  };
}

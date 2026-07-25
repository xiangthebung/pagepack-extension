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

function issueAt(pack, issueIndex) {
  const failures = Array.isArray(pack?.failures) ? pack.failures : [];
  const index = Number(issueIndex);
  return { failures, index, issue: failures[index] };
}

async function recordRetryFailure(pack, failures, index, error, putPack) {
  const message = String(error?.message || error || "The retry failed.");
  pack.failures = failures.map((failure, failureIndex) => failureIndex === index
    ? { ...failure, message, retryCount: Number(failure.retryCount || 0) + 1, lastRetriedAt: Date.now() }
    : failure);
  pack.stats = { ...(pack.stats || {}), failed: pack.failures.length };
  await putPack(pack);
}

export async function retryPackPageIssue(pack, issueIndex, dependencies) {
  const { fetchPageSource, hydrateResources, putPack, maxTotalBytes = Number.POSITIVE_INFINITY } = dependencies;
  const { failures, index, issue } = issueAt(pack, issueIndex);
  if (!issue || issue.type !== "page" || !isHttpUrl(issue.url)) {
    throw new Error("This error cannot be retried as a page.");
  }
  const targetUrl = normalizeUrl(issue.url, issue.pageUrl || pack.rootUrl);
  if (!targetUrl) throw new Error("The failed page URL is unavailable.");
  if ((pack.pages || []).some((page) => normalizeUrl(page.url) === targetUrl)) {
    pack.failures = failures.filter((_, failureIndex) => failureIndex !== index);
    pack.stats = { ...(pack.stats || {}), failed: pack.failures.length };
    await putPack(pack);
    return pack;
  }
  const requestId = `retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const fetched = await fetchPageSource(targetUrl, {
      runScripts: Boolean(pack.runScripts),
      captureMedia: true,
      requestId,
    });
    const page = { ...fetched, resourceMap: {}, capturedAt: Date.now() };
    const resourceCache = new Map();
    const resourceResult = await hydrateResources(page, resourceCache, {
      runScripts: Boolean(pack.runScripts),
      captureMedia: true,
      requestId,
    }, () => {});
    const previousStats = pack.stats || {};
    const totalBytes = Number(previousStats.bytes || 0) + resourceResult.bytes;
    if (totalBytes > maxTotalBytes) throw new Error("This retry would exceed the pack’s storage limit.");
    page.bytes = resourceResult.bytes;
    page.resourceCount = resourceCache.size;
    const nextFailures = failures
      .filter((_, failureIndex) => failureIndex !== index)
      .concat(resourceResult.failures.map((failure) => ({ ...failure, type: "resource", pageUrl: page.url })));
    pack.pages = [...(pack.pages || []), page];
    pack.failures = nextFailures;
    pack.stats = {
      ...previousStats,
      pages: pack.pages.length,
      bytes: totalBytes,
      resources: Number(previousStats.resources || 0) + resourceCache.size,
      failed: nextFailures.length,
    };
    if (Array.isArray(pack.visits)) {
      pack.visits = [...pack.visits, { pageUrl: page.url, parentUrl: issue.pageUrl || pack.rootUrl, capturedAt: Date.now() }];
    }
    await putPack(pack);
    return pack;
  } catch (error) {
    await recordRetryFailure(pack, failures, index, error, putPack);
    throw error;
  }
}

export async function retryPackResourceIssue(pack, issueIndex, dependencies) {
  const { fetchResource, putPack, maxTotalBytes = Number.POSITIVE_INFINITY } = dependencies;
  const { failures, index, issue } = issueAt(pack, issueIndex);
  if (!issue || issue.type !== "resource" || !isHttpUrl(issue.url) || !isHttpUrl(issue.pageUrl)) {
    throw new Error("This error cannot be retried as an asset.");
  }
  const pageUrl = normalizeUrl(issue.pageUrl);
  const page = (pack.pages || []).find((candidate) => normalizeUrl(candidate.url) === pageUrl);
  if (!page) throw new Error("The page containing this asset is not in the pack.");
  const resource = (page.resources || []).find((candidate) => normalizeUrl(candidate.url, page.url) === normalizeUrl(issue.url, page.url));
  if (!resource) throw new Error("The failed asset is no longer part of this page.");
  try {
    const resourceCache = new Map();
    const result = await fetchResource(resource, resourceCache);
    page.resourceMap = { ...(page.resourceMap || {}), [resource.token]: result.dataUrl };
    const nextFailures = failures.filter((_, failureIndex) => failureIndex !== index);
    const previousStats = pack.stats || {};
    const totalBytes = Number(previousStats.bytes || 0) + result.bytes;
    if (totalBytes > maxTotalBytes) throw new Error("This retry would exceed the pack’s storage limit.");
    pack.failures = nextFailures;
    pack.stats = {
      ...previousStats,
      bytes: totalBytes,
      resources: Number(previousStats.resources || 0) + resourceCache.size,
      failed: nextFailures.length,
    };
    await putPack(pack);
    return pack;
  } catch (error) {
    await recordRetryFailure(pack, failures, index, error, putPack);
    throw error;
  }
}

export async function retryPackIssue(pack, issueIndex, dependencies) {
  const issue = pack?.failures?.[Number(issueIndex)];
  if (issue?.type === "resource") return retryPackResourceIssue(pack, issueIndex, dependencies);
  return retryPackPageIssue(pack, issueIndex, dependencies);
}

export async function ignorePackIssue(pack, issueIndex, putPack) {
  const { failures, index } = issueAt(pack, issueIndex);
  if (!failures[index]) throw new Error("This error is no longer available.");
  pack.failures = failures.filter((_, failureIndex) => failureIndex !== index);
  pack.stats = { ...(pack.stats || {}), failed: pack.failures.length };
  await putPack(pack);
  return pack;
}

export async function ignoreAllPackIssues(pack, putPack) {
  pack.failures = [];
  pack.stats = { ...(pack.stats || {}), failed: 0 };
  await putPack(pack);
  return pack;
}

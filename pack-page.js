function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return String(value || "");
  }
}

/**
 * Remove one captured page while keeping the pack's derived counters and
 * navigation history consistent. The final page stays in place so a pack
 * never becomes an empty, unopenable item.
 */
export function removePackPageFromPack(pack, pageIndex) {
  const pages = Array.isArray(pack?.pages) ? pack.pages : [];
  const index = Number(pageIndex);
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
    throw new Error("This captured page is no longer available.");
  }
  if (pages.length <= 1) {
    throw new Error("Keep at least one page in a saved pack.");
  }

  const removedPage = pages[index];
  const removedUrl = normalizeUrl(removedPage.url);
  const remainingPages = pages.filter((_, currentIndex) => currentIndex !== index);
  const isFailureForRemovedPage = (failure) => {
    const failurePageUrl = normalizeUrl(failure?.pageUrl);
    const failureUrl = normalizeUrl(failure?.url);
    return (failure.type === "resource" && failurePageUrl === removedUrl)
      || (failure.type === "page" && failureUrl === removedUrl);
  };
  const failures = (Array.isArray(pack.failures) ? pack.failures : []).filter((failure) => !isFailureForRemovedPage(failure));
  const visits = (Array.isArray(pack.visits) ? pack.visits : [])
    .filter((visit) => normalizeUrl(visit.pageUrl) !== removedUrl);
  const hasPageByteTotals = pages.every((page) => Object.prototype.hasOwnProperty.call(page, "bytes"));
  const hasPageResourceTotals = pages.every((page) => Object.prototype.hasOwnProperty.call(page, "resourceCount"));
  const bytes = hasPageByteTotals
    ? remainingPages.reduce((total, page) => total + Number(page.bytes || 0), 0)
    : Math.max(0, Number(pack.stats?.bytes || 0) - Number(removedPage.bytes || 0));
  const resources = hasPageResourceTotals
    ? remainingPages.reduce((total, page) => total + Number(page.resourceCount || 0), 0)
    : Math.max(0, Number(pack.stats?.resources || 0) - Number(removedPage.resourceCount || 0));

  pack.pages = remainingPages;
  pack.failures = failures;
  pack.visits = visits;
  pack.stats = {
    ...(pack.stats || {}),
    pages: remainingPages.length,
    bytes,
    resources,
    failed: failures.length,
  };
  return { pack, removedPage };
}

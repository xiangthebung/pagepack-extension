import { getSetting, setSetting } from "./storage.js";

export const PRICING = Object.freeze({
  freePagesPerMonth: 25,
  currency: "CAD",
  monthlyPrice: "CAD $1.99/month",
  yearlyPrice: "CAD $9.99/year",
  // Permanent ID shown by the ExtensionPay dashboard: ExtPay('pagepack').
  extensionPayId: "pagepack",
});

const GIB = 1024 * 1024 * 1024;

export const DEFAULT_PACK_LIMITS = Object.freeze({
  maxPages: 250,
  maxTotalBytes: GIB,
});

export const PRO_PACK_LIMIT_OPTIONS = Object.freeze({
  maxPages: Object.freeze([250, 500, 1000]),
  maxTotalBytes: Object.freeze([GIB, 2 * GIB, 4 * GIB]),
});

export function normalizePackLimits(value = {}) {
  const maxPages = Number(value.maxPages);
  const maxTotalBytes = Number(value.maxTotalBytes);
  return {
    maxPages: PRO_PACK_LIMIT_OPTIONS.maxPages.includes(maxPages) ? maxPages : DEFAULT_PACK_LIMITS.maxPages,
    maxTotalBytes: PRO_PACK_LIMIT_OPTIONS.maxTotalBytes.includes(maxTotalBytes) ? maxTotalBytes : DEFAULT_PACK_LIMITS.maxTotalBytes,
  };
}

export function effectivePackLimits(value, isPaid) {
  return isPaid ? normalizePackLimits(value) : DEFAULT_PACK_LIMITS;
}

const USAGE_KEY = "pagepack-usage-v1";
const PAYMENT_CACHE_KEY = "pagepack-payment-cache-v2";
const PAYMENT_API_KEY = "pagepack-extensionpay-key-v2";
const PAYMENT_HOST = "https://extensionpay.com";
const PAID_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result || {});
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function periodKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export async function getUsage() {
  const period = periodKey();
  const stored = await getSetting(USAGE_KEY, null);
  if (!stored || stored.period !== period) return { period, pages: 0 };
  return { period, pages: Math.max(0, Number(stored.pages) || 0) };
}

export async function consumeFreePages(count) {
  const usage = await getUsage();
  const next = { ...usage, pages: usage.pages + Math.max(0, Number(count) || 0) };
  await setSetting(USAGE_KEY, next);
  return next;
}

function extensionUrl(path = "") {
  return `${PAYMENT_HOST}/extension/${encodeURIComponent(PRICING.extensionPayId)}${path}`;
}

async function installationIsDevelopment() {
  try {
    const info = await chrome.management.getSelf();
    return info.installType === "development";
  } catch {
    return false;
  }
}

async function paymentKey(create = false) {
  const stored = await storageGet([PAYMENT_API_KEY]);
  if (stored[PAYMENT_API_KEY] || !create) return stored[PAYMENT_API_KEY] || null;
  const response = await fetch(extensionUrl("/api/new-key"), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ development: await installationIsDevelopment() }),
  });
  if (!response.ok) {
    let detail = "";
    try { detail = String((await response.json())?.message || ""); } catch {}
    if (/not found|no extension/i.test(detail)) {
      throw new Error(`PagePack Pro is not connected. Register “${PRICING.extensionPayId}” in ExtensionPay, then try again.`);
    }
    throw new Error("PagePack Pro payments could not be reached. Try again later.");
  }
  const key = await response.json();
  await storageSet({ [PAYMENT_API_KEY]: key });
  return key;
}

function normalizedUser(user) {
  return {
    paid: Boolean(user?.paid),
    email: user?.email || null,
    subscriptionStatus: user?.subscriptionStatus || null,
    subscriptionCancelAt: user?.subscriptionCancelAt || null,
    plan: user?.plan || null,
  };
}

async function cachedPayment() {
  const stored = await storageGet([PAYMENT_CACHE_KEY]);
  return stored[PAYMENT_CACHE_KEY] || null;
}

async function fetchPaymentUser() {
  const key = await paymentKey(false);
  if (!key) return normalizedUser(null);
  const response = await fetch(`${extensionUrl("/api/v2/user")}?api_key=${encodeURIComponent(key)}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("PagePack could not refresh the Pro subscription.");
  const user = normalizedUser(await response.json());
  await storageSet({ [PAYMENT_CACHE_KEY]: { user, checkedAt: Date.now() } });
  return user;
}

async function getProviderStatus() {
  try {
    const response = await fetch(extensionUrl("/api/v2/current-plans"), {
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return { configured: false, plans: [] };
    if (!response.ok) return { configured: null, plans: [] };
    const plans = await response.json();
    return { configured: Array.isArray(plans) && plans.length > 0, plans: Array.isArray(plans) ? plans : [] };
  } catch {
    return { configured: null, plans: [] };
  }
}

export async function getEntitlement({ refresh = false } = {}) {
  const cached = await cachedPayment();
  if (refresh) {
    try {
      const user = await fetchPaymentUser();
      return { ...user, source: "live" };
    } catch (error) {
      const checkedAt = Number(cached?.checkedAt || 0);
      if (cached?.user?.paid && Date.now() - checkedAt <= PAID_OFFLINE_GRACE_MS) {
        return { ...normalizedUser(cached.user), source: "offline-grace" };
      }
      if (error?.message?.includes("not configured")) throw error;
      return { ...normalizedUser(null), source: "unverified" };
    }
  }
  return { ...normalizedUser(cached?.user), source: cached ? "cache" : "local" };
}

export async function getMonetizationState({ refresh = false } = {}) {
  const [entitlement, usage, payment] = await Promise.all([
    getEntitlement({ refresh }),
    getUsage(),
    refresh ? getProviderStatus() : Promise.resolve({ configured: null, plans: [] }),
  ]);
  const remaining = entitlement.paid
    ? null
    : Math.max(0, PRICING.freePagesPerMonth - usage.pages);
  return {
    entitlement,
    usage,
    remaining,
    pricing: PRICING,
    payment,
  };
}

export async function openPaymentPage(mode = "checkout") {
  const key = await paymentKey(true);
  const path = mode === "login" ? "/reactivate" : "/choose-plan";
  const suffix = mode === "login" ? `?api_key=${encodeURIComponent(key)}&back=choose-plan&v2` : `?api_key=${encodeURIComponent(key)}`;
  await chrome.tabs.create({ url: `${extensionUrl(path)}${suffix}`, active: true });
}

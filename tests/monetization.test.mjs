import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { indexedDB } = require("fake-indexeddb");

globalThis.indexedDB = indexedDB;

const localValues = {};
let openedUrl = "";
let paidResponse = false;
let fetchFails = false;
let providerConfigured = false;
let plansRequests = 0;

globalThis.chrome = {
  runtime: { lastError: null },
  management: { getSelf: async () => ({ installType: "development" }) },
  storage: {
    local: {
      get(keys, callback) {
        const requested = Array.isArray(keys) ? keys : [keys];
        callback(Object.fromEntries(requested.filter((key) => key in localValues).map((key) => [key, localValues[key]])));
      },
      set(values, callback) {
        Object.assign(localValues, values);
        callback();
      },
    },
  },
  tabs: {
    async create({ url }) {
      openedUrl = url;
    },
  },
};

globalThis.fetch = async (url) => {
  if (fetchFails) throw new Error("offline");
  if (String(url).endsWith("/api/v2/current-plans")) {
    plansRequests += 1;
    return providerConfigured
      ? {
          ok: true,
          status: 200,
          // Yearly first on purpose: the dashboard returns plans in creation
          // order, and the popup is expected to sort them.
          json: async () => [
            { unitAmountCents: 999, currency: "cad", interval: "year" },
            { unitAmountCents: 199, currency: "cad", interval: "month" },
          ],
        }
      : { ok: false, status: 404, json: async () => ({ message: "Extension not found" }) };
  }
  if (String(url).endsWith("/api/new-key")) {
    return { ok: true, json: async () => "test-key" };
  }
  if (String(url).includes("/api/v2/user")) {
    return {
      ok: true,
      json: async () => ({
        paid: paidResponse,
        email: paidResponse ? "pro@example.test" : null,
        subscriptionStatus: paidResponse ? "active" : null,
      }),
    };
  }
  throw new Error(`Unexpected request: ${url}`);
};

const monetization = await import("../monetization.js");
assert.equal(monetization.PRICING.extensionPayId, "pagepack");

// Prices must not be reachable from here at all. They live in the ExtensionPay
// dashboard; a copy in the extension is a copy that goes stale above a checkout
// button. See pricing.js and tests/pricing.test.mjs.
for (const key of ["monthlyPrice", "yearlyPrice", "currency"]) {
  assert.equal(monetization.PRICING[key], undefined, `PRICING.${key} is hardcoded again`);
}

const initial = await monetization.getMonetizationState({ refresh: true });
assert.equal(initial.remaining, 25);
assert.equal(initial.entitlement.paid, false);
assert.equal(initial.payment.configured, false);
assert.deepEqual(initial.payment.plans, [], "an unconfigured provider has no plans to show");

await monetization.consumeFreePages(3);
const used = await monetization.getMonetizationState();
assert.equal(used.usage.pages, 3);
assert.equal(used.remaining, 22);

await monetization.openPaymentPage("checkout");
assert.match(openedUrl, /extension\/pagepack\/choose-plan\?api_key=test-key$/);

paidResponse = true;
providerConfigured = true;
const paid = await monetization.getMonetizationState({ refresh: true });
assert.equal(paid.entitlement.paid, true);
assert.equal(paid.entitlement.subscriptionStatus, "active");
assert.equal(paid.remaining, null);
// The plans reach the popup normalised, not as whatever the endpoint sent.
assert.deepEqual(paid.payment.plans, [
  { unitAmountCents: 199, currency: "cad", interval: "month", intervalCount: 1 },
  { unitAmountCents: 999, currency: "cad", interval: "year", intervalCount: 1 },
]);

// Cached for a day, so opening the popup does not ask the payment provider for
// its price list every time.
plansRequests = 0;
const cachedPlans = await monetization.getMonetizationState();
assert.equal(plansRequests, 0, "the plans were re-fetched instead of read from cache");
assert.equal(cachedPlans.payment.configured, true);
assert.equal(cachedPlans.payment.plans.length, 2);

// A stale cache plus a dead network still shows the last known prices rather
// than blanking the card.
localValues["pagepack-plans-cache-v1"].fetchedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
fetchFails = true;
const stalePlans = await monetization.getMonetizationState();
assert.equal(stalePlans.payment.plans.length, 2);
fetchFails = false;
await monetization.getMonetizationState({ refresh: true });

fetchFails = true;
localValues["pagepack-payment-cache-v2"].checkedAt = Date.now() - (8 * 24 * 60 * 60 * 1000);
const expiredGrace = await monetization.getMonetizationState({ refresh: true });
assert.equal(expiredGrace.entitlement.paid, false);

localValues["pagepack-payment-cache-v2"].checkedAt = Date.now();
const offlineGrace = await monetization.getMonetizationState({ refresh: true });
assert.equal(offlineGrace.entitlement.paid, true);
assert.equal(offlineGrace.entitlement.source, "offline-grace");
fetchFails = false;

await monetization.openPaymentPage("login");
assert.match(openedUrl, /reactivate\?api_key=test-key&back=choose-plan&v2$/);

console.log("Monetization tests passed");

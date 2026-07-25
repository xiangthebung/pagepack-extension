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
    return providerConfigured
      ? { ok: true, status: 200, json: async () => [{ unitAmountCents: 199, currency: "cad", interval: "month" }] }
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
assert.equal(monetization.PRICING.currency, "CAD");
assert.equal(monetization.PRICING.monthlyPrice, "CAD $1.99/month");
assert.equal(monetization.PRICING.yearlyPrice, "CAD $9.99/year");

const initial = await monetization.getMonetizationState({ refresh: true });
assert.equal(initial.remaining, 25);
assert.equal(initial.entitlement.paid, false);
assert.equal(initial.payment.configured, false);

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

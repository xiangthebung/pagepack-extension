import assert from "node:assert/strict";

const { describePlan, formatAmount, normalizePlans, priceLines, yearlySaving } = await import(
  "../pricing.js"
);

/* --- amounts --------------------------------------------------------------
   Stripe sends the smallest unit of the currency, and how many of those make one
   major unit is a property of the currency. Getting this wrong by a factor of a
   hundred is the whole reason this module exists as its own file. */

const cad199 = formatAmount(199, "cad");
assert.match(cad199, /1\.99/, `expected 199 cad to be 1.99, got ${cad199}`);
assert.match(cad199, /\$/, `expected a dollar sign in ${cad199}`);

const usd999 = formatAmount(999, "usd");
assert.match(usd999, /9\.99/, `expected 999 usd to be 9.99, got ${usd999}`);

// Yen has no subunit, so Stripe's figure is already the whole price. Dividing by
// a hundred would price a subscription at seven yen.
const jpy = formatAmount(700, "jpy");
assert.match(jpy, /700/, `expected 700 jpy to stay 700, got ${jpy}`);
assert.doesNotMatch(jpy, /\b7\b/, `700 jpy was divided as if it had cents: ${jpy}`);

// Nonsense currency codes must not throw inside a render.
assert.match(formatAmount(199, "not-a-currency"), /199|1\.99/);

/* --- periods -------------------------------------------------------------- */

assert.deepEqual(describePlan({ unitAmountCents: 199, currency: "cad", interval: "month" }).period, "/month");
assert.deepEqual(describePlan({ unitAmountCents: 999, currency: "cad", interval: "year" }).period, "/year");
assert.equal(
  describePlan({ unitAmountCents: 499, currency: "cad", interval: "month", intervalCount: 3 }).period,
  "/3 months",
);
assert.equal(
  describePlan({ unitAmountCents: 2999, currency: "cad", interval: "once" }).period,
  " one-off",
);

/* --- normalising what the endpoint sent ----------------------------------- */

// Sorted cheapest-commitment-first regardless of the order they arrive in.
assert.deepEqual(
  normalizePlans([
    { unitAmountCents: 999, currency: "cad", interval: "year" },
    { unitAmountCents: 199, currency: "cad", interval: "month" },
  ]).map((plan) => plan.interval),
  ["month", "year"],
);

// snake_case is accepted, because the only description of this endpoint's shape
// is a hand-written type declaration in a dependency.
assert.deepEqual(normalizePlans([{ unit_amount: 199, currency: "cad", interval: "month", interval_count: 2 }]), [
  { unitAmountCents: 199, currency: "cad", interval: "month", intervalCount: 2 },
]);

// Anything unshowable is dropped rather than rendered as CA$NaN.
assert.deepEqual(normalizePlans([{ currency: "cad", interval: "month" }]), []);
assert.deepEqual(normalizePlans([{ unitAmountCents: 199, interval: "month" }]), []);
assert.deepEqual(normalizePlans([{ unitAmountCents: 199, currency: "cad", interval: "fortnight" }]), []);
assert.deepEqual(normalizePlans(null), []);
assert.deepEqual(normalizePlans({ plans: [] }), []);

/* --- the yearly saving ----------------------------------------------------
   The card used to read "over half off" as a fixed phrase. True of $1.99 and
   $9.99, and silently false at any other pair. */

const pair = normalizePlans([
  { unitAmountCents: 199, currency: "cad", interval: "month" },
  { unitAmountCents: 999, currency: "cad", interval: "year" },
]);
assert.equal(yearlySaving(pair).percent, 58);

// No comparison to make.
assert.equal(yearlySaving(normalizePlans([{ unitAmountCents: 199, currency: "cad", interval: "month" }])), null);
// A yearly plan that is not cheaper must not be advertised as a saving.
assert.equal(
  yearlySaving(
    normalizePlans([
      { unitAmountCents: 199, currency: "cad", interval: "month" },
      { unitAmountCents: 2999, currency: "cad", interval: "year" },
    ]),
  ),
  null,
);
// Mixed currencies cannot be compared.
assert.equal(
  yearlySaving(
    normalizePlans([
      { unitAmountCents: 199, currency: "cad", interval: "month" },
      { unitAmountCents: 999, currency: "usd", interval: "year" },
    ]),
  ),
  null,
);

/* --- the rendered lines --------------------------------------------------- */

const lines = priceLines(pair);
assert.match(lines.main.amount, /1\.99/);
assert.equal(lines.main.period, "/month");
assert.match(lines.alt, /9\.99/);
assert.match(lines.alt, /58% less/);

// Unknown prices produce a sentence, never a number.
for (const value of [undefined, [], null]) {
  const unknown = priceLines(value);
  assert.equal(unknown.main, null);
  assert.match(unknown.alt, /shown at checkout/);
  assert.doesNotMatch(unknown.alt, /\d/, `a price leaked into the fallback: ${unknown.alt}`);
}

console.log("Pricing tests passed");

/**
 * Formatting the plans ExtensionPay reports.
 *
 * The popup used to have "CAD $1.99" written into its markup and "CAD $9.99/year"
 * written into a fallback string. A price stated in a file that nobody edits when
 * a dashboard changes is a price that will eventually be wrong, and the place it
 * will be wrong is directly above the button that takes money.
 *
 * So the numbers now come from `/api/v2/current-plans`, which is the same source
 * the checkout page prices from, and this module is the pure half of that: no
 * chrome APIs, no network, so it can be tested on its own.
 */

/**
 * How many minor units make one major unit of a currency.
 *
 * Stripe sends amounts in the smallest unit, and how many of those there are per
 * major unit is a property of the currency: 100 cents to a dollar, but a yen has
 * no subunit at all, so its "cents" figure is already the whole price. Rather
 * than carry Stripe's list of zero-decimal currencies, the answer is read out of
 * `Intl` for the currency in hand — the same source that formats the number a
 * line later, so the two cannot disagree.
 */
function minorUnitsPer(currency) {
  try {
    const digits = new Intl.NumberFormat(undefined, { style: "currency", currency })
      .resolvedOptions().maximumFractionDigits;
    return 10 ** (typeof digits === "number" ? digits : 2);
  } catch {
    return 100;
  }
}

export function formatAmount(unitAmountCents, currency) {
  const value = unitAmountCents / minorUnitsPer(currency);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    // A bare number with its code beats an exception thrown mid-render.
    return `${value} ${String(currency).toUpperCase()}`;
  }
}

const PERIOD_NAME = { month: "month", year: "year", once: "one-off" };

/** `{ amount, period }`, ready to drop into the price line. */
export function describePlan(plan) {
  const count = Number(plan.intervalCount) || 1;
  const name = PERIOD_NAME[plan.interval] || plan.interval;
  let period;
  if (plan.interval === "once") period = " one-off";
  else if (count > 1) period = `/${count} ${name}s`;
  else period = `/${name}`;
  return { amount: formatAmount(plan.unitAmountCents, plan.currency), period };
}

const INTERVAL_ORDER = ["month", "year", "once"];

/**
 * Normalises whatever the plans endpoint returned into the shape used here, and
 * drops anything that cannot be shown honestly.
 *
 * Two defences worth their cost. Amounts are checked for being real numbers,
 * because a missing one would render as `CA$NaN` beside a checkout button. And
 * both `unitAmountCents` and `unit_amount` are accepted: the only description of
 * this endpoint's shape is a hand-written type declaration in the `extpay`
 * package, and guessing wrong there would silently blank the price.
 */
export function normalizePlans(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((plan) => ({
      unitAmountCents: Number(plan?.unitAmountCents ?? plan?.unit_amount ?? NaN),
      currency: String(plan?.currency ?? ""),
      interval: plan?.interval ?? null,
      intervalCount: Number(plan?.intervalCount ?? plan?.interval_count ?? 1) || 1,
    }))
    .filter(
      (plan) =>
        Number.isFinite(plan.unitAmountCents) &&
        plan.unitAmountCents >= 0 &&
        plan.currency.length > 0 &&
        INTERVAL_ORDER.includes(plan.interval),
    )
    .sort((a, b) => {
      const byInterval =
        INTERVAL_ORDER.indexOf(a.interval) - INTERVAL_ORDER.indexOf(b.interval);
      return byInterval !== 0 ? byInterval : a.unitAmountCents - b.unitAmountCents;
    });
}

/**
 * How much less a year costs than twelve months of the monthly plan.
 *
 * The card used to say "over half off" as a fixed phrase, which was true of
 * $1.99 and $9.99 and would quietly stop being true at any other pair of prices.
 * Returns `null` when there is no honest comparison to make — one plan, mismatched
 * currencies, or a yearly plan that is not actually cheaper.
 */
export function yearlySaving(plans) {
  const monthly = plans.find((plan) => plan.interval === "month");
  const yearly = plans.find((plan) => plan.interval === "year");
  if (!monthly || !yearly) return null;
  if (monthly.currency !== yearly.currency) return null;

  const twelveMonths = monthly.unitAmountCents * 12;
  if (twelveMonths <= 0 || yearly.unitAmountCents >= twelveMonths) return null;

  const percent = Math.round(((twelveMonths - yearly.unitAmountCents) / twelveMonths) * 100);
  return percent >= 5 ? { percent } : null;
}

/**
 * The two lines of the price block, or nulls when the plans are not known.
 *
 * `undefined` plans mean "not asked yet" and `[]` means "asked, nothing to show".
 * Both produce a sentence pointing at checkout rather than a number this build was
 * compiled with, because the one thing this must never do is state a price it
 * cannot confirm.
 */
export function priceLines(plans) {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { main: null, alt: "The price and billing period are shown at checkout." };
  }

  const [first, ...rest] = plans;
  const lead = describePlan(first);
  const main = { amount: lead.amount, period: lead.period };

  const second = rest[0];
  if (!second) return { main, alt: null };

  const other = describePlan(second);
  const saving = yearlySaving(plans);
  const alt = saving
    ? `or ${other.amount}${other.period} — ${saving.percent}% less`
    : `or ${other.amount}${other.period}`;
  return { main, alt };
}

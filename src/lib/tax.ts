/**
 * Sales tax, split by what's being sold.
 *
 * Oklahoma exempted "food and food ingredients" from the STATE portion (4.5%)
 * on 29 August 2024. Local taxes were not exempted, so groceries are still
 * taxed — just at a lower rate than a candle or a cutting board. One flat rate
 * across a ticket over-collects on the food half of it, and over-collected tax
 * is not a windfall: it's either remitted or refunded.
 *
 * Every price in this codebase is an integer number of cents and every rate is
 * a percent as a number (9.0 meaning 9%). Nothing here sees a float dollar.
 *
 * WHY THIS FILE EXISTS: the same `Math.round(subtotal * rate / 100)` was
 * written out in nine different places — the register, self-checkout, the
 * vendor ring-up, pre-orders, and four screens that display a total before the
 * server confirms it. Splitting a rate in nine places is how a receipt ends up
 * disagreeing with the ledger.
 */

export type TaxClass = "STANDARD" | "FOOD";

/** Anything not explicitly marked food is taxed at the full rate. */
export function normalizeTaxClass(raw: unknown): TaxClass {
  return String(raw || "").toUpperCase() === "FOOD" ? "FOOD" : "STANDARD";
}

export type TaxRates = {
  /** Full combined state + local rate. */
  standardPercent: number;
  /** Local-only rate for food and food ingredients. */
  foodPercent: number;
};

export type TaxableLine = {
  /** Line total in cents — price times quantity, after any discount. */
  amountCents: number;
  taxClass: TaxClass;
};

export type TaxBreakdown = {
  taxCents: number;
  /** Pre-tax cents in each bucket, after any surcharge has been spread. */
  standardBaseCents: number;
  foodBaseCents: number;
  standardTaxCents: number;
  foodTaxCents: number;
};

const pct = (baseCents: number, percent: number): number => {
  if (!Number.isFinite(percent) || percent <= 0 || baseCents <= 0) return 0;
  return Math.round((baseCents * percent) / 100);
};

/**
 * Tax for a ticket.
 *
 * Rounds ONCE PER BUCKET rather than per line. Rounding every line separately
 * drifts by up to half a cent a line, which on a thirty-item ticket is a real
 * discrepancy between the receipt and the books, always in the same direction.
 *
 * @param surchargeCents a card-processing adjustment or similar, which is
 *   itself taxable. Spread across the buckets in proportion to their share of
 *   the subtotal, because charging it entirely to one bucket would tax it at
 *   the wrong rate.
 */
export function taxFor(lines: TaxableLine[], rates: TaxRates, surchargeCents = 0): TaxBreakdown {
  let standardBase = 0;
  let foodBase = 0;
  for (const l of lines) {
    const amount = Math.round(l.amountCents);
    if (l.taxClass === "FOOD") foodBase += amount;
    else standardBase += amount;
  }

  const subtotal = standardBase + foodBase;
  const surcharge = Math.max(0, Math.round(surchargeCents));
  if (surcharge > 0 && subtotal > 0) {
    // Give the food bucket its exact proportional share and the remainder to
    // standard, so the two always add back to the surcharge with no cent lost.
    const foodShare = Math.round((surcharge * foodBase) / subtotal);
    foodBase += foodShare;
    standardBase += surcharge - foodShare;
  } else if (surcharge > 0) {
    standardBase += surcharge;
  }

  const standardTaxCents = pct(standardBase, rates.standardPercent);
  const foodTaxCents = pct(foodBase, rates.foodPercent);

  return {
    taxCents: standardTaxCents + foodTaxCents,
    standardBaseCents: standardBase,
    foodBaseCents: foodBase,
    standardTaxCents,
    foodTaxCents,
  };
}

/**
 * The rate to show against a single ticket.
 *
 * A ticket with both a candle and a bag of flour has no single rate, so this
 * returns null and the UI says "Tax" with the amount instead of inventing a
 * percentage. Quoting one rate for a mixed ticket is how a customer decides
 * you've overcharged them.
 */
export function displayRate(lines: TaxableLine[], rates: TaxRates): number | null {
  let hasStandard = false;
  let hasFood = false;
  for (const l of lines) {
    if (l.amountCents <= 0) continue;
    if (l.taxClass === "FOOD") hasFood = true;
    else hasStandard = true;
  }
  if (hasStandard && hasFood) return null;
  if (hasFood) return rates.foodPercent;
  if (hasStandard) return rates.standardPercent;
  return rates.standardPercent;
}

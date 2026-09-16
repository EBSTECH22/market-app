/**
 * Did that discount actually work?
 *
 * A vendor drops a price on instinct, sells some things, and never finds out
 * whether the extra units made up for the smaller margin. This compares the run
 * before a price change with the run after it, on the same item.
 *
 * HONEST ABOUT WHAT THIS IS: a before-and-after on one item, not a controlled
 * experiment. Christmas, a sunny Saturday and a good photo all move the same
 * numbers. So the output is deliberately hedged — it reports what happened and
 * how confident it is, and refuses to report at all below a floor of units and
 * days, because a verdict off three sales is worse than silence.
 */

const DAY_MS = 86_400_000;

/** Fewer than this either side and the comparison isn't worth showing. */
export const MIN_UNITS_PER_SIDE = 5;
/** Shorter than this either side and a single good day dominates. */
export const MIN_DAYS_PER_SIDE = 7;
/** Beyond this, "before" is a different season, not a baseline. */
export const MAX_WINDOW_DAYS = 60;

export type Sale = { at: Date; units: number; revenueCents: number };

export type PriceChange = {
  itemId: string;
  at: Date;
  oldPriceCents: number;
  newPriceCents: number;
  oldSalePercent: number;
  newSalePercent: number;
};

export type Side = { days: number; units: number; revenueCents: number; unitsPerWeek: number; revenuePerWeekCents: number };

export type PriceTest = {
  itemId: string;
  at: Date;
  oldEffectiveCents: number;
  newEffectiveCents: number;
  discountPercent: number;
  before: Side;
  after: Side;
  unitsChangePercent: number;
  revenueChangePercent: number;
  /** Enough data to say anything at all. */
  confident: boolean;
  verdict: "WORKED" | "LOST_MONEY" | "NO_DIFFERENCE" | "TOO_EARLY";
};

/** What a shopper actually pays, after the sale percent. */
export function effectiveCents(priceCents: number, salePercent: number): number {
  const pct = Math.max(0, Math.min(90, Math.round(salePercent || 0)));
  return Math.round(priceCents * (1 - pct / 100));
}

function side(sales: Sale[], from: Date, to: Date): Side {
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  let units = 0;
  let revenueCents = 0;
  for (const s of sales) {
    if (s.at >= from && s.at < to) { units += s.units; revenueCents += s.revenueCents; }
  }
  const weeks = Math.max(1, days / 7);
  return {
    days,
    units,
    revenueCents,
    unitsPerWeek: Math.round((units / weeks) * 100) / 100,
    revenuePerWeekCents: Math.round(revenueCents / weeks),
  };
}

const changePercent = (before: number, after: number): number => {
  if (before <= 0) return after > 0 ? 100 : 0;
  return Math.round(((after - before) / before) * 100);
};

/**
 * Compare the window before a change with the window after it.
 *
 * Windows are matched in length — however long the "after" has run, the same
 * span of "before" is used, capped. Comparing three days of sale against two
 * months of normal price would flatter the discount every time.
 *
 * @param now injected so the thresholds are testable.
 */
export function testPriceChange(change: PriceChange, sales: Sale[], now: Date = new Date()): PriceTest {
  const sinceDays = Math.max(0, Math.round((now.getTime() - change.at.getTime()) / DAY_MS));
  const window = Math.min(MAX_WINDOW_DAYS, Math.max(1, sinceDays));

  const after = side(sales, change.at, new Date(change.at.getTime() + window * DAY_MS));
  const before = side(sales, new Date(change.at.getTime() - window * DAY_MS), change.at);

  const oldEffectiveCents = effectiveCents(change.oldPriceCents, change.oldSalePercent);
  const newEffectiveCents = effectiveCents(change.newPriceCents, change.newSalePercent);
  const discountPercent = oldEffectiveCents > 0
    ? Math.round(((oldEffectiveCents - newEffectiveCents) / oldEffectiveCents) * 100)
    : 0;

  const unitsChangePercent = changePercent(before.unitsPerWeek, after.unitsPerWeek);
  const revenueChangePercent = changePercent(before.revenuePerWeekCents, after.revenuePerWeekCents);

  const confident =
    sinceDays >= MIN_DAYS_PER_SIDE &&
    before.days >= MIN_DAYS_PER_SIDE &&
    before.units >= MIN_UNITS_PER_SIDE &&
    after.units >= MIN_UNITS_PER_SIDE;

  /* Revenue decides it, not units. Selling twice as many at half price is a
     lot more work for the same money, and a vendor told "it worked!" on unit
     count alone would be actively misled. The ±10% dead band keeps noise from
     being reported as a result. */
  let verdict: PriceTest["verdict"];
  if (!confident) verdict = "TOO_EARLY";
  else if (revenueChangePercent >= 10) verdict = "WORKED";
  else if (revenueChangePercent <= -10) verdict = "LOST_MONEY";
  else verdict = "NO_DIFFERENCE";

  return {
    itemId: change.itemId,
    at: change.at,
    oldEffectiveCents,
    newEffectiveCents,
    discountPercent,
    before,
    after,
    unitsChangePercent,
    revenueChangePercent,
    confident,
    verdict,
  };
}

/** A sentence a person can read, rather than four percentages. */
export function verdictLine(t: PriceTest, itemName: string): string {
  const dir = t.discountPercent > 0 ? `${t.discountPercent}% cheaper` : t.discountPercent < 0 ? `${-t.discountPercent}% dearer` : "repriced";
  switch (t.verdict) {
    case "TOO_EARLY":
      return `${itemName} is ${dir} — too early to tell. Give it a week or two of sales.`;
    case "WORKED":
      return `${itemName} at ${dir}: ${t.unitsChangePercent > 0 ? `${t.unitsChangePercent}% more units` : "about the same units"}, and ${t.revenueChangePercent}% more money a week. It worked.`;
    case "LOST_MONEY":
      return t.unitsChangePercent > 10
        ? `${itemName} at ${dir}: ${t.unitsChangePercent}% more units but ${-t.revenueChangePercent}% LESS money a week — you're selling more for less. Worth putting the price back.`
        : `${itemName} at ${dir}: ${-t.revenueChangePercent}% less money a week. It didn't pay off.`;
    case "NO_DIFFERENCE":
      return `${itemName} at ${dir}: takings barely moved. The discount isn't buying you anything — you could put the price back.`;
  }
}

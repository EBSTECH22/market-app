/**
 * Turning a vendor's sales history into something they can act on.
 *
 * Their portal already tells them what happened. None of it tells them what to
 * do about it. These are the numbers that answer "which of my things is worth
 * making more of, and which is sitting on my best shelf doing nothing" — which
 * a vendor who isn't in the building cannot see for themselves.
 *
 * Pure functions on plain numbers: no database, no React, so the thresholds can
 * be tested directly rather than inferred from a screenshot.
 */

const DAY_MS = 86_400_000;

/** Below this, an item hasn't had a fair run yet and is never called dead. */
export const GRACE_DAYS = 14;
/** On the floor this long with nothing sold is a real problem. */
export const DEAD_DAYS = 60;
/** Had sales once, but nothing recently. */
export const STALE_DAYS = 30;

export type ItemInput = {
  itemId: string;
  sku: string;
  name: string;
  priceCents: number;
  /** On the floor right now. */
  quantity: number;
  /** When it was first added. */
  createdAt: Date;
  unitsSold: number;
  revenueCents: number;
  lastSoldAt: Date | null;
};

export type ItemStatus =
  /** Too new to judge. */
  | "NEW"
  /** Selling well for this vendor. */
  | "STRONG"
  /** Ticking along. */
  | "STEADY"
  /** Sold before, nothing lately. */
  | "SLOW"
  /** On the floor a long time, never sold once. */
  | "DEAD"
  /** Sold out — the opposite problem. */
  | "OUT";

export type ItemStat = ItemInput & {
  daysOnFloor: number;
  daysSinceLastSale: number | null;
  /** Of everything they've put out, the share that has sold. */
  sellThroughPercent: number;
  unitsPerWeek: number;
  /** Days until the shelf is empty at the current rate. Null when unknowable. */
  runsOutInDays: number | null;
  status: ItemStatus;
};

const whole = (n: number) => Math.max(0, Math.floor(n));

/**
 * One item's numbers.
 *
 * @param now injected rather than read, so the thresholds are testable at all.
 */
export function statFor(item: ItemInput, now: Date = new Date()): ItemStat {
  const daysOnFloor = whole((now.getTime() - item.createdAt.getTime()) / DAY_MS);
  const daysSinceLastSale = item.lastSoldAt
    ? whole((now.getTime() - item.lastSoldAt.getTime()) / DAY_MS)
    : null;

  /* Rate over the item's whole life on the floor. The floor of one week stops a
     brand-new item that sold twice on its first day from reporting "14 a week"
     and predicting it runs out this afternoon. */
  const weeks = Math.max(1, daysOnFloor / 7);
  const unitsPerWeek = item.unitsSold / weeks;

  const everStocked = item.unitsSold + item.quantity;
  const sellThroughPercent = everStocked > 0 ? Math.round((item.unitsSold / everStocked) * 100) : 0;

  const runsOutInDays =
    item.quantity > 0 && unitsPerWeek > 0 ? Math.round((item.quantity / unitsPerWeek) * 7) : null;

  let status: ItemStatus;
  if (item.quantity <= 0) {
    status = "OUT";
  } else if (daysOnFloor < GRACE_DAYS && item.unitsSold === 0) {
    // Not dead — just hasn't had a chance yet.
    status = "NEW";
  } else if (item.unitsSold === 0) {
    status = daysOnFloor >= DEAD_DAYS ? "DEAD" : "SLOW";
  } else if (daysSinceLastSale !== null && daysSinceLastSale >= STALE_DAYS) {
    status = "SLOW";
  } else {
    status = unitsPerWeek >= 1 ? "STRONG" : "STEADY";
  }

  return {
    ...item,
    daysOnFloor,
    daysSinceLastSale,
    sellThroughPercent,
    unitsPerWeek: Math.round(unitsPerWeek * 100) / 100,
    runsOutInDays,
    status,
  };
}

export type StatsSummary = {
  itemCount: number;
  unitsSold: number;
  revenueCents: number;
  /** Items that have never sold and are past the grace period. */
  deadCount: number;
  deadValueCents: number;
  /** Items that will be empty within the window. */
  runningOutCount: number;
  outOfStockCount: number;
};

/** Items about to be empty, soonest first. */
export const RUNNING_OUT_DAYS = 14;

export function summarize(stats: ItemStat[]): StatsSummary {
  return {
    itemCount: stats.length,
    unitsSold: stats.reduce((n, s) => n + s.unitsSold, 0),
    revenueCents: stats.reduce((n, s) => n + s.revenueCents, 0),
    deadCount: stats.filter((s) => s.status === "DEAD").length,
    /* What the dead stock is worth at its own ticket price — the number that
       makes "this shelf is costing you money" concrete. */
    deadValueCents: stats
      .filter((s) => s.status === "DEAD")
      .reduce((n, s) => n + s.priceCents * s.quantity, 0),
    runningOutCount: stats.filter((s) => s.runsOutInDays !== null && s.runsOutInDays <= RUNNING_OUT_DAYS).length,
    outOfStockCount: stats.filter((s) => s.status === "OUT").length,
  };
}

/** Soonest-empty first; items with no rate never appear. */
export function runningOut(stats: ItemStat[], withinDays = RUNNING_OUT_DAYS): ItemStat[] {
  return stats
    .filter((s) => s.runsOutInDays !== null && s.runsOutInDays <= withinDays && s.quantity > 0)
    .sort((a, b) => (a.runsOutInDays ?? 0) - (b.runsOutInDays ?? 0));
}

/** Longest-sitting first — the things to pull or re-price. */
export function deadStock(stats: ItemStat[]): ItemStat[] {
  return stats.filter((s) => s.status === "DEAD").sort((a, b) => b.daysOnFloor - a.daysOnFloor);
}

/** Best earners first. Revenue, not units — twenty $2 items aren't a hit. */
export function bestSellers(stats: ItemStat[], take = 5): ItemStat[] {
  return [...stats].sort((a, b) => b.revenueCents - a.revenueCents).slice(0, take);
}

/* ------------------------------------------------------- when things sell -- */

export type DayHourPoint = { weekday: number; hour: number; units: number; revenueCents: number };

export type BusiestWindow = {
  weekday: number;
  /** Inclusive start hour, 24h. */
  hour: number;
  units: number;
  revenueCents: number;
  /** Share of all their units sold in this one hour. */
  sharePercent: number;
};

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The single best hour to have a full shelf.
 *
 * Returns null below a floor of total units, because "your best hour is
 * Tuesday 2pm" off the back of three sales is a coincidence dressed up as
 * advice, and acting on it costs them a trip.
 */
export function busiestWindow(points: DayHourPoint[], minUnits = 20): BusiestWindow | null {
  const total = points.reduce((n, p) => n + p.units, 0);
  if (total < minUnits) return null;
  const best = points.reduce((a, b) => (b.units > a.units ? b : a));
  if (best.units <= 0) return null;
  return {
    weekday: best.weekday,
    hour: best.hour,
    units: best.units,
    revenueCents: best.revenueCents,
    sharePercent: Math.round((best.units / total) * 100),
  };
}

/** "Saturday 10am–11am" */
export function windowLabel(w: BusiestWindow): string {
  const h = (n: number) => {
    const suffix = n < 12 ? "am" : "pm";
    const twelve = n % 12 === 0 ? 12 : n % 12;
    return `${twelve}${suffix}`;
  };
  return `${WEEKDAY_NAMES[w.weekday]} ${h(w.hour)}–${h((w.hour + 1) % 24)}`;
}

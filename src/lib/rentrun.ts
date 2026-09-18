import { TZ } from "@/lib/time";

/**
 * What the monthly rent run WILL do — decided in one place, used twice.
 *
 * The cron used to hold this arithmetic inline, which meant the only way to
 * find out what the 1st would charge was to wait for the 1st. Any preview built
 * separately would be a second implementation of the same rules, and a preview
 * that drifts from the thing it previews is worse than no preview: it is a
 * number somebody plans around that turns out to be wrong.
 *
 * So the cron and the "what's coming" card both call `planRentRun`. The cron
 * writes what it returns; the card draws it. They cannot disagree.
 *
 * Nothing here touches the database. Callers hand in the contracts and which
 * ones have already been charged this month, and get back a decision per
 * contract with the reasoning attached.
 */

export type RentContract = {
  id: string;
  vendorId: string;
  boothLabel: string;
  monthlyRentCents: number;
  status: string;
  endDate: Date | null;
  paidThrough: Date | null;
};

export type RentPlanRow = {
  contractId: string;
  vendorId: string;
  boothLabel: string;
  /** What will actually be posted, in cents. 0 when nothing is charged. */
  amountCents: number;
  /** The full monthly rate, for showing what a prorated charge is a slice of. */
  monthlyRentCents: number;
  note: string;
  action: "CHARGE" | "PRORATE" | "FINAL_MONTH" | "SKIP_PREPAID" | "SKIP_DONE" | "END";
  /** One line a human can read, for the preview table. */
  reason: string;
  /** Set when the contract's paidThrough should be cleared as part of posting. */
  clearPaidThrough: boolean;
};

/** "2026-11" for a date, in market time. */
export function monthKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(d);
}

/** Noon on the 1st of the given month key — noon so a timezone shift can't move the day. */
export function monthStartFor(ym: string): Date {
  return new Date(`${ym}-01T12:00:00`);
}

/**
 * Calendar date in MARKET time, not the server's.
 *
 * This matters more than it looks. Dates are stored as instants, and a date
 * entered as "Oct 1" is midnight Central — five hours into Oct 1 UTC. Reading
 * `.getDate()` or `.getMonth()` off it gives whatever calendar the server
 * happens to be on, which on Vercel is UTC. Get it slightly wrong and a
 * prepaid-through date of "Nov 1" reads as October, the run treats it as
 * running out mid-month, and it bills a full extra month of rent to somebody
 * who has already paid.
 *
 * So every comparison below goes through these: the market's calendar, every
 * time, with no arithmetic on raw instants.
 */
export function ymdInTZ(d: Date): { y: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  return { y: get("year"), m: get("month"), day: get("day") };
}

/** Whole days since the epoch, by the market's calendar date. Safe to subtract. */
export function dayIndex(d: Date): number {
  const { y, m, day } = ymdInTZ(d);
  return Math.floor(Date.UTC(y, m - 1, day) / 86400000);
}

/**
 * The same calendar day in market time, `days` later, stored at noon UTC.
 *
 * Noon UTC is the safe way to hold a DATE as an instant here: Central is UTC-5
 * or UTC-6, so noon UTC is always six or seven in the morning Central — the
 * same calendar day, whatever daylight saving is doing.
 *
 * Adding `days * 24h` to a timestamp is NOT the same thing and is wrong twice a
 * year. Fourteen days added to midnight on 1 November lands at eleven at night
 * on the 14th, because the clocks went back an hour in between — so a date that
 * should read as the 15th reads as the 14th, and a vendor is billed a day more
 * than they should be.
 */
export function addDaysInTZ(d: Date, days: number): Date {
  const { y, m, day } = ymdInTZ(d);
  return new Date(Date.UTC(y, m - 1, day + days, 12, 0, 0));
}

/** Days in a given month, 1-indexed month. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const shortDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });

/**
 * The per-contract marker written into the ledger note.
 *
 * Contract-scoped, not vendor-scoped. The old marker was just `[auto 2026-11]`
 * and the "already charged?" check looked it up BY VENDOR — so a vendor renting
 * two booths had the second booth's rent skipped every month, because the first
 * booth's entry already carried the month's tag. They were billed for one booth
 * and using two.
 */
export function rentMarker(ym: string, contractId: string): string {
  return `[auto ${ym} ${contractId.slice(0, 8)}]`;
}

/** The old vendor-wide marker, still recognised so a deploy can't re-charge a month already run. */
export function legacyRentMarker(ym: string): string {
  return `[auto ${ym}]`;
}

/**
 * Decide what happens to one contract for one month.
 *
 * `alreadyCharged` is the caller's answer to "has this contract's rent for this
 * month already posted" — the DB lookup stays with the caller so this stays
 * pure and testable.
 */
export function planContract(
  c: RentContract,
  ym: string,
  now: Date,
  alreadyCharged: boolean
): RentPlanRow {
  const base = {
    contractId: c.id,
    vendorId: c.vendorId,
    boothLabel: c.boothLabel,
    monthlyRentCents: c.monthlyRentCents,
    clearPaidThrough: false,
  };

  /* Ended before this month began — close it out, charge nothing.
     Month keys are "YYYY-MM", so a string compare is a date compare. */
  if (c.endDate && monthKey(c.endDate) < ym) {
    return { ...base, amountCents: 0, note: "", action: "END", reason: "Agreement already ended — nothing to charge." };
  }

  if (alreadyCharged) {
    return { ...base, amountCents: 0, note: "", action: "SKIP_DONE", reason: "Already charged for this month." };
  }

  let amount = c.monthlyRentCents;
  let note = `Monthly booth rent, booth ${c.boothLabel} ${rentMarker(ym, c.id)}`;
  let action: RentPlanRow["action"] = "CHARGE";
  let reason = "Full month.";
  let clearPaidThrough = false;

  if (c.paidThrough) {
    const ptYm = monthKey(c.paidThrough);

    if (ptYm === ym) {
      /* Their prepaid first month runs out partway through THIS month, so they
         owe the remainder of it and the calendar realigns from here on.
         (A paidThrough inside this month is necessarily on or after the 1st,
         so there is no separate "is it past the month start" test to get
         wrong.) */
      const pt = ymdInTZ(c.paidThrough);
      const dim = daysInMonth(pt.y, pt.m);
      const fromDay = pt.day;
      amount = Math.round((c.monthlyRentCents * (dim - fromDay + 1)) / dim);
      note = `Second month rent, prorated from ${shortDay(c.paidThrough)} ${rentMarker(ym, c.id)}`;
      action = "PRORATE";
      reason = `Prepaid through ${shortDay(c.paidThrough)} — charged ${dim - fromDay + 1} of ${dim} days.`;
      clearPaidThrough = true;
    } else if (dayIndex(c.paidThrough) > dayIndex(now)) {
      /* Still inside the month they already paid for. */
      return {
        ...base,
        amountCents: 0,
        note: "",
        action: "SKIP_PREPAID",
        reason: `Already paid through ${shortDay(c.paidThrough)}.`,
      };
    } else {
      /* Prepaid period is behind us — normal months from now on. */
      clearPaidThrough = true;
    }
  }

  if (c.status === "TERMINATING" && c.endDate && monthKey(c.endDate) === ym) {
    const ed = ymdInTZ(c.endDate);
    const dim = daysInMonth(ed.y, ed.m);
    amount = Math.round((c.monthlyRentCents * ed.day) / dim);
    note = `Final month rent, prorated to ${shortDay(c.endDate)} ${rentMarker(ym, c.id)}`;
    action = "FINAL_MONTH";
    reason = `Leaving ${shortDay(c.endDate)} — charged ${ed.day} of ${dim} days.`;
  }

  return { ...base, amountCents: Math.max(0, amount), note, action, reason, clearPaidThrough };
}

/** Everything the run will post, and what it adds up to. */
export function planRentRun(
  contracts: RentContract[],
  ym: string,
  now: Date,
  isCharged: (c: RentContract) => boolean
): { rows: RentPlanRow[]; totalCents: number; chargeCount: number } {
  const rows = contracts.map((c) => planContract(c, ym, now, isCharged(c)));
  const billing = rows.filter((r) => r.amountCents > 0);
  return {
    rows,
    totalCents: billing.reduce((n, r) => n + r.amountCents, 0),
    chargeCount: billing.length,
  };
}

/**
 * The 1st of the next month, in market time — when the run next fires.
 *
 * On the 1st itself, before the run has gone, "next" is today.
 */
export function nextRentRunDate(now = new Date(), alreadyRanThisMonth = false): Date {
  const ym = monthKey(now);
  const thisMonth = monthStartFor(ym);
  const dayOfMonth = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, day: "numeric" }).format(now)
  );
  if (dayOfMonth === 1 && !alreadyRanThisMonth) return thisMonth;

  const [y, m] = ym.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return monthStartFor(`${nextY}-${String(nextM).padStart(2, "0")}`);
}

/** "2026-11" plus n months. */
export function addMonthsToYm(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/**
 * When this contract is next actually charged, and how much.
 *
 * Not the same question as "what does the next run do to it". A vendor who
 * prepaid their first month is skipped by the next run and by the one after,
 * and the honest answer to "when do they next get billed" is a date some months
 * out — which is exactly what somebody looking at the table wants to know, and
 * what they would otherwise have to work out from a prepaid-through date.
 *
 * Answered by running the planner forward a month at a time rather than by
 * reasoning about it, so it cannot disagree with what the run will do. Thirteen
 * months is far enough: anything that hasn't billed within a year isn't a
 * schedule, it's a contract that has ended.
 */
export function nextChargeFor(
  c: RentContract,
  fromYm: string,
  now: Date,
  chargedThisMonth: boolean,
  maxMonths = 13
): { ym: string; date: string; amountCents: number; reason: string } | null {
  for (let i = 0; i < maxMonths; i++) {
    const ym = addMonthsToYm(fromYm, i);
    const at = monthStartFor(ym);
    /* Only the first month can already be done; later months haven't happened. */
    const row = planContract(c, ym, i === 0 ? now : at, i === 0 ? chargedThisMonth : false);
    if (row.action === "END") return null;
    if (row.amountCents > 0) {
      return { ym, date: at.toISOString(), amountCents: row.amountCents, reason: row.reason };
    }
  }
  return null;
}

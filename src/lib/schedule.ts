import { db } from "@/lib/db";
import { TZ } from "@/lib/time";
import { dayIndex, addDaysInTZ } from "@/lib/rentrun";

/**
 * The market's money calendar: when it opens, and which day vendors get paid.
 *
 * Both are settings rather than constants because both are decisions, not
 * facts about the software, and both are things somebody will want to change
 * without a deploy.
 */

/* ---------------------------------------------------------------- opening -- */

/**
 * The day the market first opens its doors.
 *
 * It matters to billing for one reason: a vendor whose lease started before it
 * paid a full month's rent for a month that included days with no market to
 * sell at. Those days are owed back to them.
 */
export async function getMarketOpensAt(): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: "marketOpensAt" } });
  if (!row?.value) return null;
  const d = new Date(row.value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function setMarketOpensAt(iso: string): Promise<void> {
  await db.setting.upsert({
    where: { key: "marketOpensAt" },
    create: { key: "marketOpensAt", value: iso },
    update: { value: iso },
  });
}

/** Has the closed-day credit already been handed out? Set once, so it can't run twice. */
export async function closedDayCreditAppliedAt(): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: "closedDayCreditAt" } });
  if (!row?.value) return null;
  const d = new Date(row.value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function markClosedDayCreditApplied(): Promise<void> {
  await db.setting.upsert({
    where: { key: "closedDayCreditAt" },
    create: { key: "closedDayCreditAt", value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
}

/**
 * How many days of a vendor's prepaid first month fell before the market opened.
 *
 * The first month is billed in full on the day an agreement is executed, and
 * `paidThrough` records the day that prepaid month runs out. If the market
 * wasn't open for part of it, the vendor paid for a shop that wasn't there.
 *
 * Counted rather than estimated: it is the overlap between [startDate, opensAt)
 * and the period they actually paid for. A lease starting on or after opening
 * day gets nothing, which is correct — they lost no days.
 */
export function closedDaysOwed(
  startDate: Date,
  paidThrough: Date | null,
  opensAt: Date | null
): number {
  if (!opensAt) return 0;

  /* Counted in whole calendar days in MARKET time. Subtracting raw timestamps
     gets this wrong by a day whenever the two dates were stored with different
     times on them — which they are: a lease start is midnight Central and the
     opening date is stored at noon. That is the difference between crediting
     14 days and 15. */
  const start = dayIndex(startDate);
  const opens = dayIndex(opensAt);
  if (start >= opens) return 0;

  /* Never credit past the end of what they actually paid for. Without this, a
     lease starting three months before opening would be handed a credit bigger
     than the rent it is meant to come off. */
  const paidEnd = paidThrough ? dayIndex(paidThrough) : opens;
  const closedUntil = Math.min(opens, paidEnd);
  if (closedUntil <= start) return 0;

  return closedUntil - start;
}

/**
 * Where `paidThrough` moves to once those days are credited.
 *
 * Pushing paidThrough forward is the whole mechanism: the monthly run already
 * knows how to charge only the remainder of a month when a contract is prepaid
 * partway into it, so moving the date by N days makes the next run bill N days
 * fewer. No new billing path, no credit note to reconcile — the same prorate
 * branch that has always run, given a later date.
 */
export function creditedPaidThrough(paidThrough: Date | null, days: number): Date | null {
  if (!paidThrough || days <= 0) return paidThrough;
  /* Calendar days, not milliseconds — see addDaysInTZ. Adding raw hours across
     the November clock change moved the date back a day and billed everybody
     one day too much. */
  return addDaysInTZ(paidThrough, days);
}

/* ----------------------------------------------------------------- payout -- */

/** Day of the month vendors get paid. 0 means no fixed day. */
export async function getPayoutDay(): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: "payoutDay" } });
  const v = row ? Number(row.value) : NaN;
  /* Capped at 28 so the day exists in February and nobody has to explain why
     the 30th didn't happen. */
  return Number.isFinite(v) && v >= 0 && v <= 28 ? Math.round(v) : 0;
}

export async function setPayoutDay(v: number): Promise<void> {
  const n = Math.max(0, Math.min(28, Math.round(Number(v) || 0)));
  await db.setting.upsert({
    where: { key: "payoutDay", },
    create: { key: "payoutDay", value: String(n) },
    update: { value: String(n) },
  });
}

/** The next time that day comes round, in market time. Null when no day is set. */
export function nextPayoutDate(day: number, now = new Date()): Date | null {
  if (!day || day < 1 || day > 28) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  const y = get("year"), m = get("month"), d = get("day");

  /* Noon, so a daylight-saving shift can't slide the date onto the day before. */
  if (d <= day) return new Date(`${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00`);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return new Date(`${ny}-${String(nm).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00`);
}

/**
 * Pay periods: Monday to Sunday, paid the following Friday.
 *
 * The market's week. Everything here works on plain YYYY-MM-DD strings and
 * UTC arithmetic rather than Date objects in local time — a pay period that
 * shifts by a day when the clocks change is a pay period that pays somebody
 * for the wrong week, and it only shows up twice a year, in March and
 * November, long after anybody would connect it to daylight saving.
 */

const DAY = 86_400_000;

/** YYYY-MM-DD → a UTC Date at midnight. Nothing here cares about the time. */
function parse(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function shiftDays(iso: string, days: number): string {
  return fmt(new Date(parse(iso).getTime() + days * DAY));
}

/**
 * The Monday of the week an ISO date falls in.
 *
 * JavaScript counts Sunday as 0, so a plain subtraction puts Sunday at the
 * START of the following week — which is exactly the bug that pays Sunday's
 * shift seven days late. Sunday is pulled back six days instead.
 */
export function mondayOf(iso: string): string {
  const d = parse(iso);
  const dow = d.getUTCDay();
  return shiftDays(iso, dow === 0 ? -6 : 1 - dow);
}

export type PayPeriod = {
  /** Monday, YYYY-MM-DD. The period's id. */
  from: string;
  /** Sunday, YYYY-MM-DD, counted in full. */
  to: string;
  /** The Friday after it ends — five days past the Sunday. */
  payDate: string;
  label: string;
  payLabel: string;
};

const nice = (iso: string): string =>
  parse(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function periodFor(iso: string): PayPeriod {
  const from = mondayOf(iso);
  const to = shiftDays(from, 6);
  const payDate = shiftDays(to, 5);
  return {
    from,
    to,
    payDate,
    label: `${nice(from)} – ${nice(to)}`,
    payLabel: `Paid ${parse(payDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}`,
  };
}

/** This week's period and the ones before it, newest first. */
export function recentPeriods(todayIso: string, count = 8): PayPeriod[] {
  const out: PayPeriod[] = [];
  let cursor = mondayOf(todayIso);
  for (let i = 0; i < count; i++) {
    out.push(periodFor(cursor));
    cursor = shiftDays(cursor, -7);
  }
  return out;
}

/** True once the period has finished — the week somebody is actually paid for. */
export function isComplete(p: PayPeriod, todayIso: string): boolean {
  return todayIso > p.to;
}

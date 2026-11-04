export const TZ = "America/Chicago";

export function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: TZ });
}

export function fmtShort(d: Date): string {
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ })
  );
}

function centralYmd(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function offsetMinutes(at: Date): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
    .formatToParts(at).find((p) => p.type === "timeZoneName")?.value || "GMT-6";
  const m = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return -360;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

export function centralInputToDate(s: string): Date {
  const [d, t] = s.split("T");
  const [y, mo, day] = d.split("-").map(Number);
  const [hh = 0, mm = 0] = (t || "0:0").split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, day, hh, mm);
  return new Date(guess - offsetMinutes(new Date(guess)) * 60000);
}

export function centralDayStart(now = new Date()): Date {
  return centralInputToDate(`${centralYmd(now)}T00:00`);
}

/**
 * The last instant of a Central calendar day — 11:59:59.999 PM Central.
 *
 * ONE PLACE, because every report and every payout run needs this and the
 * tempting shortcut is wrong twice a year. "Midnight plus 24 hours less a
 * millisecond" is right for 363 days: the Sunday the clocks go back is 25
 * hours long, so +24h stops at 11pm and drops the last hour of trading off
 * the period; the Sunday they go forward is 23 hours, so +24h runs an hour
 * into Monday and counts it in both periods.
 *
 * Taking the NEXT day's Central midnight and stepping back a millisecond is
 * right every time, because the offset is worked out for that day rather than
 * assumed. Date.UTC does the calendar arithmetic, so month and year ends roll
 * over on their own.
 */
export function centralDayEnd(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return new Date(centralInputToDate(`${next}T00:00`).getTime() - 1);
}

export function centralMonthStart(now = new Date()): Date {
  const [y, m] = centralYmd(now).split("-");
  return centralInputToDate(`${y}-${m}-01T00:00`);
}

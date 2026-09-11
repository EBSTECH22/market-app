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

export function centralMonthStart(now = new Date()): Date {
  const [y, m] = centralYmd(now).split("-");
  return centralInputToDate(`${y}-${m}-01T00:00`);
}

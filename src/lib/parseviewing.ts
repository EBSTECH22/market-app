import { centralInputToDate } from "./time";

/**
 * Reads the free-text viewing times that were typed before the calendar
 * existed — "Tuesday Sep 22, 10:00 AM", "9/22 at 10", "Sept 22 10am".
 *
 * Deliberately conservative. A misread date means somebody turns up on the
 * wrong day, so anything ambiguous returns null and gets flagged for a human
 * instead of being guessed at.
 */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Build a Date from Central wall-clock parts (handles DST). */
function centralDate(y: number, monthIdx: number, d: number, h: number, mi: number): Date {
  const p = (n: number) => String(n).padStart(2, "0");
  return centralInputToDate(`${y}-${p(monthIdx + 1)}-${p(d)}T${p(h)}:${p(mi)}`);
}

/** Read a Date back as Central calendar parts. */
function centralParts(d: Date): { month: number; day: number } {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  const [, m, dd] = s.split("-").map(Number);
  return { month: m - 1, day: dd };
}

export type ParsedViewing =
  | { ok: true; date: Date; hadTime: boolean }
  | { ok: false; reason: string };

/**
 * @param raw     the stored string
 * @param nowRef  "today" — injectable so the year-guess is testable
 */
export function parseViewingText(raw: string, nowRef: Date = new Date()): ParsedViewing {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, reason: "Empty" };

  // Already a real date we wrote ourselves — trust it completely.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (iso) {
    const d = centralDate(
      Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]),
      iso[4] ? Number(iso[4]) : 12, iso[5] ? Number(iso[5]) : 0
    );
    if (isNaN(d.getTime())) return { ok: false, reason: "Unreadable date" };
    return { ok: true, date: d, hadTime: !!iso[4] };
  }

  const lower = s.toLowerCase();

  // ---- time of day ---------------------------------------------------------
  let hour: number | null = null;
  let minute = 0;
  const t = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (t) {
    hour = Number(t[1]) % 12;
    minute = t[2] ? Number(t[2]) : 0;
    if (t[3] === "pm") hour += 12;
  } else {
    const t24 = lower.match(/\b(\d{1,2}):(\d{2})\b/);
    if (t24) {
      const h = Number(t24[1]);
      if (h <= 23) { hour = h; minute = Number(t24[2]); }
    }
  }
  if (hour !== null && (hour > 23 || minute > 59)) return { ok: false, reason: "Impossible time" };

  // A bare hour — "at 10", "10 o'clock" — could be morning or evening. Silently
  // defaulting it would put someone at the market at the wrong time, so flag it
  // and let a human pick. (No time mentioned at all is fine; that gets noon.)
  if (hour === null && /\bat\s+\d{1,2}\b|\b\d{1,2}\s*o'?clock\b/.test(lower)) {
    return { ok: false, reason: "Time is ambiguous — no am/pm" };
  }

  // ---- calendar date -------------------------------------------------------
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;

  // "Sep 22" / "22 Sept" / "September 22nd"
  const named = lower.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  const namedRev = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/);
  if (named && MONTHS[named[1]] !== undefined) {
    month = MONTHS[named[1]];
    day = Number(named[2]);
  } else if (namedRev && MONTHS[namedRev[2]] !== undefined) {
    month = MONTHS[namedRev[2]];
    day = Number(namedRev[1]);
  } else {
    // Numeric M/D or M/D/Y. US order — this market is in Oklahoma.
    const num = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (num) {
      month = Number(num[1]) - 1;
      day = Number(num[2]);
      if (num[3]) {
        const y = Number(num[3]);
        year = y < 100 ? 2000 + y : y;
      }
      // A day past 12 in the first slot means it isn't US order — don't guess.
      if (Number(num[1]) > 12) return { ok: false, reason: "Ambiguous day/month order" };
    }
  }

  if (month === null || day === null) return { ok: false, reason: "No date found" };
  if (month < 0 || month > 11 || day < 1 || day > 31) return { ok: false, reason: "Date out of range" };

  const explicitYear = year !== null;
  if (year === null) {
    const y4 = lower.match(/\b(20\d{2})\b/);
    if (y4) year = Number(y4[1]);
  }

  if (year === null) {
    // No year given. Assume the nearest sensible one: this year, unless that
    // lands more than ~6 months in the past, in which case they meant next year.
    const thisYear = nowRef.getFullYear();
    const candidate = centralDate(thisYear, month, day, hour ?? 12, minute);
    const sixMonthsAgo = new Date(nowRef.getTime() - 182 * 86_400_000);
    year = candidate < sixMonthsAgo ? thisYear + 1 : thisYear;
  }

  const date = centralDate(year, month, day, hour ?? 12, minute);
  if (isNaN(date.getTime())) return { ok: false, reason: "Unreadable date" };
  // Reject a rolled-over date like "Feb 31" turning into March 3.
  if (centralParts(date).day !== day || centralParts(date).month !== month) {
    return { ok: false, reason: "That day doesn't exist in that month" };
  }

  // A viewing more than two years out is almost certainly a misread.
  const twoYears = new Date(nowRef.getTime() + 730 * 86_400_000);
  if (date > twoYears) return { ok: false, reason: "Too far in the future to trust" };

  return { ok: true, date, hadTime: hour !== null, ...(explicitYear ? {} : {}) };
}

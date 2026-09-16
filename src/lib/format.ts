import { TZ } from "./time";

/**
 * Shared formatters. Money is stored in cents everywhere; nothing in the UI
 * should ever divide by 100 inline.
 *
 * Every date and time renders in the market's timezone (Central), not the
 * viewer's. Without this, the same booking reads as a different hour on a
 * phone that has travelled, and a vendor in another timezone sees the wrong
 * market day entirely.
 */

export const money = (cents: number | null | undefined): string => {
  const c = Math.round(Number(cents) || 0);
  const sign = c < 0 ? "-" : "";
  return `${sign}$${(Math.abs(c) / 100).toFixed(2)}`;
};

/** Compact money for dense stat tiles: $1,240 / $12.4k. */
export const moneyShort = (cents: number | null | undefined): string => {
  const c = Math.round(Number(cents) || 0);
  const abs = Math.abs(c);
  const sign = c < 0 ? "-" : "";
  if (abs >= 1_000_000_00) return `${sign}$${(abs / 1_000_000_00).toFixed(1)}M`;
  if (abs >= 10_000_00) return `${sign}$${Math.round(abs / 100_00)}k`;
  return money(c);
};

export const dollarsToCents = (raw: string): number | null => {
  const s = String(raw).trim().replace(/[$,\s]/g, "");
  if (!s || !/^-?\d*\.?\d{0,2}$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

export const centsToDollars = (cents: number): string => (cents / 100).toFixed(2);

export const pct = (n: number, digits = 0): string => `${Number(n || 0).toFixed(digits)}%`;

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ dates -- */

const DATE_OPTS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", timeZone: TZ };

export const fmtDate = (d: string | Date | null | undefined): string => {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", DATE_OPTS);
};

export const fmtDateShort = (d: string | Date | null | undefined): string => {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
};

export const fmtTime = (d: string | Date | null | undefined): string => {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
};

export const fmtDateTime = (d: string | Date | null | undefined): string => {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return `${fmtDate(date)} · ${fmtTime(date)}`;
};

/** "3 minutes ago" / "in 2 days" — for activity feeds and last-seen stamps. */
export const relTime = (d: string | Date | null | undefined): string => {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const sign = diff < 0 ? -1 : 1;
  if (mins < 60) return rtf.format(sign * mins, "minute");
  const hours = Math.round(mins / 60);
  if (hours < 24) return rtf.format(sign * hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 30) return rtf.format(sign * days, "day");
  const months = Math.round(days / 30);
  if (months < 12) return rtf.format(sign * months, "month");
  return rtf.format(sign * Math.round(months / 12), "year");
};

/** YYYY-MM-DD for the market's calendar day — safe for <input type="date">. */
export const isoDate = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);

/** YYYY-MM-DDTHH:mm in Central — what <input type="datetime-local"> expects. */
export const isoDateTime = (d: Date = new Date()): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // en-CA renders midnight as 24; normalise it.
  const hh = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hh}:${get("minute")}`;
};

/* ------------------------------------------------------------------ misc -- */

export const fmtPhone = (raw: string | null | undefined): string => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return String(raw || "");
};

export const initials = (name: string): string =>
  String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** Mask a contact for display in shared views. */
export const maskContact = (contact: string): string => {
  if (!contact) return "";
  if (contact.includes("@")) {
    const [user, domain] = contact.split("@");
    return `${user.slice(0, 2)}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
  }
  const digits = contact.replace(/\D/g, "");
  return digits.length >= 4 ? `•••-•••-${digits.slice(-4)}` : contact;
};

import { db } from "@/lib/db";
import { TZ } from "@/lib/time";
import { sendFirstRentEmail } from "@/lib/email";
import { randomBytes } from "crypto";

// Posts the prorated first-month rent when a contract becomes fully executed.
// Idempotent — checks for the marker note so double-signing paths can't double-charge.
export async function postFirstMonthRent(contractId: string) {
  const c = await db.contract.findUnique({ where: { id: contractId }, include: { vendor: true } });
  if (!c || !c.vendorSignedAt || !c.marketSignedAt) return;
  const marker = `[first ${c.id.slice(0, 8)}]`;
  const already = await db.ledgerEntry.findFirst({ where: { vendorId: c.vendorId, type: "RENT", note: { contains: marker } } });
  if (already) return;

  const start = c.startDate;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(start);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  const y = get("year"), mo = get("month"), d = get("day");
  const daysInMonth = new Date(y, mo, 0).getDate();
  // policy: first month is FULL rent to get started; the SECOND month prorates back to the calendar
  const amount = c.monthlyRentCents;
  /* One month on from the start date, stored at noon UTC so it reads as the
     intended calendar day in market time whatever daylight saving is doing.
     `new Date(start); setMonth(+1)` kept the start's time-of-day, and a lease
     beginning at midnight Central in October came out at eleven at night on the
     last day of October — a day early, which the monthly run then read as a
     different month. */
  const paidThrough = new Date(Date.UTC(y, mo - 1 + 1, d, 12, 0, 0));
  await db.contract.update({ where: { id: c.id }, data: { paidThrough } });
  if (amount <= 0) return;

  let token = c.signToken;
  if (!token) {
    token = randomBytes(16).toString("hex");
    await db.contract.update({ where: { id: c.id }, data: { signToken: token } });
  }
  const startStr = start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
  await db.ledgerEntry.create({
    data: {
      vendorId: c.vendorId, type: "RENT", amountCents: -amount,
      note: `First month rent (full), booth ${c.boothLabel} — covers ${startStr} through one month ${marker}`,
    },
  });
  try {
    await sendFirstRentEmail(c.vendor.email, c.vendor.businessName, c.boothLabel, c.monthlyRentCents, amount, daysInMonth, daysInMonth, startStr, !!c.vendor.cardLast4, token);
  } catch {}
}

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
  const daysCharged = daysInMonth - d + 1;
  const amount = Math.round((c.monthlyRentCents * daysCharged) / daysInMonth);
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
      note: `First month rent, booth ${c.boothLabel} — prorated from ${startStr} (${daysCharged}/${daysInMonth} days) ${marker}`,
    },
  });
  try {
    await sendFirstRentEmail(c.vendor.email, c.vendor.businessName, c.boothLabel, c.monthlyRentCents, amount, daysCharged, daysInMonth, startStr, !!c.vendor.cardLast4, token);
  } catch {}
}

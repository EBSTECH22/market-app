import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { sendTentConfirmEmail } from "@/lib/email";

export const TENT_DEPOSIT_CENTS = 1250;
export const TENT_DAY_CENTS = 2500;
export const TENT_BALANCE_CENTS = TENT_DAY_CENTS - TENT_DEPOSIT_CENTS;

// Verify Stripe deposit and confirm the booking. Idempotent.
export async function finalizeTentIfPaid(bookingId: string): Promise<boolean> {
  const b = await db.tentBooking.findUnique({ where: { id: bookingId }, include: { date: true } });
  if (!b) return false;
  if (b.status !== "RESERVED" || !b.stripeSessionId || !stripe) return b?.status === "PAID_DEPOSIT";
  let paid = false;
  try {
    const session = await stripe.checkout.sessions.retrieve(b.stripeSessionId);
    paid = session.payment_status === "paid";
  } catch { return false; }
  if (!paid) return false;
  await db.tentBooking.update({ where: { id: b.id }, data: { status: "PAID_DEPOSIT" } });
  try { await sendTentConfirmEmail(b.email, b.name, b.date.date, b.token, false); } catch (err) { console.error("tent email failed", err); }
  return true;
}

export async function reconcileTents(): Promise<void> {
  const open = await db.tentBooking.findMany({
    where: { status: "RESERVED", stripeSessionId: { not: "" } },
    take: 25, orderBy: { createdAt: "desc" },
  });
  for (const b of open) await finalizeTentIfPaid(b.id).catch(() => {});
}

export function tentSpotsTaken(bookings: { status: string }[]): number {
  return bookings.filter((b) => ["PAID_DEPOSIT", "CHECKED_IN"].includes(b.status)).length;
}

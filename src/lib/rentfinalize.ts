import { db } from "@/lib/db";
import { reholdOnPayment } from "@/lib/spacehold";
import { stripe } from "@/lib/stripe";
import { unlockIfRentPaid } from "@/lib/unlock";
import { notifyRentPaid } from "@/lib/rentpaid";

const PROCESSING_PERCENT = 3;

export type RentFinalizeResult =
  | { ok: true; vendorId: string; dueCents: number; feeCents: number; last4: string; newlyRecorded: boolean }
  | { ok: false; error: string; status: number };

/**
 * Turn a completed Stripe checkout session into a rent payment.
 *
 * This lives here because THREE callers need identical behaviour: the invoice
 * link's success page, the vendor portal's success page, and the Stripe
 * webhook. The webhook is the one that matters — the other two only run if the
 * vendor's browser makes it back after paying, and a closed tab or a dropped
 * signal used to mean the money was taken and the app never knew.
 *
 * Idempotent by the ledger marker: the PaymentIntent id is stamped into the
 * entry's note, so whichever caller arrives second finds it and does nothing.
 * Stripe delivers webhooks at least once, so that guard is load-bearing.
 *
 * @param expectVendorId when set, the session must belong to this vendor.
 *   Passed by the portal route (where we know who is logged in), omitted by
 *   the webhook (which has no session of its own).
 */
export async function finalizeRentFromSession(
  sessionId: string,
  expectVendorId?: string
): Promise<RentFinalizeResult> {
  if (!stripe) return { ok: false, error: "Card payments aren't configured.", status: 500 };
  if (!sessionId) return { ok: false, error: "Missing session.", status: 400 };

  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
  const pi = session.payment_intent as
    | { id: string; status: string; payment_method?: string | { id: string }; metadata?: Record<string, string> }
    | null;

  if (!pi || pi.status !== "succeeded") {
    return { ok: false, error: "Payment not completed.", status: 400 };
  }

  const vendorId = pi.metadata?.vendorId || "";
  if (!vendorId) return { ok: false, error: "This session isn't a rent payment.", status: 400 };
  if (expectVendorId && vendorId !== expectVendorId) {
    return { ok: false, error: "Session mismatch.", status: 400 };
  }

  const marker = `[ck ${pi.id.slice(-10)}]`;
  const already = await db.ledgerEntry.findFirst({
    where: { vendorId, type: "RENT_PAYMENT", note: { contains: marker } },
  });

  // Save the card for next month's auto-charge. Safe to repeat.
  const pmId = typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id;
  let last4 = "";
  if (pmId) {
    try {
      const pm = await stripe.paymentMethods.retrieve(pmId);
      last4 = pm.card?.last4 || "";
      await db.vendor.update({ where: { id: vendorId }, data: { stripePmId: pmId, cardLast4: last4 } });
    } catch { /* the payment still counts even if we can't store the card */ }
  }

  const dueCents = Number(pi.metadata?.dueCents || 0);
  const feeCents = Number(pi.metadata?.feeCents || 0);

  let newlyRecorded = false;
  if (!already && dueCents > 0) {
    await db.ledgerEntry.create({
      data: {
        vendorId,
        type: "RENT_PAYMENT",
        amountCents: dueCents,
        note: `Rent paid by card ····${last4}: $${((dueCents + feeCents) / 100).toFixed(2)} charged (includes $${(feeCents / 100).toFixed(2)} card-processing adjustment, ${PROCESSING_PERCENT}%) ${marker}`,
      },
    });
    newlyRecorded = true;
  }

  // Outside the guard on purpose: if a previous attempt recorded the payment
  // but died before unlocking, this is what eventually puts it right.
  try { await unlockIfRentPaid(vendorId); } catch {}
  // Paying while a space was still going takes one back off the list.
  try { await reholdOnPayment(vendorId); } catch {}

  return { ok: true, vendorId, dueCents, feeCents, last4, newlyRecorded };
}

/** Finalize and notify — the notification only fires for a genuinely new payment. */
export async function finalizeRentAndNotify(
  sessionId: string,
  source: "link" | "portal" | "webhook",
  expectVendorId?: string
): Promise<RentFinalizeResult> {
  const res = await finalizeRentFromSession(sessionId, expectVendorId);
  if (res.ok && res.newlyRecorded) {
    await notifyRentPaid(res.vendorId, {
      paidCents: res.dueCents,
      feeCents: res.feeCents,
      last4: res.last4,
      // The webhook is the path that fires when the vendor never came back,
      // so it's worth being able to tell that apart in the alert.
      source: source === "webhook" ? "link" : source,
    });
  }
  return res;
}

import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { sendOrderConfirmEmail, sendVendorOrderEmail } from "@/lib/email";
import { pushToVendor } from "@/lib/push";
import { releaseOnlineStock } from "@/lib/orders";

/**
 * Turning a completed Stripe checkout into a paid order.
 *
 * Three callers need identical behaviour: the customer's return to the order
 * page, the Stripe webhook, and a vendor refreshing their orders list. The
 * webhook is the one that matters — the others only run if a browser came back,
 * and "paid but the shop never heard" is the failure that costs a vendor a sale
 * and the market its credibility.
 *
 * Idempotent on the order's own status. Whoever arrives second finds it already
 * PAID and does nothing: no second ledger credit, no second email, no second
 * push. Stripe delivers webhooks at least once, so that guard carries weight.
 */

export type FinalizeResult =
  | { ok: true; orderId: string; number: number; alreadyDone: boolean }
  | { ok: false; error: string };

export async function finalizeOrder(orderId: string): Promise<FinalizeResult> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { lines: true, vendor: { select: { id: true, email: true, businessName: true } } },
  });
  if (!order) return { ok: false, error: "Order not found." };
  if (order.status !== "PENDING") {
    return { ok: true, orderId: order.id, number: order.number, alreadyDone: true };
  }
  if (!stripe) return { ok: false, error: "Stripe isn't configured." };
  if (!order.stripeSessionId) return { ok: false, error: "That order never reached checkout." };

  /* Ask Stripe, don't take the caller's word. This function is reachable from
     a URL the customer holds, and "mark my order paid" is not a thing a URL
     should be able to do. */
  const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
  if (session.payment_status !== "paid") {
    return { ok: false, error: "That payment hasn't completed." };
  }

  /* The delivery address, as Stripe collected it. Read here rather than at
     checkout because it doesn't exist until the customer types it in. */
  const ship = (session as { shipping_details?: { name?: string; address?: Record<string, string> } }).shipping_details;
  const addr = ship?.address;

  /* The claim is conditional on the status STILL being PENDING, so two
     simultaneous finalizers can't both credit the vendor. */
  const claimed = await db.order.updateMany({
    where: { id: order.id, status: "PENDING" },
    data: {
      status: "PAID",
      paidAt: new Date(),
      shipName: ship?.name || order.customerName,
      shipLine1: addr?.line1 || "",
      shipLine2: addr?.line2 || "",
      shipCity: addr?.city || "",
      shipState: addr?.state || "",
      shipPostal: addr?.postal_code || "",
    },
  });
  if (claimed.count === 0) {
    return { ok: true, orderId: order.id, number: order.number, alreadyDone: true };
  }

  /* The vendor's money, on the same ledger as everything else they earn — which
     is what puts it into the balance the payout runs pay out. Goods less
     commission, plus shipping in full. */
  await db.ledgerEntry.create({
    data: {
      vendorId: order.vendorId,
      type: "SALE",
      amountCents: order.vendorNetCents,
      note: `Online order #${order.number}${order.shippingCents ? " (includes shipping)" : ""}`,
    },
  });

  // Stock was taken when checkout started; nothing to decrement here.

  try {
    await sendOrderConfirmEmail(order.customerEmail, {
      number: order.number,
      vendorName: order.vendor.businessName,
      fulfillment: order.fulfillment,
      token: order.token,
      lines: order.lines.map((l) => ({ name: l.name, unitLabel: l.unitLabel, quantity: l.quantity, priceCents: l.priceCents })),
      subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents,
      taxCents: order.taxCents,
      totalCents: order.totalCents,
    });
  } catch (err) {
    console.error("[order] confirmation email failed", order.number, err);
  }

  try {
    if (order.vendor.email) {
      await sendVendorOrderEmail(order.vendor.email, {
        number: order.number,
        customerName: order.customerName,
        fulfillment: order.fulfillment,
        netCents: order.vendorNetCents,
        lines: order.lines.map((l) => ({ name: l.name, quantity: l.quantity })),
      });
    }
  } catch (err) {
    console.error("[order] vendor email failed", order.number, err);
  }

  try {
    await pushToVendor(
      order.vendorId,
      `Online order #${order.number} 🛍️`,
      `${order.customerName} — ${order.fulfillment === "SHIP" ? "to post" : "for collection"}. $${(order.vendorNetCents / 100).toFixed(2)} to your balance.`
    );
  } catch { /* a notification must never fail an order */ }

  return { ok: true, orderId: order.id, number: order.number, alreadyDone: false };
}

/**
 * A checkout that was started and never paid.
 *
 * The stock it was holding goes back on the virtual shelf. Without this, one
 * abandoned basket takes a vendor's last item out of circulation permanently —
 * which looks exactly like the shop being broken.
 */
export async function expireOrder(orderId: string): Promise<void> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { lines: true } });
  if (!order || order.status !== "PENDING") return;

  const claimed = await db.order.updateMany({
    where: { id: order.id, status: "PENDING" },
    data: { status: "EXPIRED" },
  });
  if (claimed.count === 0) return; // it got paid in the meantime

  await releaseOnlineStock(order.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })));
}

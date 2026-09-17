import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { finalizeOrder } from "@/lib/orderfinalize";
import { ORDER_STATUS_LABEL } from "@/lib/orders";
import { pickupCode } from "@/lib/pickupcode";

export const dynamic = "force-dynamic";

/**
 * The customer's view of their own order.
 *
 * The token IS the authentication — 48 hex characters, emailed to the address
 * that placed the order. So this returns only what that customer already knows:
 * what they bought, what they paid, where it has got to. No vendor internals, no
 * ledger, no other orders.
 *
 * It also finalizes on arrival. The customer landing here from Stripe is
 * usually the FIRST thing to know the payment succeeded — the webhook may be
 * seconds behind, and an order page that says "waiting for payment" to somebody
 * who just paid is a support call.
 */
export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  return runRoute("public/order GET", async () => {
    const token = String(params.token || "");
    if (!/^[a-f0-9]{16,64}$/i.test(token)) return NextResponse.json({ error: "Order not found." }, { status: 404 });

    const found = await db.order.findUnique({ where: { token }, select: { id: true, status: true } });
    if (!found) return NextResponse.json({ error: "Order not found." }, { status: 404 });

    if (found.status === "PENDING") {
      // Best effort: if the payment hasn't actually completed this does nothing.
      try { await finalizeOrder(found.id); } catch { /* the webhook will get it */ }
    }

    const order = await db.order.findUnique({
      where: { token },
      include: {
        lines: { select: { name: true, unitLabel: true, quantity: true, priceCents: true } },
        vendor: { select: { businessName: true, code: true, email: true } },
      },
    });
    if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });

    return NextResponse.json({
      number: order.number,
      /* Shown to the customer so they can read it out when the camera won't
         focus. Safe here and nowhere else: this response already required the
         token the code is derived from. */
      pickupCode: pickupCode(order.number, order.token),
      status: order.status,
      statusLabel: ORDER_STATUS_LABEL[order.status] || order.status,
      fulfillment: order.fulfillment,
      placedAt: order.createdAt,
      paidAt: order.paidAt,
      readyAt: order.readyAt,
      completedAt: order.completedAt,
      customerName: order.customerName,
      note: order.note,
      vendor: { businessName: order.vendor.businessName, code: order.vendor.code, email: order.vendor.email },
      lines: order.lines,
      subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents,
      taxCents: order.taxCents,
      totalCents: order.totalCents,
      carrier: order.carrier,
      trackingNumber: order.trackingNumber,
      shipTo: order.fulfillment === "SHIP"
        ? {
            name: order.shipName, line1: order.shipLine1, line2: order.shipLine2,
            city: order.shipCity, state: order.shipState, postal: order.shipPostal,
          }
        : null,
    });
  });
}

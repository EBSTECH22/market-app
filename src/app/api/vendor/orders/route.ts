import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { sendOrderStatusEmail } from "@/lib/email";
import { ORDER_STATUS_LABEL, nextStatuses, OPEN_STATUSES, releaseOnlineStock } from "@/lib/orders";

export const dynamic = "force-dynamic";

/**
 * A vendor's online orders — theirs only, and the only place they're worked.
 *
 * The market doesn't pack these. A vendor sells online, a vendor packs it, and
 * staff at the counter hand over what's already sitting there labelled. So the
 * whole flow lives in the vendor's portal, and the admin side only watches.
 */
export async function GET(req: NextRequest) {
  return runRoute("vendor/orders GET", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

    const scope = req.nextUrl.searchParams.get("scope") || "open";
    const where =
      scope === "all"
        ? { vendorId, status: { not: "PENDING" } }
        : scope === "done"
          ? { vendorId, status: { in: ["COLLECTED", "SHIPPED", "CANCELLED", "REFUNDED"] } }
          : { vendorId, status: { in: OPEN_STATUSES } };

    const orders = await db.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { lines: { select: { name: true, unitLabel: true, quantity: true, priceCents: true } } },
    });

    const openCount = await db.order.count({ where: { vendorId, status: { in: OPEN_STATUSES } } });

    return NextResponse.json({
      openCount,
      orders: orders.map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        statusLabel: ORDER_STATUS_LABEL[o.status] || o.status,
        next: nextStatuses(o.status, o.fulfillment),
        fulfillment: o.fulfillment,
        customerName: o.customerName,
        customerEmail: o.customerEmail,
        customerPhone: o.customerPhone,
        note: o.note,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        lines: o.lines,
        subtotalCents: o.subtotalCents,
        shippingCents: o.shippingCents,
        taxCents: o.taxCents,
        totalCents: o.totalCents,
        vendorNetCents: o.vendorNetCents,
        carrier: o.carrier,
        trackingNumber: o.trackingNumber,
        shipTo: o.fulfillment === "SHIP"
          ? { name: o.shipName, line1: o.shipLine1, line2: o.shipLine2, city: o.shipCity, state: o.shipState, postal: o.shipPostal }
          : null,
      })),
    });
  });
}

// PATCH { orderId, status, carrier?, trackingNumber? }
export async function PATCH(req: NextRequest) {
  return runRoute("vendor/orders PATCH", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

    const body = await req.json();
    const order = await db.order.findUnique({
      where: { id: String(body.orderId || "") },
      include: { lines: true, vendor: { select: { businessName: true } } },
    });
    if (!order || order.vendorId !== vendorId) return NextResponse.json({ error: "Order not found." }, { status: 404 });

    const status = String(body.status || "").toUpperCase();
    /* Only the moves that make sense from where it is. Without this an order
       could go from "collected" back to "needs packing", and the customer would
       get an email telling them to come and fetch something they took home
       yesterday. */
    if (!nextStatuses(order.status, order.fulfillment).includes(status)) {
      return NextResponse.json(
        { error: `An order that's "${ORDER_STATUS_LABEL[order.status] || order.status}" can't be moved to that.` },
        { status: 400 }
      );
    }

    const carrier = String(body.carrier || "").trim().slice(0, 40);
    const trackingNumber = String(body.trackingNumber || "").trim().slice(0, 60);

    const data: Record<string, unknown> = { status };
    if (status === "READY") data.readyAt = new Date();
    if (status === "SHIPPED") {
      data.completedAt = new Date();
      if (carrier) data.carrier = carrier;
      if (trackingNumber) data.trackingNumber = trackingNumber;
    }
    if (status === "COLLECTED") data.completedAt = new Date();

    if (status === "CANCELLED") {
      /* Cancelling puts the stock back but does NOT refund the card — this app
         has no authority to move somebody else's money without them asking.
         The vendor is told to sort the refund out, rather than being left to
         assume it happened. */
      data.completedAt = new Date();
      await releaseOnlineStock(order.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })));
    }

    await db.order.update({ where: { id: order.id }, data });

    if (status === "READY" || status === "SHIPPED") {
      try {
        await sendOrderStatusEmail(order.customerEmail, {
          number: order.number,
          vendorName: order.vendor.businessName,
          status,
          token: order.token,
          carrier: carrier || order.carrier,
          tracking: trackingNumber || order.trackingNumber,
        });
      } catch (err) {
        console.error("[vendor/orders] status email failed", order.number, err);
      }
    }

    return NextResponse.json({
      ok: true,
      status,
      refundNeeded: status === "CANCELLED",
      refundCents: status === "CANCELLED" ? order.totalCents : 0,
    });
  });
}

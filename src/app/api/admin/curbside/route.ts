import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { denyUnless } from "@/lib/perm";
import { runRoute } from "@/lib/handler";

export const dynamic = "force-dynamic";

/**
 * Pulling a curbside order onto the till.
 *
 * Somebody who chose to pay inside walks up and says "order 5021". Re-keying
 * the drink would price it a second time, from scratch, with whatever the menu
 * says now — and the two figures only have to differ once, in front of the
 * customer, for the feature to lose its credibility. So the ticket is built
 * from the order's own lines.
 *
 * GET  ?number=5021  → the lines, ready to put on the ticket
 * POST { orderId, saleId } → mark it paid, by that sale
 */
export async function GET(req: NextRequest) {
  return runRoute("admin/curbside GET", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }

    const raw = (req.nextUrl.searchParams.get("number") || "").replace(/\D/g, "");

    /* NO NUMBER: the whole board.
    
       The stand sees its own queue; the office saw nothing at all, which left
       the counter unable to answer "is my drink coming?" and nobody watching
       an order that had been sitting unpaid for twenty minutes with somebody
       parked outside. Read-only on purpose — moving an order along is the
       stand's job, and two people tapping Ready is how a drink goes out
       twice. */
    if (!raw) {
      const live = await db.order.findMany({
        where: { fulfillment: "CURBSIDE", status: { in: ["PLACED", "ACCEPTED", "READY"] } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, number: true, status: true, createdAt: true, paidAt: true, arrivedAt: true,
          totalCents: true, vehicleColor: true, customerName: true, customerPhone: true,
          vendor: { select: { businessName: true, code: true } },
          lines: { select: { name: true, quantity: true, optionsText: true } },
        },
      });
      return NextResponse.json({
        orders: live.map((o) => ({
          id: o.id,
          number: o.number,
          status: o.status,
          vendorName: o.vendor.businessName,
          vendorCode: o.vendor.code,
          vehicleColor: o.vehicleColor,
          customerName: o.customerName,
          customerPhone: o.customerPhone,
          paid: !!o.paidAt,
          arrived: !!o.arrivedAt,
          totalCents: o.totalCents,
          /* Minutes, worked out here so every screen agrees and nobody is
             comparing a server timestamp against a till's clock. */
          waitingMinutes: Math.max(0, Math.round((Date.now() - new Date(o.createdAt).getTime()) / 60000)),
          lines: o.lines,
        })),
      });
    }

    const order = await db.order.findFirst({
      where: { number: Number(raw), fulfillment: "CURBSIDE" },
      select: {
        id: true, number: true, status: true, paidAt: true, saleId: true, totalCents: true,
        vehicleColor: true, customerName: true, vendorId: true,
        vendor: { select: { businessName: true } },
        lines: { select: { itemId: true, name: true, quantity: true, priceCents: true, optionsText: true, taxClass: true } },
      },
    });
    if (!order) return NextResponse.json({ error: `No curbside order #${raw}.` }, { status: 404 });

    if (order.paidAt || order.saleId) {
      return NextResponse.json({ error: `Order #${order.number} is already paid for.` }, { status: 409 });
    }
    if (order.status === "CANCELLED") {
      return NextResponse.json({ error: `Order #${order.number} was cancelled.` }, { status: 409 });
    }

    return NextResponse.json({
      order: {
        id: order.id,
        number: order.number,
        status: order.status,
        vendorName: order.vendor.businessName,
        vehicleColor: order.vehicleColor,
        customerName: order.customerName,
        totalCents: order.totalCents,
        lines: order.lines,
      },
    });
  });
}

/**
 * The sale that paid for it.
 *
 * The money is booked by the till in the usual way — the vendor's ledger, the
 * drawer, the tax split, all of it — and this only records WHICH sale, so the
 * order stops asking and can be handed over. Nothing here moves money, which
 * is why it needs no more than "ops".
 */
export async function POST(req: NextRequest) {
  return runRoute("admin/curbside POST", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }

    const body = await req.json().catch(() => ({}));
    const orderId = String(body.orderId || "");
    const saleId = String(body.saleId || "");
    if (!orderId || !saleId) return NextResponse.json({ error: "Missing the order or the sale." }, { status: 400 });

    const order = await db.order.findFirst({
      where: { id: orderId, fulfillment: "CURBSIDE" },
      select: { id: true, number: true, paidAt: true, saleId: true },
    });
    if (!order) return NextResponse.json({ error: "No such order." }, { status: 404 });

    /* Paid twice is the thing to guard: the till can resend, and marking it
       again would overwrite the record of which sale actually covered it. */
    if (order.paidAt || order.saleId) {
      return NextResponse.json({ ok: true, alreadyPaid: true });
    }

    await db.order.update({
      where: { id: order.id },
      data: { saleId, paidAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  });
}

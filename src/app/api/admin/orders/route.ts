import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";
import { ORDER_STATUS_LABEL, OPEN_STATUSES } from "@/lib/orders";
import { parsePickupCode, pickupCodeMatches } from "@/lib/pickupcode";

export const dynamic = "force-dynamic";

/**
 * Online orders, from the market's side of the counter.
 *
 * The market does NOT pack these — vendors do. What staff need is the one thing
 * that happens in the building: somebody walks in for an order that's sitting
 * there, and it gets handed over. So this lists what's waiting and lets a
 * cashier close it off, and nothing else.
 *
 * "ops" rather than "financials" on purpose: handing over a collection is the
 * job of whoever is on the till.
 */
export async function GET(req: NextRequest) {
  return runRoute("admin/orders GET", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }

    /* A scanned collection code. Answered here rather than in its own route
       because the till wants exactly what the list gives it — same shape, same
       fields, straight into the same hand-over button. */
    const code = req.nextUrl.searchParams.get("code");
    if (code) {
      const parsed = parsePickupCode(code);
      if (!parsed) {
        return NextResponse.json({ error: "That isn't a collection code." }, { status: 400 });
      }
      const match = await db.order.findFirst({
        where: { number: parsed.number },
        include: {
          lines: { select: { name: true, quantity: true } },
          vendor: { select: { code: true, businessName: true } },
        },
      });
      /* The wrong check characters are treated exactly like no order at all.
         Saying "that order exists but your code is wrong" would tell somebody
         guessing that they had the number right. */
      if (!match || !pickupCodeMatches(code, match)) {
        return NextResponse.json({ error: "No order with that code." }, { status: 404 });
      }
      if (match.status !== "READY") {
        return NextResponse.json(
          {
            error:
              match.status === "COLLECTED"
                ? `Order #${match.number} was already handed over.`
                : `Order #${match.number} is "${ORDER_STATUS_LABEL[match.status] || match.status}" — ${match.vendor.businessName} hasn't dropped it off yet.`,
          },
          { status: 409 }
        );
      }
      return NextResponse.json({
        order: {
          id: match.id,
          number: match.number,
          status: match.status,
          statusLabel: ORDER_STATUS_LABEL[match.status] || match.status,
          fulfillment: match.fulfillment,
          customerName: match.customerName,
          customerEmail: match.customerEmail,
          customerPhone: match.customerPhone,
          vendorCode: match.vendor.code,
          vendorName: match.vendor.businessName,
          lines: match.lines,
          totalCents: match.totalCents,
          createdAt: match.createdAt,
          readyAt: match.readyAt,
        },
      });
    }

    const scope = req.nextUrl.searchParams.get("scope") || "waiting";
    const where =
      scope === "all"
        ? { status: { not: "PENDING" } }
        : scope === "ready"
          ? { status: "READY", fulfillment: "PICKUP" }
          : { status: { in: OPEN_STATUSES } };

    const orders = await db.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        lines: { select: { name: true, quantity: true } },
        vendor: { select: { code: true, businessName: true } },
      },
    });

    const readyCount = await db.order.count({ where: { status: "READY", fulfillment: "PICKUP" } });

    return NextResponse.json({
      readyCount,
      orders: orders.map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        statusLabel: ORDER_STATUS_LABEL[o.status] || o.status,
        fulfillment: o.fulfillment,
        customerName: o.customerName,
        customerEmail: o.customerEmail,
        customerPhone: o.customerPhone,
        vendorCode: o.vendor.code,
        vendorName: o.vendor.businessName,
        lines: o.lines,
        totalCents: o.totalCents,
        createdAt: o.createdAt,
        readyAt: o.readyAt,
      })),
    });
  });
}

// PATCH { orderId } — handed over at the counter
export async function PATCH(req: NextRequest) {
  return runRoute("admin/orders PATCH", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const body = await req.json();

    const order = await db.order.findUnique({
      where: { id: String(body.orderId || "") },
      include: { vendor: { select: { code: true, businessName: true } } },
    });
    if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });
    if (order.status !== "READY") {
      return NextResponse.json(
        { error: `That order is "${ORDER_STATUS_LABEL[order.status] || order.status}" — only one marked ready can be handed over.` },
        { status: 400 }
      );
    }

    /* Conditional, so two people at two tills can't both hand over the same
       order and both record it. */
    const claimed = await db.order.updateMany({
      where: { id: order.id, status: "READY" },
      data: { status: "COLLECTED", completedAt: new Date() },
    });
    if (claimed.count === 0) return NextResponse.json({ error: "Somebody just handed that one over." }, { status: 409 });

    await recordAudit(
      {
        action: "ORDER_COLLECTED",
        targetType: "ORDER",
        targetId: order.id,
        targetLabel: `Order #${order.number} — ${order.vendor.businessName}`,
        detail: `Online order #${order.number} handed to ${order.customerName}`,
      },
      req
    );

    return NextResponse.json({ ok: true });
  });
}

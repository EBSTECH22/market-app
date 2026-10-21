import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { canAdvance, isLive, openState, minuteOfDay, clockLabel } from "@/lib/curbside";
import { TZ } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * The stand's own screen: what's waiting, and the four buttons that move it.
 *
 * Deliberately only today's live orders plus what has just been handed over —
 * a one-person stand with a phone propped against the till needs the next
 * drink, not a history.
 */

const ORDER_FIELDS = {
  id: true, number: true, status: true, createdAt: true, paidAt: true,
  arrivedAt: true, handedOverAt: true, handedOverBy: true, totalCents: true,
  vehicleColor: true, customerName: true, customerPhone: true, note: true, saleId: true,
  lines: { select: { name: true, quantity: true, optionsText: true, priceCents: true } },
} as const;

async function screen(vendorId: string) {
  const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const [orders, vendor] = await Promise.all([
    db.order.findMany({
      where: {
        vendorId,
        fulfillment: "CURBSIDE",
        OR: [
          { status: { in: ["PLACED", "ACCEPTED", "READY"] } },
          { status: { in: ["COLLECTED", "NO_SHOW", "CANCELLED"] }, createdAt: { gte: since } },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: ORDER_FIELDS,
    }),
    db.vendor.findUnique({
      where: { id: vendorId },
      select: {
        curbsideEnabled: true, curbsideOpenMinute: true, curbsideCloseMinute: true,
        curbsideCutoffMinutes: true, curbsidePausedUntil: true,
      },
    }),
  ]);

  const state = vendor
    ? openState(minuteOfDay(new Date(), TZ), {
        openMinute: vendor.curbsideOpenMinute,
        closeMinute: vendor.curbsideCloseMinute,
        cutoffMinutes: vendor.curbsideCutoffMinutes,
      }, { enabled: vendor.curbsideEnabled, pausedUntil: vendor.curbsidePausedUntil })
    : { open: false as const, reason: "Not set up." };

  return {
    enabled: !!vendor?.curbsideEnabled,
    open: state.open,
    reason: state.open ? "" : state.reason,
    pausedUntil: vendor?.curbsidePausedUntil || null,
    hours: vendor
      ? {
          open: clockLabel(vendor.curbsideOpenMinute),
          close: clockLabel(vendor.curbsideCloseMinute),
          lastOrder: clockLabel(vendor.curbsideCloseMinute - vendor.curbsideCutoffMinutes),
        }
      : null,
    live: orders.filter((o) => isLive(o.status)),
    done: orders.filter((o) => !isLive(o.status)),
  };
}

export async function GET() {
  return runRoute("vendor/curbside GET", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
    return NextResponse.json(await screen(vendorId));
  });
}

/**
 * PATCH { orderId, to }            — move one order along
 * PATCH { pauseMinutes }           — "back in fifteen"
 * PATCH { pauseMinutes: 0 }        — taking orders again
 */
export async function PATCH(req: NextRequest) {
  return runRoute("vendor/curbside PATCH", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    if (body.pauseMinutes !== undefined) {
      const mins = Math.max(0, Math.min(240, Math.round(Number(body.pauseMinutes) || 0)));
      await db.vendor.update({
        where: { id: vendorId },
        data: { curbsidePausedUntil: mins > 0 ? new Date(Date.now() + mins * 60_000) : null },
      });
      return NextResponse.json(await screen(vendorId));
    }

    const orderId = String(body.orderId || "");
    const to = String(body.to || "").toUpperCase();

    /* "THEY'RE HERE", pressed by the stand.
    
       The customer's own button is the usual way, but somebody who closed the
       tab, has a flat battery, or simply walked in and said so still needs
       marking — and arrival is the one thing on this screen the stand can
       know without the app telling them. Separate from the preparation
       buttons because arriving isn't a step in making a drink. */
    if (to === "ARRIVED") {
      const o = await db.order.findFirst({
        where: { id: orderId, vendorId, fulfillment: "CURBSIDE" },
        select: { id: true, status: true, arrivedAt: true },
      });
      if (!o) return NextResponse.json({ error: "No such order." }, { status: 404 });
      if (!isLive(o.status)) return NextResponse.json({ error: "That order is already finished." }, { status: 409 });
      if (!o.arrivedAt) await db.order.update({ where: { id: o.id }, data: { arrivedAt: new Date() } });
      return NextResponse.json(await screen(vendorId));
    }
    const order = await db.order.findFirst({
      where: { id: orderId, vendorId, fulfillment: "CURBSIDE" },
      select: { id: true, status: true, paidAt: true, number: true, saleId: true },
    });
    if (!order) return NextResponse.json({ error: "No such order." }, { status: 404 });

    if (!canAdvance(order.status, to)) {
      return NextResponse.json({ error: `Can't go from ${order.status.toLowerCase()} to ${to.toLowerCase()}.` }, { status: 400 });
    }

    /* HANDING OVER AN UNPAID DRINK IS THE ONE IRREVERSIBLE MISTAKE HERE.

       Once it is in the car, the money is gone — there is no reader in the car
       park and nobody is chasing a stranger down Main Street for $4. So an
       order being paid inside cannot be marked collected until the register
       has rung it, which is what `saleId` records. */
    if (to === "COLLECTED" && !order.paidAt && !order.saleId) {
      return NextResponse.json(
        { error: "This one hasn't been paid for. Ring it up at the register first — pull it up by order number." },
        { status: 409 }
      );
    }

    /* WHO handed it over, by name. "Recorded" has to mean something a month
       later when somebody says they never got it, and "the stand" is not an
       answer. The vendor is the one tapping this screen, so it is their name
       on it; the register path records the employee instead. */
    const who = (await db.vendor.findUnique({ where: { id: vendorId }, select: { businessName: true } }))?.businessName || "";

    const now = new Date();
    await db.order.update({
      where: { id: order.id },
      data: {
        status: to,
        ...(to === "READY" ? { readyAt: now } : {}),
        ...(to === "COLLECTED"
          ? { completedAt: now, handedOverAt: now, handedOverBy: who }
          : {}),
      },
    });

    return NextResponse.json(await screen(vendorId));
  });
}

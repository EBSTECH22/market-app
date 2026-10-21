import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { queuePosition, customerLine, isLive } from "@/lib/curbside";
import { finalizeOrder } from "@/lib/orderfinalize";
import { pushToVendor } from "@/lib/push";

export const dynamic = "force-dynamic";

/**
 * The customer's own view of their order, and the button they press on
 * arrival.
 *
 * This is the whole notification channel. Because a kerbside order is placed
 * minutes before collection, the page they ordered on stays open in their hand
 * and polls — so there is nothing to text, nothing to install, and no message
 * to miss. The token in the URL is the only thing identifying them, which is
 * why it is long and why nothing here will say who else has ordered.
 */

const PUBLIC_FIELDS = {
  id: true, number: true, token: true, status: true, createdAt: true,
  paidAt: true, arrivedAt: true, handedOverAt: true, totalCents: true,
  vehicleColor: true, customerName: true, fulfillment: true,
  vendor: { select: { businessName: true, code: true } },
  lines: { select: { name: true, quantity: true, priceCents: true, optionsText: true } },
} as const;

async function view(token: string) {
  const order = await db.order.findFirst({
    where: { token, fulfillment: "CURBSIDE" },
    select: { ...PUBLIC_FIELDS, vendorId: true },
  });
  if (!order) return null;

  const live = await db.order.findMany({
    where: { vendorId: order.vendorId, fulfillment: "CURBSIDE", status: { in: ["PLACED", "ACCEPTED", "READY"] } },
    select: { id: true, createdAt: true, status: true },
  });
  const ahead = queuePosition(order, live);

  return {
    number: order.number,
    vendorName: order.vendor.businessName,
    status: order.status,
    paid: !!order.paidAt,
    arrived: !!order.arrivedAt,
    totalCents: order.totalCents,
    vehicleColor: order.vehicleColor,
    ahead,
    /* One sentence, built from the three fields rather than from `status`
       alone — "ready" and "they know you're here" are different things and a
       customer needs to be told which. */
    message: customerLine({ status: order.status, paidAt: order.paidAt, arrivedAt: order.arrivedAt, ahead }),
    canCheckIn: isLive(order.status) && !order.arrivedAt,
    lines: order.lines,
  };
}

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  return runRoute("public/curbside order GET", async () => {
    /* A card payment that has just come back from Stripe may not have been
       finalised yet. Doing it here as well as in the webhook means the
       customer's own page is never the last to know. */
    const pending = await db.order.findFirst({
      where: { token: params.token, fulfillment: "CURBSIDE", status: "PENDING" },
      select: { id: true },
    });
    if (pending) await finalizeOrder(pending.id).catch(() => {});

    const v = await view(params.token);
    if (!v) return NextResponse.json({ error: "No order here." }, { status: 404 });
    return NextResponse.json(v);
  });
}

/** POST { action: "arrived" } — "I'm outside." */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  return runRoute("public/curbside order POST", async () => {
    const body = await req.json().catch(() => ({}));
    if (body.action !== "arrived") return NextResponse.json({ error: "Unknown action." }, { status: 400 });

    const order = await db.order.findFirst({
      where: { token: params.token, fulfillment: "CURBSIDE" },
      select: { id: true, number: true, vendorId: true, status: true, arrivedAt: true, vehicleColor: true, customerName: true, paidAt: true },
    });
    if (!order) return NextResponse.json({ error: "No order here." }, { status: 404 });
    if (!isLive(order.status)) return NextResponse.json({ error: "That order is already finished." }, { status: 409 });

    /* Pressed twice — the second press is not a second arrival, and must not
       buzz the stand again. */
    if (order.arrivedAt) {
      const v = await view(params.token);
      return NextResponse.json(v);
    }

    await db.order.update({ where: { id: order.id }, data: { arrivedAt: new Date() } });

    try {
      await pushToVendor(
        order.vendorId,
        `#${order.number} is outside 🚗`,
        `${order.vehicleColor} car${order.customerName ? ` · ${order.customerName}` : ""}${order.paidAt ? "" : " · paying inside"}`
      );
    } catch { /* they can still see it on the screen */ }

    return NextResponse.json(await view(params.token));
  });
}

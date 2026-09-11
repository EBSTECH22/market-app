import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { finalizeIfPaid } from "@/lib/preorder";

export const dynamic = "force-dynamic";

// GET: order summary (finalizes on the spot if Stripe says it's paid)
export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const po = await db.preOrder.findUnique({ where: { token: params.token } });
  if (!po) return NextResponse.json({ error: "Order not found." }, { status: 404 });
  if (po.status === "ACCEPTED" && po.stripeSessionId) await finalizeIfPaid(po.id);
  const fresh = await db.preOrder.findUnique({ where: { token: params.token } });
  const vendor = await db.vendor.findUnique({ where: { id: po.vendorId }, select: { businessName: true } });
  return NextResponse.json({
    order: {
      vendorName: vendor?.businessName || "",
      description: fresh!.description, subtotalCents: fresh!.subtotalCents,
      taxCents: fresh!.taxCents, totalCents: fresh!.totalCents,
      expectedDate: fresh!.expectedDate, status: fresh!.status,
    },
  });
}

// POST: mint a fresh Stripe Checkout session and hand back its URL
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const po = await db.preOrder.findUnique({ where: { token: params.token } });
  if (!po) return NextResponse.json({ error: "Order not found." }, { status: 404 });
  if (po.status === "PAID") return NextResponse.json({ error: "Already paid — you're all set." }, { status: 400 });
  if (po.status !== "ACCEPTED") return NextResponse.json({ error: "This order isn't payable." }, { status: 400 });
  if (!stripe) return NextResponse.json({ error: "Online payment isn't configured yet — pay at the market instead." }, { status: 500 });

  const vendor = await db.vendor.findUnique({ where: { id: po.vendorId }, select: { businessName: true } });
  const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: `Pre-order — ${vendor?.businessName || "Community Harvest"}`, description: po.description.slice(0, 250) },
          unit_amount: po.subtotalCents,
        },
        quantity: 1,
      },
      {
        price_data: {
          currency: "usd",
          product_data: { name: "Sales tax" },
          unit_amount: po.taxCents,
        },
        quantity: 1,
      },
    ],
    metadata: { app: "community-harvest-market", preorderId: po.id },
    success_url: `${base}/pay/${po.token}?done=1`,
    cancel_url: `${base}/pay/${po.token}`,
  });
  await db.preOrder.update({ where: { id: po.id }, data: { stripeSessionId: session.id } });
  return NextResponse.json({ url: session.url });
}

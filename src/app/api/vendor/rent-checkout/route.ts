import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { finalizeRentAndNotify } from "@/lib/rentfinalize";

export const dynamic = "force-dynamic";

const PROCESSING_PERCENT = 3;

// POST — pay the outstanding rent balance by card AND save that card for future autopay (one Stripe screen)
export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!stripe) return NextResponse.json({ error: "Card payments aren't configured yet." }, { status: 500 });
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const agg = await db.ledgerEntry.aggregate({ where: { vendorId }, _sum: { amountCents: true } });
  const balance = agg._sum.amountCents || 0;
  if (balance >= 0) return NextResponse.json({ error: "Nothing due — your balance is covered." }, { status: 400 });
  const dueCents = -balance;
  const feeCents = Math.round((dueCents * PROCESSING_PERCENT) / 100);

  let customerId = vendor.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: vendor.email, name: vendor.businessName, metadata: { vendorId } });
    customerId = customer.id;
    await db.vendor.update({ where: { id: vendorId }, data: { stripeCustomerId: customerId } });
  }

  const origin = req.nextUrl.origin;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [
      { price_data: { currency: "usd", product_data: { name: "Booth rent balance" }, unit_amount: dueCents }, quantity: 1 },
      { price_data: { currency: "usd", product_data: { name: `Card-processing adjustment (${PROCESSING_PERCENT}%)` }, unit_amount: feeCents }, quantity: 1 },
    ],
    payment_intent_data: {
      setup_future_usage: "off_session", // <- saves this card for future rent settlements
      description: `Rent — ${vendor.businessName} (${vendor.code})`,
      metadata: { vendorId, dueCents: String(dueCents), feeCents: String(feeCents) },
    },
    success_url: `${origin}/vendor?rent_session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/vendor`,
  });
  return NextResponse.json({ url: session.url });
}

// GET ?session_id= — confirm payment, post it to the ledger, store the saved card.
// The work lives in lib/rentfinalize so this, the invoice link, and the Stripe
// webhook all record a payment exactly the same way.
export async function GET(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const sessionId = req.nextUrl.searchParams.get("session_id") || "";
  const res = await finalizeRentAndNotify(sessionId, "portal", vendorId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ ok: true, last4: res.last4, dueCents: res.dueCents, feeCents: res.feeCents });
}

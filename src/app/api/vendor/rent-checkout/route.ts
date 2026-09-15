import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { unlockIfRentPaid } from "@/lib/unlock";

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

// GET ?session_id= — confirm payment, post it to the ledger, store the saved card
export async function GET(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!stripe) return NextResponse.json({ error: "Not configured." }, { status: 500 });
  const sessionId = req.nextUrl.searchParams.get("session_id") || "";
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
  const pi = session.payment_intent as { id: string; status: string; payment_method?: string | { id: string }; metadata?: Record<string, string> } | null;
  if (!pi || pi.status !== "succeeded") return NextResponse.json({ error: "Payment not completed." }, { status: 400 });
  if (pi.metadata?.vendorId !== vendorId) return NextResponse.json({ error: "Session mismatch." }, { status: 400 });

  const marker = `[ck ${pi.id.slice(-10)}]`;
  const already = await db.ledgerEntry.findFirst({ where: { vendorId, type: "RENT_PAYMENT", note: { contains: marker } } });

  const pmId = typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id;
  let last4 = "";
  if (pmId) {
    const pm = await stripe.paymentMethods.retrieve(pmId);
    last4 = pm.card?.last4 || "";
    await db.vendor.update({ where: { id: vendorId }, data: { stripePmId: pmId, cardLast4: last4 } });
  }

  const dueCents = Number(pi.metadata?.dueCents || 0);
  const feeCents = Number(pi.metadata?.feeCents || 0);
  if (!already && dueCents > 0) {
    await db.ledgerEntry.create({
      data: {
        vendorId, type: "RENT_PAYMENT", amountCents: dueCents,
        note: `Rent paid by card ····${last4}: $${((dueCents + feeCents) / 100).toFixed(2)} charged (includes $${(feeCents / 100).toFixed(2)} card-processing adjustment, ${PROCESSING_PERCENT}%) ${marker}`,
      },
    });
  }
  try { await unlockIfRentPaid(vendorId); } catch {}
  return NextResponse.json({ ok: true, last4, dueCents, feeCents });
}

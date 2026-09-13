import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { stripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

// POST — start a Stripe-hosted card save (setup session)
export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!stripe) return NextResponse.json({ error: "Card payments aren't configured yet." }, { status: 500 });
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let customerId = vendor.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: vendor.email, name: vendor.businessName, metadata: { vendorId } });
    customerId = customer.id;
    await db.vendor.update({ where: { id: vendorId }, data: { stripeCustomerId: customerId } });
  }
  const origin = req.nextUrl.origin;
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    payment_method_types: ["card"],
    success_url: `${origin}/vendor?card_session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/vendor`,
  });
  return NextResponse.json({ url: session.url });
}

// GET ?session_id= — confirm and store the saved card
export async function GET(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (!stripe) return NextResponse.json({ error: "Not configured." }, { status: 500 });
  const sessionId = req.nextUrl.searchParams.get("session_id") || "";
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["setup_intent"] });
  const si = session.setup_intent as { payment_method?: string | { id: string } } | null;
  const pmId = typeof si?.payment_method === "string" ? si.payment_method : si?.payment_method?.id;
  if (!pmId) return NextResponse.json({ error: "No card found on that session." }, { status: 400 });
  const pm = await stripe.paymentMethods.retrieve(pmId);
  await db.vendor.update({ where: { id: vendorId }, data: { stripePmId: pmId, cardLast4: pm.card?.last4 || "" } });
  return NextResponse.json({ ok: true, last4: pm.card?.last4 || "" });
}

// DELETE — remove the card on file (revokes authorization)
export async function DELETE() {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (vendor?.stripePmId && stripe) {
    try { await stripe.paymentMethods.detach(vendor.stripePmId); } catch {}
  }
  await db.vendor.update({ where: { id: vendorId }, data: { stripePmId: "", cardLast4: "" } });
  return NextResponse.json({ ok: true });
}

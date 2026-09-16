import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { unlockIfRentPaid } from "@/lib/unlock";
import { isAdmin } from "@/lib/auth";
import { logView } from "@/lib/viewlog";
import { pushToAdmin } from "@/lib/push";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";

const PROCESSING_PERCENT = 3;

async function vendorByToken(token: string) {
  if (!token) return null;
  const contract = await db.contract.findFirst({ where: { signToken: token }, include: { vendor: true } });
  if (!contract || !contract.vendorSignedAt || !contract.marketSignedAt) return null;
  return { contract, vendor: contract.vendor };
}

// GET ?token= — amount due breakdown; with &session_id= — confirm a completed payment
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  const found = await vendorByToken(token);
  if (!found) return NextResponse.json({ error: "Link not found." }, { status: 404 });
  const { vendor, contract } = found;

  const sessionId = req.nextUrl.searchParams.get("session_id") || "";
  if (sessionId && stripe) {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
    const pi = session.payment_intent as { id: string; status: string; payment_method?: string | { id: string }; metadata?: Record<string, string> } | null;
    if (!pi || pi.status !== "succeeded") return NextResponse.json({ error: "Payment not completed." }, { status: 400 });
    if (pi.metadata?.vendorId !== vendor.id) return NextResponse.json({ error: "Session mismatch." }, { status: 400 });
    const marker = `[ck ${pi.id.slice(-10)}]`;
    const already = await db.ledgerEntry.findFirst({ where: { vendorId: vendor.id, type: "RENT_PAYMENT", note: { contains: marker } } });
    const pmId = typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id;
    let last4 = "";
    if (pmId) {
      const pm = await stripe.paymentMethods.retrieve(pmId);
      last4 = pm.card?.last4 || "";
      await db.vendor.update({ where: { id: vendor.id }, data: { stripePmId: pmId, cardLast4: last4 } });
    }
    const dueCents = Number(pi.metadata?.dueCents || 0);
    const feeCents = Number(pi.metadata?.feeCents || 0);
    if (!already && dueCents > 0) {
      await db.ledgerEntry.create({
        data: {
          vendorId: vendor.id, type: "RENT_PAYMENT", amountCents: dueCents,
          note: `Rent paid by card ····${last4}: $${((dueCents + feeCents) / 100).toFixed(2)} charged (includes $${(feeCents / 100).toFixed(2)} card-processing adjustment, ${PROCESSING_PERCENT}%) ${marker}`,
        },
      });
    }
    try { await unlockIfRentPaid(vendor.id); } catch {}
  return NextResponse.json({ paid: true, last4, dueCents, feeCents });
  }

  const agg = await db.ledgerEntry.aggregate({ where: { vendorId: vendor.id }, _sum: { amountCents: true } });
  const balance = agg._sum.amountCents || 0;
  const dueCents = balance < 0 ? -balance : 0;
  const feeCents = Math.round((dueCents * PROCESSING_PERCENT) / 100);

  /* Record that the VENDOR opened their invoice. An admin previewing it from
     the agreements panel is not a signal about the vendor, so their view is
     neither logged nor pushed — that check is the whole reason this sits here
     rather than in the page component. */
  if (!isAdmin()) {
    try {
      const v = await logView({
        kind: "INVOICE",
        targetId: contract.id,
        vendorId: vendor.id,
        headers: req.headers,
      });
      if (v.recorded) {
        await pushToAdmin(
          v.firstEver ? "Invoice opened for the first time" : "Invoice opened again",
          `${vendor.businessName} — booth ${contract.boothLabel}${dueCents > 0 ? `, ${money(dueCents)} due` : ", paid up"}` +
            (v.totalViews > 1 ? ` · ${v.totalViews} views` : "")
        );
      }
    } catch { /* never let view tracking break the invoice */ }
  }

  return NextResponse.json({
    businessName: vendor.businessName, boothLabel: contract.boothLabel,
    dueCents, feeCents, totalCents: dueCents + feeCents, processingPercent: PROCESSING_PERCENT,
  });
}

// POST { token } — start the Stripe pay-and-save session
export async function POST(req: NextRequest) {
  if (!stripe) return NextResponse.json({ error: "Card payments aren't configured yet." }, { status: 500 });
  const { token } = await req.json();
  const found = await vendorByToken(String(token || ""));
  if (!found) return NextResponse.json({ error: "Link not found." }, { status: 404 });
  const { vendor } = found;

  const agg = await db.ledgerEntry.aggregate({ where: { vendorId: vendor.id }, _sum: { amountCents: true } });
  const balance = agg._sum.amountCents || 0;
  if (balance >= 0) return NextResponse.json({ error: "Nothing due — the balance is covered." }, { status: 400 });
  const dueCents = -balance;
  const feeCents = Math.round((dueCents * PROCESSING_PERCENT) / 100);

  let customerId = vendor.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: vendor.email, name: vendor.businessName, metadata: { vendorId: vendor.id } });
    customerId = customer.id;
    await db.vendor.update({ where: { id: vendor.id }, data: { stripeCustomerId: customerId } });
  }
  const origin = req.nextUrl.origin;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [
      { price_data: { currency: "usd", product_data: { name: `Booth rent — ${found.contract.boothLabel}` }, unit_amount: dueCents }, quantity: 1 },
      { price_data: { currency: "usd", product_data: { name: `Card-processing adjustment (${PROCESSING_PERCENT}%)` }, unit_amount: feeCents }, quantity: 1 },
    ],
    payment_intent_data: {
      setup_future_usage: "off_session",
      description: `Rent — ${vendor.businessName} (${vendor.code})`,
      metadata: { vendorId: vendor.id, dueCents: String(dueCents), feeCents: String(feeCents) },
    },
    success_url: `${origin}/rent/${token}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/rent/${token}`,
  });
  return NextResponse.json({ url: session.url });
}

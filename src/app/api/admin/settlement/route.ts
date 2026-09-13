import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { sendRentChargedEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

const PROCESSING_PERCENT = 3; // card-processing adjustment on card-charged rent, per contract

// GET — settlement view: every active-contract vendor, balance, and what's still owed
export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const contracts = await db.contract.findMany({ where: { status: "ACTIVE" }, include: { vendor: true } });
  const rows = [];
  for (const c of contracts) {
    const agg = await db.ledgerEntry.aggregate({ where: { vendorId: c.vendorId }, _sum: { amountCents: true } });
    const balance = agg._sum.amountCents || 0;
    const dueCents = balance < 0 ? -balance : 0;
    const feeCents = Math.round((dueCents * PROCESSING_PERCENT) / 100);
    rows.push({
      vendorId: c.vendorId, businessName: c.vendor.businessName, code: c.vendor.code,
      boothLabel: c.boothLabel, monthlyRentCents: c.monthlyRentCents,
      balanceCents: balance, dueCents, feeCents, chargeTotalCents: dueCents + feeCents,
      cardLast4: c.vendor.cardLast4 || "", hasCard: !!(c.vendor.stripeCustomerId && c.vendor.stripePmId),
    });
  }
  rows.sort((a, b) => b.dueCents - a.dueCents);
  return NextResponse.json({ rows, processingPercent: PROCESSING_PERCENT });
}

// POST { vendorId } — charge the card on file for the outstanding balance + 3%
export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!stripe) return NextResponse.json({ error: "Stripe isn't configured." }, { status: 500 });
  const { vendorId } = await req.json();
  const vendor = await db.vendor.findUnique({ where: { id: String(vendorId || "") } });
  if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
  if (!vendor.stripeCustomerId || !vendor.stripePmId) return NextResponse.json({ error: "No card on file — the vendor adds one in their portal (MONEY tab)." }, { status: 400 });

  const agg = await db.ledgerEntry.aggregate({ where: { vendorId: vendor.id }, _sum: { amountCents: true } });
  const balance = agg._sum.amountCents || 0;
  if (balance >= 0) return NextResponse.json({ error: "Nothing due — their balance covers rent." }, { status: 400 });
  const dueCents = -balance;
  const feeCents = Math.round((dueCents * PROCESSING_PERCENT) / 100);
  const chargeTotal = dueCents + feeCents;

  try {
    const pi = await stripe.paymentIntents.create({
      amount: chargeTotal, currency: "usd",
      customer: vendor.stripeCustomerId, payment_method: vendor.stripePmId,
      off_session: true, confirm: true,
      description: `Rent settlement — ${vendor.businessName} (${vendor.code})`,
      metadata: { vendorId: vendor.id, dueCents: String(dueCents), feeCents: String(feeCents) },
    });
    if (pi.status !== "succeeded") return NextResponse.json({ error: `Charge not completed (status: ${pi.status}).` }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Card charge failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  await db.ledgerEntry.create({
    data: {
      vendorId: vendor.id, type: "RENT_PAYMENT", amountCents: dueCents,
      note: `Rent balance paid by card on file ····${vendor.cardLast4}: $${(chargeTotal / 100).toFixed(2)} charged (includes $${(feeCents / 100).toFixed(2)} card-processing adjustment, 3%)`,
    },
  });
  try { await sendRentChargedEmail(vendor.email, vendor.businessName, dueCents, feeCents, chargeTotal, vendor.cardLast4); } catch {}
  return NextResponse.json({ ok: true, dueCents, feeCents, chargeTotalCents: chargeTotal });
}

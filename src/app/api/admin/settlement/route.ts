import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { sendRentChargedEmail } from "@/lib/email";
import { unlockIfRentPaid } from "@/lib/unlock";
import { runRoute } from "@/lib/handler";
import { TZ } from "@/lib/time";

export const dynamic = "force-dynamic";

const PROCESSING_PERCENT = 3; // card-processing adjustment on card-charged rent, per contract

// GET — settlement view: every active-contract vendor, balance, and what's still owed
export async function GET() {
  return runRoute("admin/settlement GET", async () => {
    if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // explicit vendor select — `include: { vendor: true }` would pull
    // passwordHash / stripe ids into memory next to the response builder
    const contracts = await db.contract.findMany({
      where: { status: "ACTIVE" },
      include: { vendor: { select: { businessName: true, code: true, cardLast4: true, stripeCustomerId: true, stripePmId: true } } },
    });
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
  });
}

// POST { vendorId } — charge the card on file for the outstanding balance + 3%
export async function POST(req: NextRequest) {
  return runRoute("admin/settlement POST", async () => {
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

    // A double-click used to create two PaymentIntents. Stripe de-duplicates on
    // the idempotency key, so the same vendor + same amount + same month can
    // only produce one charge (24h key lifetime on Stripe's side). Once the
    // balance changes — including after this settlement posts — the key changes
    // too, so a legitimate second settlement still goes through.
    const ym = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date());
    const idempotencyKey = `settle:${vendor.id}:${chargeTotal}:${ym}`;

    try {
      const pi = await stripe.paymentIntents.create(
        {
          amount: chargeTotal, currency: "usd",
          customer: vendor.stripeCustomerId, payment_method: vendor.stripePmId,
          off_session: true, confirm: true,
          description: `Rent settlement — ${vendor.businessName} (${vendor.code})`,
          metadata: { vendorId: vendor.id, dueCents: String(dueCents), feeCents: String(feeCents) },
        },
        { idempotencyKey }
      );
      if (pi.status !== "succeeded") return NextResponse.json({ error: `Charge not completed (status: ${pi.status}).` }, { status: 400 });
    } catch (err) {
      // Stripe messages can name internal ids and account details — log them,
      // don't hand them to the browser.
      console.error("[admin/settlement POST] stripe charge failed", { vendorId: vendor.id, chargeTotal, err });
      return NextResponse.json({ error: "That card was declined or the charge couldn't be completed. Check the card on file and try again." }, { status: 400 });
    }

    await db.ledgerEntry.create({
      data: {
        vendorId: vendor.id, type: "RENT_PAYMENT", amountCents: dueCents,
        note: `Rent balance paid by card on file ····${vendor.cardLast4}: $${(chargeTotal / 100).toFixed(2)} charged (includes $${(feeCents / 100).toFixed(2)} card-processing adjustment, 3%)`,
      },
    });
    try { await sendRentChargedEmail(vendor.email, vendor.businessName, dueCents, feeCents, chargeTotal, vendor.cardLast4); } catch {}
    try { await unlockIfRentPaid(vendor.id); } catch {}
    return NextResponse.json({ ok: true, dueCents, feeCents, chargeTotalCents: chargeTotal });
  });
}

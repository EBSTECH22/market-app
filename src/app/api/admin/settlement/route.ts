import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { stripe } from "@/lib/stripe";
import { sendRentChargedEmail } from "@/lib/email";
import { unlockIfRentPaid } from "@/lib/unlock";
import { reholdOnPayment } from "@/lib/spacehold";
import { runRoute } from "@/lib/handler";
import { TZ } from "@/lib/time";
import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const PROCESSING_PERCENT = 3; // card-processing adjustment on card-charged rent, per contract

// GET — settlement view: every active-contract vendor, balance, and what's still owed
export async function GET() {
  return runRoute("admin/settlement GET", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
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

    /* ------------------------------------------------------- rent roll --- */
    /* What the booths are contracted to bring in each month.
       Deliberately split three ways rather than given as one number, because
       "rent I have in contracts" is three different amounts depending on how
       honest you want to be:
         - COMMITTED: signed by both sides. Money you can actually count on.
         - AWAITING SIGNATURE: an agreement is out but nobody has signed it.
           Rent doesn't post until execution, so counting this as income is how
           a month's budget ends up short.
         - ENDING: under notice with an end date. Still coming in now, gone soon.
       A single total would quietly fold the second into the first. */
    const rollContracts = await db.contract.findMany({
      where: { status: { in: ["ACTIVE", "TERMINATING"] } },
      select: {
        id: true, boothLabel: true, monthlyRentCents: true, status: true, endDate: true,
        vendorSignedAt: true, marketSignedAt: true,
        vendor: { select: { businessName: true, code: true } },
      },
      orderBy: { boothLabel: "asc" },
    });

    const executed = rollContracts.filter((c) => c.vendorSignedAt && c.marketSignedAt);
    const pending = rollContracts.filter((c) => !(c.vendorSignedAt && c.marketSignedAt));
    const ending = executed.filter((c) => c.status === "TERMINATING" && c.endDate);

    const sum = (list: { monthlyRentCents: number }[]) => list.reduce((n, c) => n + c.monthlyRentCents, 0);

    const rentRoll = {
      committedMonthlyCents: sum(executed),
      committedBooths: executed.length,
      pendingMonthlyCents: sum(pending),
      pendingBooths: pending.length,
      endingMonthlyCents: sum(ending),
      endingBooths: ending.length,
      /* What it becomes once the leavers are gone and nothing replaces them —
         the number worth looking at before deciding you can afford something. */
      afterEndingMonthlyCents: sum(executed) - sum(ending),
      booths: rollContracts.map((c) => ({
        contractId: c.id,
        boothLabel: c.boothLabel,
        businessName: c.vendor.businessName,
        code: c.vendor.code,
        monthlyRentCents: c.monthlyRentCents,
        signed: !!(c.vendorSignedAt && c.marketSignedAt),
        endDate: c.endDate,
        status: c.status,
      })),
    };

    return NextResponse.json({ rows, processingPercent: PROCESSING_PERCENT, rentRoll });
  });
}

// POST { vendorId } — charge the card on file for the outstanding balance + 3%
export async function POST(req: NextRequest) {
  return runRoute("admin/settlement POST", async () => {
    // Charging a card on file is money moving, not just reading the books.
    { const denied = await denyUnless("money"); if (denied) return denied; }
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

    // Hoisted: the ledger note below stamps this id, and the intent itself is
    // created inside the try.
    let paymentIntentId = "";
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
      paymentIntentId = pi.id;
    } catch (err) {
      // Stripe messages can name internal ids and account details — log them,
      // don't hand them to the browser.
      console.error("[admin/settlement POST] stripe charge failed", { vendorId: vendor.id, chargeTotal, err });
      return NextResponse.json({ error: "That card was declined or the charge couldn't be completed. Check the card on file and try again." }, { status: 400 });
    }

    await db.ledgerEntry.create({
      data: {
        vendorId: vendor.id, type: "RENT_PAYMENT", amountCents: dueCents,
        /* The PaymentIntent id is stamped in the note the same way the vendor's
           own payment path does it. That marker is what lets the Stripe
           reconciler tell a payment that's already in the books from one that
           never made it — without it, this entry looks like a missing payment
           and gets offered for posting a second time. */
        note: `Rent balance paid by card on file ····${vendor.cardLast4}: $${(chargeTotal / 100).toFixed(2)} charged (includes $${(feeCents / 100).toFixed(2)} card-processing adjustment, 3%) [ck ${paymentIntentId.slice(-10)}]`,
      },
    });
    await recordAudit(
      {
        action: "VENDOR_LEDGER",
        targetType: "VENDOR",
        targetId: vendor.id,
        targetLabel: `${vendor.code} — ${vendor.businessName}`,
        /* Negative: this is money coming IN, and the log's running total is
           about what left the building. */
        amountCents: -chargeTotal,
        detail: `Card on file ····${vendor.cardLast4} charged $${(chargeTotal / 100).toFixed(2)} for rent owed`,
        after: { dueCents, feeCents, chargeTotal },
      },
      req
    );
    try { await sendRentChargedEmail(vendor.email, vendor.businessName, dueCents, feeCents, chargeTotal, vendor.cardLast4); } catch {}
    try { await unlockIfRentPaid(vendor.id); } catch {}
    try { await reholdOnPayment(vendor.id); } catch {}
    return NextResponse.json({ ok: true, dueCents, feeCents, chargeTotalCents: chargeTotal });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { stripe } from "@/lib/stripe";
import { onboardingLink, refreshAccountStatus, getPayoutFee, feeFor } from "@/lib/payouts";

export const dynamic = "force-dynamic";

/**
 * The vendor's side of getting paid: connect a bank account, see where it
 * stands, and know what will land.
 *
 * All of the sensitive part happens on Stripe's own hosted form. This app never
 * sees a bank account number, an SSN or a photo ID — it sends the vendor to
 * Stripe and gets back a yes or a no. That is the entire reason for using
 * Express accounts rather than collecting bank details directly.
 */

export async function GET() {
  return runRoute("vendor/payout-account GET", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
    if (!stripe) return NextResponse.json({ error: "Payments aren't configured." }, { status: 500 });

    const status = await refreshAccountStatus(vendorId);

    const agg = await db.ledgerEntry.aggregate({ where: { vendorId }, _sum: { amountCents: true } });
    const balance = agg._sum.amountCents || 0;
    const owedCents = balance > 0 ? balance : 0;

    const fee = await getPayoutFee();
    const { feeCents, sendableCents } = feeFor(owedCents, fee);

    return NextResponse.json({
      ...status,
      owedCents,
      feeCents,
      sendableCents,
      feePercent: fee.percent,
      feeFixedCents: fee.fixedCents,
    });
  });
}

// POST — start (or resume) Stripe's onboarding and hand back the link
export async function POST(req: NextRequest) {
  return runRoute("vendor/payout-account POST", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
    if (!stripe) return NextResponse.json({ error: "Payments aren't configured." }, { status: 500 });

    /* Links are single-use and expire within minutes, so one is minted per
       click rather than stored. A vendor who abandons the form halfway and
       comes back tomorrow gets a fresh link that resumes where they left off —
       Stripe keeps the partial answers against the account. */
    const origin = req.nextUrl.origin;
    try {
      const url = await onboardingLink(vendorId, origin);
      return NextResponse.json({ url });
    } catch (err) {
      console.error("[vendor/payout-account] couldn't create the onboarding link", err);
      return NextResponse.json(
        { error: "Couldn't start the bank setup just now. Try again in a minute." },
        { status: 502 }
      );
    }
  });
}

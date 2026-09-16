import { NextResponse } from "next/server";

import { stripe } from "@/lib/stripe";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

export async function GET() {
  { const denied = await denyUnless("financials"); if (denied) return denied; }
  if (!stripe) return NextResponse.json({ configured: false });
  try {
    const [balance, payouts] = await Promise.all([
      stripe.balance.retrieve(),
      stripe.payouts.list({ limit: 10 }),
    ]);
    const sum = (arr: { amount: number; currency: string }[]) =>
      arr.filter((a) => a.currency === "usd").reduce((n, a) => n + a.amount, 0);
    return NextResponse.json({
      configured: true,
      available: sum(balance.available),
      pending: sum(balance.pending),
      payouts: payouts.data.map((p) => ({
        id: p.id, amount: p.amount, status: p.status,
        arrival: new Date(p.arrival_date * 1000).toISOString(),
      })),
    });
  } catch (err) {
    console.error("stripe fetch failed", err);
    return NextResponse.json({ configured: true, error: "Stripe fetch failed — check STRIPE_SECRET_KEY." }, { status: 500 });
  }
}

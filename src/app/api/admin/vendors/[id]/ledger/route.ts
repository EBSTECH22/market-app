import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reholdOnPayment } from "@/lib/spacehold";

import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  { const denied = await denyUnless("money"); if (denied) return denied; }
  const entries = await db.ledgerEntry.findMany({
    where: { vendorId: params.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const balance = (await db.ledgerEntry.aggregate({ where: { vendorId: params.id }, _sum: { amountCents: true } }))._sum.amountCents || 0;
  return NextResponse.json({ entries, balance });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  { const denied = await denyUnless("money"); if (denied) return denied; }
  const { type, amountDollars, note } = await req.json();
  /* RENT_PAYMENT is how rent paid in cash, by check or by bank transfer gets
     recorded. Before this existed the only options were RENT (another charge),
     PAYOUT (money out) and ADJUST — so a vendor who handed over cash was
     booked as an adjustment, which zeroes their balance without ever counting
     as a payment. Their invoice then sat there saying unpaid, because as far
     as the books were concerned it was. */
  if (!["RENT", "RENT_PAYMENT", "PAYOUT", "ADJUST"].includes(type)) {
    return NextResponse.json({ error: "Invalid entry type." }, { status: 400 });
  }
  const raw = Math.round(Number(amountDollars) * 100);
  if (!raw || Number.isNaN(raw)) return NextResponse.json({ error: "Enter a valid amount." }, { status: 400 });

  // RENT and PAYOUT reduce the vendor's balance, RENT_PAYMENT credits it, and
  // ADJUST uses the sign as entered.
  const amountCents =
    type === "ADJUST" ? raw
    : type === "RENT_PAYMENT" ? Math.abs(raw)
    : -Math.abs(raw);

  const entry = await db.ledgerEntry.create({
    data: { vendorId: params.id, type, amountCents, note: (note || "").trim() },
  });

  const vendor = await db.vendor.findUnique({ where: { id: params.id }, select: { code: true, businessName: true } });
  await recordAudit(
    {
      action: "VENDOR_LEDGER",
      targetType: "VENDOR",
      targetId: params.id,
      targetLabel: vendor ? `${vendor.code} — ${vendor.businessName}` : params.id,
      /* Signed so the log reads as money out. A payout or a negative adjustment
         is money leaving; rent charged is money owed TO the market, so it lands
         negative and doesn't inflate the "handed back" total. */
      amountCents: -amountCents,
      detail: `${type === "ADJUST" ? "Balance adjusted" : type === "PAYOUT" ? "Payout recorded" : type === "RENT_PAYMENT" ? "Rent payment recorded" : "Rent charged"}: ${(Math.abs(amountCents) / 100).toFixed(2)}${(note || "").trim() ? ` — ${(note || "").trim()}` : ""}`,
      after: { type, amountCents },
    },
    req
  );

  /* Cash or a check settles the same debt a card would, so it takes the space
     back the same way. */
  try { await reholdOnPayment(params.id); } catch {}

  return NextResponse.json({ entry });
}

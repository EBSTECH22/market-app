import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entries = await db.ledgerEntry.findMany({
    where: { vendorId: params.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const balance = (await db.ledgerEntry.aggregate({ where: { vendorId: params.id }, _sum: { amountCents: true } }))._sum.amountCents || 0;
  return NextResponse.json({ entries, balance });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { type, amountDollars, note } = await req.json();
  if (!["RENT", "PAYOUT", "ADJUST"].includes(type)) {
    return NextResponse.json({ error: "Invalid entry type." }, { status: 400 });
  }
  const raw = Math.round(Number(amountDollars) * 100);
  if (!raw || Number.isNaN(raw)) return NextResponse.json({ error: "Enter a valid amount." }, { status: 400 });

  // RENT and PAYOUT reduce the vendor's balance; ADJUST uses the sign as entered
  const amountCents = type === "ADJUST" ? raw : -Math.abs(raw);

  const entry = await db.ledgerEntry.create({
    data: { vendorId: params.id, type, amountCents, note: (note || "").trim() },
  });
  return NextResponse.json({ entry });
}

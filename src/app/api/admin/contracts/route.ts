import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { centralInputToDate } from "@/lib/time";
// Shared with the applications pipeline so both screens report identically.
import { deliveryFor } from "@/lib/agreement";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const contracts = await db.contract.findMany({
    include: { vendor: { select: { businessName: true, code: true, cardLast4: true } } },
    orderBy: { createdAt: "desc" },
  });
  const balances = await db.ledgerEntry.groupBy({ by: ["vendorId"], _sum: { amountCents: true } });
  const balMap = Object.fromEntries(balances.map((b) => [b.vendorId, b._sum.amountCents || 0]));
  return NextResponse.json({
    contracts: contracts.map((c) => ({
      ...c,
      vendorBalanceCents: balMap[c.vendorId] || 0,
      delivery: deliveryFor(c),
    })),
  });
}

export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { vendorId, boothLabel, monthlyRentDollars, startDate } = await req.json();
  const rent = Math.round(Number(monthlyRentDollars) * 100);
  if (!vendorId || !boothLabel?.trim() || !startDate) {
    return NextResponse.json({ error: "Vendor, booth, and start date are required." }, { status: 400 });
  }
  if (Number.isNaN(rent) || rent < 0) return NextResponse.json({ error: "Enter a valid rent (0 is allowed)." }, { status: 400 });

  const start = centralInputToDate(`${startDate}T00:00`);
  const [y, m, d] = startDate.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const firstMonthCents = Math.round((rent * (daysInMonth - d + 1)) / daysInMonth);

  const contract = await db.contract.create({
    data: {
      vendorId,
      boothLabel: boothLabel.trim(),
      monthlyRentCents: rent,
      startDate: start,
    },
  });
  // first month's rent posts automatically when the contract is FULLY EXECUTED (both signatures) — not at creation
  return NextResponse.json({ contract, firstMonthCents });
}

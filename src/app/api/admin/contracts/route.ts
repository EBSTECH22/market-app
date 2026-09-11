import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { centralInputToDate } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const contracts = await db.contract.findMany({
    include: { vendor: { select: { businessName: true, code: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ contracts });
}

export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { vendorId, boothLabel, monthlyRentDollars, startDate } = await req.json();
  const rent = Math.round(Number(monthlyRentDollars) * 100);
  if (!vendorId || !boothLabel?.trim() || !startDate) {
    return NextResponse.json({ error: "Vendor, booth, and start date are required." }, { status: 400 });
  }
  if (Number.isNaN(rent) || rent < 0) return NextResponse.json({ error: "Enter a valid rent (0 is allowed)." }, { status: 400 });

  const contract = await db.contract.create({
    data: {
      vendorId,
      boothLabel: boothLabel.trim(),
      monthlyRentCents: rent,
      startDate: centralInputToDate(`${startDate}T00:00`),
    },
  });
  return NextResponse.json({ contract });
}

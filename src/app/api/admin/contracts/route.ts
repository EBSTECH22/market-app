import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { centralInputToDate } from "@/lib/time";
// Shared with the applications pipeline so both screens report identically.
import { deliveryFor } from "@/lib/agreement";
import { viewTrackingSince } from "@/lib/viewlog";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

export async function GET() {
  { const denied = await denyUnless("market"); if (denied) return denied; }
  const contracts = await db.contract.findMany({
    include: { vendor: { select: { businessName: true, code: true, cardLast4: true } } },
    orderBy: { createdAt: "desc" },
  });
  const balances = await db.ledgerEntry.groupBy({ by: ["vendorId"], _sum: { amountCents: true } });
  const balMap = Object.fromEntries(balances.map((b) => [b.vendorId, b._sum.amountCents || 0]));

  /* How often each vendor has opened their invoice. One grouped query rather
     than a lookup per row. Admin previews are never logged, so these counts
     are the vendor's own opens. */
  const views = await db.viewEvent.groupBy({
    by: ["targetId"],
    where: { kind: "INVOICE" },
    _count: { _all: true },
    _max: { viewedAt: true },
  });
  const viewMap = Object.fromEntries(
    views.map((v) => [v.targetId, { count: v._count._all, lastAt: v._max.viewedAt }])
  );

  /* Anything executed before this has no view history because nothing was
     recording yet — "not opened" would be a lie about those. */
  const trackingSince = await viewTrackingSince();

  return NextResponse.json({
    trackingSince,
    contracts: contracts.map((c) => {
      const executedAt =
        c.vendorSignedAt && c.marketSignedAt
          ? new Date(Math.max(new Date(c.vendorSignedAt).getTime(), new Date(c.marketSignedAt).getTime()))
          : null;
      return {
        ...c,
        vendorBalanceCents: balMap[c.vendorId] || 0,
        delivery: deliveryFor(c),
        invoiceViews: {
          ...(viewMap[c.id] ?? { count: 0, lastAt: null }),
          // false when their invoice predates tracking and we saw nothing
          tracked: !!executedAt && executedAt >= trackingSince,
        },
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  { const denied = await denyUnless("market"); if (denied) return denied; }
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

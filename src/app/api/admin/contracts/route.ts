import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { centralInputToDate } from "@/lib/time";

export const dynamic = "force-dynamic";

/* Kept local rather than exported: Next type-checks the export surface of a
   route module, so shared types belong in src/lib if another file ever needs
   them. Nothing imports these today. */
type DeliveryState = "DRAFT" | "SENT" | "OPENED" | "SIGNED" | "EXECUTED";

type Delivery = {
  state: DeliveryState;
  sentAt: Date | null;
  viewedAt: Date | null;
  daysSinceSent: number | null;
  daysSinceOpened: number | null;
  stale: boolean;
};

const DAY_MS = 86_400_000;
/** A sent-but-unsigned agreement counts as "sitting" after this many days. */
const STALE_DAYS = 7;

const wholeDaysSince = (d: Date | null): number | null =>
  d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY_MS)) : null;

/**
 * Derive the delivery status of one agreement so the UI never has to re-derive
 * it. Ladder, highest first: both signatures = EXECUTED, vendor signature =
 * SIGNED, a viewedAt stamp = OPENED, a signToken = SENT, otherwise DRAFT.
 *
 * EXECUTED needs BOTH signatures, matching the rest of the app (the admin
 * agreements table and /api/admin/vendors both define executed that way). The
 * market can countersign first, and such a contract deliberately reports
 * OPENED/SENT rather than SIGNED — these five states describe where the VENDOR
 * is, and a market-only signature still leaves the owner waiting on them.
 *
 * CAVEAT — `sentAt` is `createdAt`, NOT a true send timestamp. There is no
 * sent-at column on Contract and we are not adding one. Today the signing
 * email goes out in the same request that creates the contract, so the two are
 * within seconds of each other; but a contract created now and sent days later
 * (e.g. the token is issued in a later edit) will under-report its age here,
 * making "Sent 5 days ago" and `stale` read older than the vendor's reality.
 * Treat sentAt/daysSinceSent as "age of the agreement", not "age of the email".
 */
function deliveryFor(c: {
  signToken: string;
  viewedAt: Date | null;
  vendorSignedAt: Date | null;
  marketSignedAt: Date | null;
  createdAt: Date;
}): Delivery {
  const sent = c.signToken ? c.createdAt : null;
  const state: DeliveryState =
    c.marketSignedAt && c.vendorSignedAt ? "EXECUTED"
    : c.vendorSignedAt ? "SIGNED"
    : c.viewedAt ? "OPENED"
    : sent ? "SENT"
    : "DRAFT";

  const daysSinceSent = wholeDaysSince(sent);

  return {
    state,
    sentAt: sent,
    viewedAt: c.viewedAt ?? null,
    daysSinceSent,
    daysSinceOpened: wholeDaysSince(c.viewedAt ?? null),
    // Only chases the states where the owner is still waiting on the vendor.
    stale:
      (state === "SENT" || state === "OPENED") &&
      daysSinceSent !== null &&
      daysSinceSent >= STALE_DAYS,
  };
}

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

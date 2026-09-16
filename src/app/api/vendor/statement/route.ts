import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { TZ } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * A vendor's year, in the shape an accountant asks for it.
 *
 * Gross sales, commission withheld, rent paid, payouts taken, net. Month by
 * month and as a total. Every vendor in every market does this with a shoebox
 * in January; the numbers are already sitting in the ledger, so there is no
 * reason they should.
 *
 * WHAT THIS IS NOT: tax advice, and not a 1099. It's a statement of what moved
 * through this market's books for one vendor, which is the input to their
 * return — not the return.
 *
 * Built from the LEDGER rather than from sale lines, because the ledger is what
 * the market actually settled with them. Sale lines would show gross takings
 * including things that were later refunded or adjusted, and a statement that
 * disagrees with the balance they were paid is worse than none.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function centralYearMonth(d: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).formatToParts(d);
  return {
    year: Number(parts.find((p) => p.type === "year")?.value ?? 0),
    month: Number(parts.find((p) => p.type === "month")?.value ?? 1) - 1,
  };
}

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(req: NextRequest) {
  return runRoute("vendor/statement GET", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

    const vendor = await db.vendor.findUnique({
      where: { id: vendorId },
      select: { businessName: true, code: true, contactName: true, commissionPercent: true },
    });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });

    const nowYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric" }).format(new Date()));
    const yearRaw = Number(req.nextUrl.searchParams.get("year"));
    const year = Number.isFinite(yearRaw) && yearRaw >= 2000 && yearRaw <= nowYear ? yearRaw : nowYear;

    /* A generous window either side, then filtered by CENTRAL year. A sale at
       6pm on 31 December is stored as the 1st of January in UTC, and a
       statement that moves someone's December takings into the next tax year is
       exactly the kind of quiet wrongness that costs them later. */
    const from = new Date(Date.UTC(year - 1, 11, 25));
    const to = new Date(Date.UTC(year + 1, 0, 7));

    const entries = await db.ledgerEntry.findMany({
      where: { vendorId, createdAt: { gte: from, lte: to } },
      select: { type: true, amountCents: true, note: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    type Row = { month: number; salesCents: number; rentCents: number; payoutCents: number; adjustmentCents: number; netCents: number };
    const rows: Row[] = MONTHS.map((_, month) => ({ month, salesCents: 0, rentCents: 0, payoutCents: 0, adjustmentCents: 0, netCents: 0 }));

    let commissionCents = 0;
    for (const e of entries) {
      const { year: y, month } = centralYearMonth(e.createdAt);
      if (y !== year) continue;
      const r = rows[month];
      /* Ledger sign convention: credits to the vendor are positive, what they
         owe is negative. Flipped here so a statement reads the way a person
         expects — money in as a positive number, money out as a cost. */
      switch (e.type) {
        case "SALE": r.salesCents += e.amountCents; break;
        case "REFUND": r.salesCents += e.amountCents; break;
        case "RENT": r.rentCents += -e.amountCents; break;
        case "RENT_PAYMENT": r.rentCents += -e.amountCents; break;
        case "PAYOUT": r.payoutCents += -e.amountCents; break;
        default: r.adjustmentCents += e.amountCents; break;
      }
      r.netCents += e.amountCents;
    }

    // Commission is the difference between shelf price and what was credited.
    const lines = await db.saleLine.findMany({
      where: { vendorId, sale: { status: { not: "VOIDED" }, createdAt: { gte: from, lte: to } } },
      select: { commissionCents: true, quantity: true, priceCents: true, sale: { select: { createdAt: true } } },
    });
    let grossShelfCents = 0;
    for (const l of lines) {
      if (!l.sale) continue;
      if (centralYearMonth(l.sale.createdAt).year !== year) continue;
      commissionCents += l.commissionCents;
      grossShelfCents += l.priceCents * l.quantity;
    }

    const totals = {
      grossShelfCents,
      commissionCents,
      salesCreditedCents: rows.reduce((n, r) => n + r.salesCents, 0),
      rentCents: rows.reduce((n, r) => n + r.rentCents, 0),
      payoutCents: rows.reduce((n, r) => n + r.payoutCents, 0),
      adjustmentCents: rows.reduce((n, r) => n + r.adjustmentCents, 0),
      netCents: rows.reduce((n, r) => n + r.netCents, 0),
    };

    const years: number[] = [];
    for (let y = nowYear; y >= nowYear - 5; y--) years.push(y);

    if (req.nextUrl.searchParams.get("format") === "csv") {
      const money = (c: number) => (c / 100).toFixed(2);
      const out = [
        [`${vendor.businessName} (${vendor.code}) — ${year} statement`],
        ["Generated", new Date().toLocaleString("en-US", { timeZone: TZ })],
        ["Note", "Summary of activity through Community Harvest. Not tax advice and not a 1099."],
        [],
        ["Month", "Sales credited", "Rent", "Payouts taken", "Adjustments", "Net change"],
        ...rows.map((r) => [
          MONTHS[r.month], money(r.salesCents), money(r.rentCents), money(r.payoutCents), money(r.adjustmentCents), money(r.netCents),
        ]),
        [],
        ["Gross shelf price of goods sold", money(grossShelfCents)],
        ["Market commission withheld", money(commissionCents)],
        ["Sales credited to you", money(totals.salesCreditedCents)],
        ["Rent charged", money(totals.rentCents)],
        ["Payouts taken", money(totals.payoutCents)],
        ["Adjustments", money(totals.adjustmentCents)],
        ["Net change in your balance", money(totals.netCents)],
      ]
        .map((line) => line.map(csvCell).join(","))
        .join("\n");

      return new NextResponse(out, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${vendor.code}-${year}-statement.csv"`,
        },
      });
    }

    return NextResponse.json({
      vendor: { businessName: vendor.businessName, code: vendor.code, contactName: vendor.contactName, commissionPercent: vendor.commissionPercent },
      year,
      years,
      months: rows.map((r) => ({ ...r, name: MONTHS[r.month] })),
      totals,
    });
  });
}

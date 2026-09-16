import { NextResponse } from "next/server";
import { db } from "@/lib/db";

import { runRoute } from "@/lib/handler";
import { viewTrackingSince } from "@/lib/viewlog";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

/**
 * Who has paid their invoice and who hasn't.
 *
 * WHAT COUNTS AS "INVOICED": an agreement signed by both sides, with at least
 * one rent charge posted. That pairing is not arbitrary — executing an
 * agreement is what posts the first month's rent AND emails the pay link, so
 * those are exactly the people who have been sent something to pay. A vendor
 * whose agreement is still unsigned has no invoice and does not belong here;
 * rent only posts on execution.
 *
 * WHAT COUNTS AS "STILL OWED": the vendor's whole ledger balance, not just
 * their rent. This is deliberate. The invoice page at /rent/<token> shows
 * `-balance`, so anything else here would let this table and the vendor's own
 * invoice disagree about what they owe — and the vendor's copy is the one
 * they'll quote at you. Sales credits, payouts and manual adjustments all move
 * that number, which is why "rent charged" and "rent paid" are shown as their
 * own columns rather than being subtracted from each other.
 */
export async function GET() {
  return runRoute("admin/rent-ledger GET", async () => {
    { const denied = await denyUnless("collections"); if (denied) return denied; }

    const contracts = await db.contract.findMany({
      where: { vendorSignedAt: { not: null }, marketSignedAt: { not: null } },
      // Explicit select: `include: { vendor: true }` would pull passwordHash and
      // the Stripe ids into the same object we're about to serialise.
      include: {
        vendor: {
          select: { id: true, code: true, businessName: true, email: true, phone: true, cardLast4: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    if (contracts.length === 0) {
      return NextResponse.json({
        invoices: [], neverPaid: [],
        totals: { invoicedCents: 0, collectedCents: 0, outstandingCents: 0, unpaidCount: 0, neverPaidCount: 0 },
        trackingSince: (await viewTrackingSince()).toISOString(),
      });
    }

    const vendorIds = [...new Set(contracts.map((c) => c.vendorId))];

    /* One grouped query rather than three per vendor. With every vendor in the
       market executing an agreement, the per-vendor version was going to be
       ~4 round trips each on a page that reloads whenever you open the tab. */
    const sums = await db.ledgerEntry.groupBy({
      by: ["vendorId", "type"],
      where: { vendorId: { in: vendorIds } },
      _sum: { amountCents: true },
      _max: { createdAt: true },
      _count: { _all: true },
    });

    type Agg = { sum: number; last: Date | null; count: number };
    const byVendor = new Map<string, Map<string, Agg>>();
    for (const row of sums) {
      const forVendor = byVendor.get(row.vendorId) ?? new Map<string, Agg>();
      forVendor.set(row.type, {
        sum: row._sum.amountCents || 0,
        last: row._max.createdAt ?? null,
        count: row._count._all,
      });
      byVendor.set(row.vendorId, forVendor);
    }

    // Invoice opens, keyed by contract id — the same targetId logView records.
    const opens = await db.viewEvent.groupBy({
      by: ["targetId"],
      where: { kind: "INVOICE", targetId: { in: contracts.map((c) => c.id) } },
      _count: { _all: true },
      _max: { viewedAt: true },
    });
    /* Explicit generics on purpose. `new Map(arr.map(...))` infers the value as
       `{}` rather than the object literal's shape, which typechecks here and
       then fails the production build on the first property access. */
    const openMap = new Map<string, { count: number; lastAt: Date | null }>(
      opens.map((o) => [o.targetId, { count: o._count._all, lastAt: o._max.viewedAt ?? null }] as [string, { count: number; lastAt: Date | null }])
    );

    const trackingSince = await viewTrackingSince();

    const invoices = contracts.map((c) => {
      const agg = byVendor.get(c.vendorId) ?? new Map<string, Agg>();
      const rent = agg.get("RENT");
      const payment = agg.get("RENT_PAYMENT");

      // RENT entries are stored negative (a debit). Flip for display.
      const chargedCents = Math.abs(rent?.sum ?? 0);
      const paidCents = payment?.sum ?? 0;
      const paymentCount = payment?.count ?? 0;

      const balanceCents = [...agg.values()].reduce((n, a) => n + a.sum, 0);
      const outstandingCents = balanceCents < 0 ? -balanceCents : 0;

      const executedAt =
        c.vendorSignedAt && c.marketSignedAt
          ? (c.vendorSignedAt > c.marketSignedAt ? c.vendorSignedAt : c.marketSignedAt)
          : null;

      const open = openMap.get(c.id);
      /* An invoice sent before view tracking existed has no answer, and saying
         "not opened" about it would be a straight lie. Say we weren't watching
         instead. */
      const openTracked = !!executedAt && executedAt >= trackingSince;

      return {
        contractId: c.id,
        vendorId: c.vendorId,
        code: c.vendor.code,
        businessName: c.vendor.businessName,
        email: c.vendor.email,
        phone: c.vendor.phone,
        boothLabel: c.boothLabel,
        signToken: c.signToken || "",
        monthlyRentCents: c.monthlyRentCents,
        contractStatus: c.status,
        executedAt,
        chargedCents,
        paidCents,
        paymentCount,
        balanceCents,
        outstandingCents,
        status: outstandingCents === 0 ? "PAID" : paymentCount > 0 ? "PARTIAL" : "UNPAID",
        lastPaymentAt: payment?.last ?? null,
        cardLast4: c.vendor.cardLast4 || "",
        opens: { count: open?.count ?? 0, lastAt: open?.lastAt ?? null, tracked: openTracked },
      };
    });

    /* Anyone who has been invoiced and has never sent a single payment. Kept as
       its own list because it is a different question from "who owes money":
       a vendor can owe this month while having paid faithfully for six, and a
       vendor who has never paid anything is the one who quietly slips through a
       season. Ended and withdrawn agreements are excluded — chasing someone who
       already left is noise. */
    const neverPaid = invoices
      .filter((i) => i.paymentCount === 0 && i.contractStatus !== "ENDED" && i.contractStatus !== "WITHDRAWN")
      .sort((a, b) => (a.executedAt?.getTime() ?? 0) - (b.executedAt?.getTime() ?? 0));

    const totals = {
      invoicedCents: invoices.reduce((n, i) => n + i.chargedCents, 0),
      collectedCents: invoices.reduce((n, i) => n + i.paidCents, 0),
      outstandingCents: invoices.reduce((n, i) => n + i.outstandingCents, 0),
      unpaidCount: invoices.filter((i) => i.outstandingCents > 0).length,
      neverPaidCount: neverPaid.length,
    };

    invoices.sort((a, b) => b.outstandingCents - a.outstandingCents);

    return NextResponse.json({
      invoices,
      neverPaid,
      totals,
      trackingSince: trackingSince.toISOString(),
    });
  });
}

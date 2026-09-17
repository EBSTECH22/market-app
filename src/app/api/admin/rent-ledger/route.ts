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
 *
 * WHAT THE BADGE MEANS, and why it is NOT the same question. The badge used to
 * be driven by that whole-account balance, which made it lie in both
 * directions: a vendor who paid their invoice in full went back to "Unpaid" the
 * moment anything else moved their balance — a payout, a manual adjustment, or
 * simply next month's rent posting — and a vendor who had never paid a cent
 * showed "Paid" as soon as their sales credits happened to cover the account.
 *
 * So the badge is now answered from RENT CHARGED vs RENT PAID alone, which is
 * the question being asked: have they paid their rent? The account balance
 * keeps its own column. The one case where the two disagree honestly — rent
 * unpaid but the account square because their sales cover it — gets its own
 * state (COVERED) rather than being flattened into either answer.
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
        totals: { invoicedCents: 0, collectedCents: 0, outstandingCents: 0, rentDueCents: 0, unpaidCount: 0, neverPaidCount: 0 },
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

    /* A vendor renting two booths has two executed agreements and ONE ledger.
       Every figure below is account-wide, so showing it on both rows and then
       adding the rows up counted that vendor's rent twice in the totals. The
       rows still appear (booths are how the market thinks), but the totals are
       summed over vendors, and a shared account says so on the row. */
    const contractsPerVendor = new Map<string, number>();
    for (const c of contracts) contractsPerVendor.set(c.vendorId, (contractsPerVendor.get(c.vendorId) || 0) + 1);

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

      /* Rent only. Nothing else on the account can move this number, which is
         the entire point: paying an invoice makes it say Paid and it stays
         that way until the next month's rent is charged. */
      const rentDueCents = Math.max(0, chargedCents - paidCents);

      /* When rent is unpaid but the account is square, WHAT squared it matters.
         A vendor whose sales credits cover the rent is a different
         conversation from one whose balance was written off by hand, and
         labelling both "covered by sales" would be a guess presented as a
         fact. */
      const adjustCents = agg.get("ADJUST")?.sum ?? 0;
      const salesCreditCents = agg.get("SALE")?.sum ?? 0;

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
        rentDueCents,
        boothsOnAccount: contractsPerVendor.get(c.vendorId) || 1,
        coveredBy: adjustCents > 0 && adjustCents >= salesCreditCents ? "ADJUSTMENT" : "SALES",
        /* Order matters here:
             NOT_INVOICED — executed, but no rent has posted yet. Saying
               "Unpaid" about a bill nobody has been sent is how a brand new
               vendor ends up on a chase list on day one.
             PAID         — rent charged has been covered by rent payments.
             COVERED      — rent is still outstanding but the account is square,
               because their sales credits or a write-off cover it. Nothing is
               owed and nothing should be chased, but they didn't pay it, and
               calling that "Paid" is what hid the freeloaders.
             PARTIAL      — some rent paid, some still due.
             UNPAID       — charged, nothing paid, money still owed. */
        status:
          chargedCents === 0 ? "NOT_INVOICED"
          : rentDueCents === 0 ? "PAID"
          : outstandingCents === 0 ? "COVERED"
          : paymentCount > 0 ? "PARTIAL"
          : "UNPAID",
        lastPaymentAt: payment?.last ?? null,
        lastChargeAt: rent?.last ?? null,
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
      .filter((i) => i.paymentCount === 0 && i.chargedCents > 0 && i.contractStatus !== "ENDED" && i.contractStatus !== "WITHDRAWN")
      .sort((a, b) => (a.executedAt?.getTime() ?? 0) - (b.executedAt?.getTime() ?? 0));

    /* Summed over VENDORS, not rows. Two booths on one account share one
       ledger, so adding the rows up billed that vendor twice. */
    const seenVendors = new Set<string>();
    const perVendor = invoices.filter((i) => {
      if (seenVendors.has(i.vendorId)) return false;
      seenVendors.add(i.vendorId);
      return true;
    });

    const totals = {
      invoicedCents: perVendor.reduce((n, i) => n + i.chargedCents, 0),
      collectedCents: perVendor.reduce((n, i) => n + i.paidCents, 0),
      outstandingCents: perVendor.reduce((n, i) => n + i.outstandingCents, 0),
      rentDueCents: perVendor.reduce((n, i) => n + i.rentDueCents, 0),
      unpaidCount: perVendor.filter((i) => i.rentDueCents > 0 && i.outstandingCents > 0).length,
      neverPaidCount: new Set(neverPaid.map((i) => i.vendorId)).size,
    };

    /* Whoever owes the most rent first; the account balance breaks ties, so a
       vendor whose rent is covered by sales drops below one who actually owes
       money rather than sitting at the top of a chase list. */
    invoices.sort((a, b) => b.rentDueCents - a.rentDueCents || b.outstandingCents - a.outstandingCents);

    return NextResponse.json({
      invoices,
      neverPaid,
      totals,
      trackingSince: trackingSince.toISOString(),
    });
  });
}

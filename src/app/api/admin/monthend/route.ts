import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { denyUnless } from "@/lib/perm";
import { runRoute } from "@/lib/handler";
import { recordAudit } from "@/lib/audit";
import { centralInputToDate } from "@/lib/time";
import {
  closureCreditCents, closureCreditMarker, closureCreditNote, daysInMonth,
  dueFromBalance, nextMonthKey, type StatementRow,
} from "@/lib/monthend";
import {
  planRentRun, rentMarker, legacyRentMarker, monthKey, type RentContract,
} from "@/lib/rentrun";

export const dynamic = "force-dynamic";

/**
 * What the market owes each vendor for a month.
 *
 * GET  ?month=2026-10   → the statement, vendor by vendor
 * POST { month }        → post this month's closed-day rent credits to the ledger
 *
 * THE STATEMENT IS READ-ONLY UNTIL SOMEBODY POSTS THE CREDITS. Looking at what
 * a month comes to should never change anybody's balance — the office will
 * open this screen a dozen times before the 15th. The credits are written once,
 * deliberately, by pressing a button, and the marker in the note means pressing
 * it twice is harmless.
 */

const MONTH = /^\d{4}-\d{2}$/;

function monthWindow(month: string) {
  const start = centralInputToDate(`${month}-01T00:00`);
  const end = new Date(centralInputToDate(`${nextMonthKey(month)}-01T00:00`).getTime() - 1);
  return { start, end };
}

/**
 * NEXT MONTH'S RENT, WHICH IS THE RENT THAT COMES OFF THIS MONTH'S CHEQUE.
 *
 * October's sales are paid on the 15th of November, and by then the rent the
 * vendor owes is November's — charged on the 1st, a fortnight before the
 * cheque. October's own rent was charged on the 1st of October and came off the
 * cheque paid on the 15th of October. So a statement for October has to look
 * one month FORWARD for its rent line, not at the rent sitting in its own
 * window.
 *
 * The catch, and the reason this function exists: that rent does not exist yet.
 * Up to the 1st there is nothing on any ledger to subtract, so a statement that
 * only reads the books showed October as a full month of sales with no rent
 * against it — a number that was wrong all month and became right overnight.
 *
 * So when the rent hasn't posted, this returns what the run WILL post. Not an
 * estimate of it: `planRentRun` is the same function the cron executes, so the
 * figure here is the figure that lands. Prorations, final months, prepaid
 * booths and rent-free vendors are all already decided by it.
 */
type LiveContract = {
  id: string; vendorId: string; boothLabel: string; monthlyRentCents: number;
  status: string; startDate: Date; endDate: Date | null; paidThrough: Date | null;
  vendor: { rentFree: boolean };
};

/**
 * WHOSE RENT A CLOSED DAY COMES OFF, and how much of it.
 *
 * First attempt based this purely on the rent CHARGED inside the month, so a
 * vendor with no charge that month got nothing. That silently skipped the
 * prepaid vendors — anyone whose `paidThrough` runs past today is deliberately
 * not charged by the monthly run, so there was no charge to take a day off,
 * even though they had very much paid for those days. The one-time
 * "credit closed days" button on the bank page CREATES vendors like that: it
 * pushes `paidThrough` forward. So the people most likely to be owed a credit
 * were the ones being passed over.
 *
 * The basis is therefore: the rent actually charged in the month if there was
 * one, and otherwise the rent on their agreement — but only when the agreement
 * genuinely covers the month. Rent-free vendors, agreements that hadn't started
 * and agreements that had already ended still come out at zero, which is
 * correct: there is no rent of theirs to give back.
 */
function creditBasis(
  month: string,
  contracts: LiveContract[],
  vendorIds: string[],
  chargedCents: (vendorId: string) => number
): { basis: Map<string, number>; rentFree: Set<string>; onAgreement: Map<string, number> } {
  const onAgreement = new Map<string, number>();
  const rentFree = new Set<string>();

  for (const c of contracts) {
    if (c.vendor.rentFree) { rentFree.add(c.vendorId); continue; }
    /* Month keys are "YYYY-MM", so a string compare is a date compare. */
    if (monthKey(c.startDate) > month) continue;
    if (c.endDate && monthKey(c.endDate) < month) continue;
    onAgreement.set(c.vendorId, (onAgreement.get(c.vendorId) || 0) + c.monthlyRentCents);
  }

  const basis = new Map<string, number>();
  /* Every vendor, not just the ones with a live agreement: somebody whose
     agreement ended last week was still charged rent for this month, and that
     charge is theirs to have a day taken off. */
  for (const vendorId of new Set([...vendorIds, ...contracts.map((c) => c.vendorId)])) {
    const charged = chargedCents(vendorId);
    basis.set(vendorId, charged > 0 ? charged : onAgreement.get(vendorId) || 0);
  }
  return { basis, rentFree, onAgreement };
}

async function rentForNextMonth(month: string, contracts: LiveContract[]): Promise<{
  ym: string;
  perVendor: Map<string, number>;
  postedVendors: Set<string>;
}> {
  const ym = nextMonthKey(month);
  const { start, end } = monthWindow(ym);

  /* What that month's run has already written. Read by the run's own marker
     rather than by date, because that is how the cron decides "already
     charged" — reading it the same way means this screen and the run can't
     disagree about whether a booth has been billed. */
  const posted = await db.ledgerEntry.findMany({
    where: { type: "RENT", createdAt: { gte: start, lte: end } },
    select: { vendorId: true, note: true, amountCents: true },
  });

  const boothsPerVendor = new Map<string, number>();
  for (const c of contracts) boothsPerVendor.set(c.vendorId, (boothsPerVendor.get(c.vendorId) || 0) + 1);
  const legacy = legacyRentMarker(ym);
  const isCharged = (c: RentContract) =>
    posted.some((p) => p.note.includes(rentMarker(ym, c.id))) ||
    ((boothsPerVendor.get(c.vendorId) || 1) === 1 && posted.some((p) => p.vendorId === c.vendorId && p.note.includes(legacy)));

  const rows: RentContract[] = contracts.map((c) => ({
    id: c.id, vendorId: c.vendorId, boothLabel: c.boothLabel,
    monthlyRentCents: c.monthlyRentCents, status: c.status,
    endDate: c.endDate, paidThrough: c.paidThrough, free: c.vendor.rentFree,
  }));
  /* Planned as at the 1st, which is when the run fires — not as at today.
     Planning it for today would prorate a mid-month move-in against the wrong
     day and quietly disagree with the charge that actually posts. */
  const runAt = centralInputToDate(`${ym}-01T01:05`);
  const plan = planRentRun(rows, ym, runAt, isCharged);

  const perVendor = new Map<string, number>();
  const postedVendors = new Set<string>();

  /* Already on the books wins over the plan, per vendor. Charges are stored
     negative, so the sum is negated — and a closed-day credit sitting in that
     window nets against it, which is right: it is money off that rent. */
  for (const p of posted) {
    perVendor.set(p.vendorId, (perVendor.get(p.vendorId) || 0) - p.amountCents);
    postedVendors.add(p.vendorId);
  }
  for (const r of plan.rows) {
    if (r.amountCents <= 0 || postedVendors.has(r.vendorId)) continue;
    perVendor.set(r.vendorId, (perVendor.get(r.vendorId) || 0) + r.amountCents);
  }

  return { ym, perVendor, postedVendors };
}

async function compute(month: string) {
  const { start, end } = monthWindow(month);
  const totalDays = daysInMonth(month);

  const contracts: LiveContract[] = await db.contract.findMany({
    where: { status: { in: ["ACTIVE", "TERMINATING"] } },
    select: {
      id: true, vendorId: true, boothLabel: true, monthlyRentCents: true,
      status: true, startDate: true, endDate: true, paidThrough: true,
      vendor: { select: { rentFree: true } },
    },
  });

  const [vendors, closures, nextRent] = await Promise.all([
    db.vendor.findMany({
      where: { active: true },
      select: { id: true, code: true, businessName: true },
      orderBy: { code: "asc" },
    }),
    db.marketClosure.findMany({ where: { day: { startsWith: `${month}-` } }, orderBy: { day: "asc" } }),
    rentForNextMonth(month, contracts),
  ]);
  const closedDays = closures.length;

  /* The sales split as it was decided at the till. Never recomputed from
     today's fee or today's price — a vendor whose rate changed on the 20th
     must not have the 1st to the 19th quietly restated. */
  const lines = await db.saleLine.findMany({
    where: { sale: { createdAt: { gte: start, lte: end }, status: { not: "VOIDED" } } },
    select: { vendorId: true, priceCents: true, quantity: true, commissionCents: true, vendorNetCents: true },
  });

  const entries = await db.ledgerEntry.findMany({
    where: { createdAt: { gte: start, lte: end } },
    select: { vendorId: true, type: true, amountCents: true, note: true },
  });

  /* Everything each vendor's ledger said BEFORE this month began. One query
     for the lot rather than one per vendor. */
  const opening = await db.ledgerEntry.groupBy({
    by: ["vendorId"],
    where: { createdAt: { lt: start } },
    _sum: { amountCents: true },
  });
  const openingOf = new Map(opening.map((o) => [o.vendorId, o._sum.amountCents || 0]));

  const zero = () => ({
    gross: 0, market: 0, net: 0, refunds: 0, rent: 0, rentPaid: 0, adjust: 0, paidOut: 0, creditPosted: 0,
    /* THE ONE FIGURE THAT DECIDES THE CHEQUE, and the reason it is kept apart
       from every breakdown above it: a vendor's balance is, everywhere else in
       this app, the plain sum of their ledger entries. If this screen worked
       its own total out from the parts — subtracting rent it decided was rent,
       adding payments it decided were payments — then the day an entry type is
       added that it doesn't recognise, this screen and the payout screen would
       quietly disagree about what the same vendor is owed. The breakdown is for
       reading. This is for paying. */
    ledgerTotal: 0,
  });
  const acc = new Map<string, ReturnType<typeof zero>>();
  const get = (id: string) => {
    const cur = acc.get(id) || zero();
    acc.set(id, cur);
    return cur;
  };

  for (const l of lines) {
    const a = get(l.vendorId);
    a.gross += l.priceCents * l.quantity;
    a.market += l.commissionCents;
    a.net += l.vendorNetCents;
  }

  const marker = closureCreditMarker(month);
  for (const e of entries) {
    const a = get(e.vendorId);
    a.ledgerTotal += e.amountCents;
    switch (e.type) {
      case "REFUND":
      case "VOID":
        a.refunds += Math.abs(e.amountCents);
        break;
      case "RENT":
        /* THE CREDIT IS A RENT LINE, NOT AN ADJUSTMENT, and that is deliberate.
           The collections screen works out what rent is still owed from the
           RENT entries alone — nothing else on the account can move that
           figure. A closed-day credit posted as an adjustment would top up the
           vendor's balance while the collections list went on chasing them for
           a full month's rent they were never going to pay. Posting it as rent
           means one number, in one place, and both screens agree.

           Charges are stored negative and the credit positive, so the sign
           does the arithmetic: net rent for the month, not the gross. */
        if (e.note.includes(marker)) a.creditPosted += e.amountCents;
        else a.rent -= e.amountCents;
        break;
      case "RENT_PAYMENT":
        a.rentPaid += e.amountCents;
        break;
      case "PAYOUT":
      case "PAYOUT_FEE":
        a.paidOut += Math.abs(e.amountCents);
        break;
      case "SALE":
        /* Already counted from the sale lines above — counting the ledger
           entry too would double every sale. */
        break;
      default:
        /* ADJUST, COMPLAINT and anything added later. A closed-day credit is
           an ADJUST carrying this month's marker, so it is pulled out
           separately: it belongs on its own line, not lumped in with a
           hand-typed adjustment. */
        if (e.note.includes(marker)) a.creditPosted += e.amountCents;
        else a.adjust += e.amountCents;
        break;
    }
  }

  const { basis, rentFree, onAgreement } = creditBasis(
    month,
    contracts,
    vendors.map((v) => v.id),
    (vendorId) => acc.get(vendorId)?.rent || 0
  );

  const rows: StatementRow[] = vendors.map((v) => {
    const a = acc.get(v.id) || zero();
    const openingBalanceCents = openingOf.get(v.id) || 0;
    /* A DAY'S WORTH OF THE RENT THEY WERE ACTUALLY CHARGED, not of the rent on
       their agreement. The two differ more often than it looks: a vendor who
       moved in on the 10th, one on a rent-free month, one who took a second
       booth, one whose rent changed. Crediting a month's rent to somebody who
       was never billed for it is the market giving money away, and it would
       leave the collections screen showing rent credited against a charge that
       does not exist. */
    const creditBasisCents = basis.get(v.id) || 0;
    const credit =
      a.creditPosted !== 0 ? a.creditPosted : closureCreditCents(creditBasisCents, month, closedDays);

    /* WHY A VENDOR GETS NOTHING, said out loud on the row. Zeroes scattered
       down a column look like a bug whether they are one or not, and the only
       way to find out used to be to ask. */
    const noCreditReason =
      credit !== 0 ? ""
      : closedDays === 0 ? ""
      : rentFree.has(v.id) ? "Rent-free — no booth rent to credit."
      : onAgreement.has(v.id) ? "Their rent for this month rounds to nothing."
      : contracts.some((c) => c.vendorId === v.id)
        ? `Their agreement doesn't cover ${month} — it started after it or had already ended.`
        : "No active booth agreement, so no rent to credit.";

    /* Opening balance plus everything the ledger did this month, full stop.
       The closed-day credit is in there only once it has actually been posted —
       looking at what a month comes to never moves a balance. */
    const closingBalanceCents = openingBalanceCents + a.ledgerTotal;

    /* Whatever the breakdown above doesn't account for. Normally zero. It is
       reported rather than hidden because a statement whose columns don't add
       up to its own total is worse than useless — somebody will check it with
       a calculator, and they should be able to see where the rest went. */
    const explained =
      a.net - a.rent + a.rentPaid + a.adjust - a.paidOut + a.creditPosted - a.refunds;
    const otherCents = a.ledgerTotal - explained;

    /* THE CHEQUE. Where they stand at the end of the month, less the rent that
       posts on the 1st and will be withheld from this payment.

       Why next month's rent is subtracted here rather than read out of the
       books: it is dated the 1st, which is OUTSIDE this month's window, so the
       closing balance above has never seen it and cannot double-count it. The
       month's OWN rent is inside the window and is already cancelled there by
       the payout made on the 15th against it — which is why this works out to
       "their sales, less next month's rent" once a month has settled. */
    const nextRentCents = nextRent.perVendor.get(v.id) || 0;

    return {
      vendorId: v.id,
      vendorCode: v.code,
      vendorName: v.businessName,
      salesGrossCents: a.gross,
      marketShareCents: a.market,
      salesNetCents: a.net,
      refundsCents: a.refunds,
      rentChargedCents: a.rent,
      closureCreditCents: credit,
      creditBasisCents,
      creditPrepaid: a.rent === 0 && creditBasisCents > 0,
      noCreditReason,
      rentPaidCents: a.rentPaid,
      adjustmentsCents: a.adjust,
      paidOutCents: a.paidOut,
      otherCents,
      openingBalanceCents,
      closingBalanceCents,
      nextRentCents,
      nextRentMonth: nextRent.ym,
      nextRentPosted: nextRent.postedVendors.has(v.id),
      dueCents: dueFromBalance(closingBalanceCents - nextRentCents),
      owedToMarketCents: Math.max(0, nextRentCents - closingBalanceCents),
    };
  });

  const live = rows.filter(
    (r) =>
      r.salesGrossCents !== 0 || r.rentChargedCents !== 0 || r.closingBalanceCents !== 0 ||
      r.openingBalanceCents !== 0 || r.nextRentCents !== 0 || r.closureCreditCents !== 0
  );

  return {
    month,
    totalDays,
    closedDays,
    closures,
    /* Posted when every vendor who is due one already has it on their ledger.
       Measured over ALL rows, not the visible ones: a prepaid vendor with no
       sales and no charge that month is due a credit and would be the one left
       out if this only looked at the rows on screen. */
    creditsPosted: rows.length > 0 && rows.every((r) => {
      const should = closureCreditCents(r.creditBasisCents, month, closedDays);
      return should === 0 || (acc.get(r.vendorId)?.creditPosted || 0) !== 0;
    }),
    rows: live,
    /* Unfiltered, for POST. Never sent to the browser — see build(). */
    allRows: rows,
    nextRentMonth: nextRent.ym,
    /* True only when the whole month's rent run has landed. One vendor still
       on the plan is enough to keep the "not charged yet" marker on the
       screen, because the total is then still partly a forecast. */
    nextRentPosted: live.length > 0 && live.every((r) => r.nextRentCents === 0 || r.nextRentPosted),
    totals: {
      salesGrossCents: live.reduce((n, r) => n + r.salesGrossCents, 0),
      marketShareCents: live.reduce((n, r) => n + r.marketShareCents, 0),
      rentChargedCents: live.reduce((n, r) => n + r.rentChargedCents, 0),
      closureCreditCents: live.reduce((n, r) => n + r.closureCreditCents, 0),
      nextRentCents: live.reduce((n, r) => n + r.nextRentCents, 0),
      dueCents: live.reduce((n, r) => n + r.dueCents, 0),
      owedToMarketCents: live.reduce((n, r) => n + r.owedToMarketCents, 0),
    },
  };
}

/** The statement as the browser gets it — without the unfiltered working set. */
async function build(month: string) {
  const { allRows, ...rest } = await compute(month);
  void allRows;
  return rest;
}

export async function GET(req: NextRequest) {
  return runRoute("admin/monthend GET", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
    const month = (req.nextUrl.searchParams.get("month") || "").trim();
    if (!MONTH.test(month)) return NextResponse.json({ error: "Which month? Use YYYY-MM." }, { status: 400 });
    return NextResponse.json(await build(month));
  });
}

/** Write this month's closed-day credits onto the vendors' ledgers. */
export async function POST(req: NextRequest) {
  return runRoute("admin/monthend POST", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const month = String(body.month || "").trim();
    if (!MONTH.test(month)) return NextResponse.json({ error: "Which month? Use YYYY-MM." }, { status: 400 });

    const closures = await db.marketClosure.count({ where: { day: { startsWith: `${month}-` } } });
    if (closures === 0) return NextResponse.json({ error: "No closed days recorded for that month." }, { status: 400 });

    const totalDays = daysInMonth(month);
    const marker = closureCreditMarker(month);
    const { end } = monthWindow(month);

    /* POSTED FROM THE SAME NUMBERS THE SCREEN SHOWED. This used to work the
       credit out again from its own query, which is how a screen and a ledger
       come to disagree about the same month — one of them gets a rule the
       other didn't. There is one calculation now, in compute(), and this
       writes down what it said.

       Unfiltered rows, deliberately: a prepaid vendor with no sales and no
       charge that month is still owed a credit, and they are exactly who falls
       off a list trimmed to "vendors with activity". */
    const { allRows } = await compute(month);

    /* Who already has it. Checked per vendor rather than once for the month,
       so a vendor added halfway through still gets theirs when the button is
       pressed again. */
    const already = await db.ledgerEntry.findMany({
      where: { note: { contains: marker } },
      select: { vendorId: true },
    });
    const have = new Set(already.map((e) => e.vendorId));

    let posted = 0;
    let totalCents = 0;
    for (const row of allRows) {
      if (have.has(row.vendorId)) continue;
      const credit = closureCreditCents(row.creditBasisCents, month, closures);
      if (credit <= 0) continue;
      await db.ledgerEntry.create({
        data: {
          vendorId: row.vendorId,
          /* RENT, positive: a credit against the month's rent. The
             collections screen reads rent owed from these entries alone, so
             anything else would credit the balance and keep chasing the
             vendor for the full month. */
          type: "RENT",
          amountCents: credit,
          note: closureCreditNote(month, closures, totalDays),
          /* DATED TO THE MONTH IT IS A CREDIT FOR, not to the day the button
             was pressed. The office presses it after the month has ended —
             that is the whole point of waiting — so a credit stamped "now"
             would fall outside the month it belongs to: September's statement
             would go on saying the credit hasn't been given while October's
             showed a rent credit nobody could account for. Stamping it with
             the last instant of the month puts it where the money happened,
             and every screen that reads a date range then agrees. */
          createdAt: end,
        },
      });
      posted++;
      totalCents += credit;
    }

    if (posted > 0) {
      await recordAudit(
        {
          action: "VENDOR_LEDGER",
          targetType: "MONTH",
          targetId: month,
          targetLabel: `Closed-day credits ${month}`,
          amountCents: -totalCents,
          detail: `${closures} closed ${closures === 1 ? "day" : "days"} in ${month} credited to ${posted} ${posted === 1 ? "vendor" : "vendors"} — $${(totalCents / 100).toFixed(2)} in total`,
        },
        req
      );
    }

    return NextResponse.json({ posted, totalCents, ...(await build(month)) });
  });
}

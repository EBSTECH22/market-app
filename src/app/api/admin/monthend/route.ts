import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { denyUnless } from "@/lib/perm";
import { runRoute } from "@/lib/handler";
import { recordAudit } from "@/lib/audit";
import { centralInputToDate } from "@/lib/time";
import {
  closureCreditCents, closureCreditMarker, closureCreditNote, daysInMonth,
  dueFromBalance, type StatementRow,
} from "@/lib/monthend";

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
  const [y, m] = month.split("-").map(Number);
  const start = centralInputToDate(`${month}-01T00:00`);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const end = new Date(centralInputToDate(`${nextMonth}-01T00:00`).getTime() - 1);
  return { start, end };
}

async function build(month: string) {
  const { start, end } = monthWindow(month);
  const totalDays = daysInMonth(month);

  const [vendors, closures] = await Promise.all([
    db.vendor.findMany({
      where: { active: true },
      select: { id: true, code: true, businessName: true },
      orderBy: { code: "asc" },
    }),
    db.marketClosure.findMany({ where: { day: { startsWith: `${month}-` } }, orderBy: { day: "asc" } }),
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
    const credit =
      a.creditPosted !== 0 ? a.creditPosted : closureCreditCents(a.rent, month, closedDays);

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
      rentPaidCents: a.rentPaid,
      adjustmentsCents: a.adjust,
      paidOutCents: a.paidOut,
      otherCents,
      openingBalanceCents,
      closingBalanceCents,
      dueCents: dueFromBalance(closingBalanceCents),
    };
  });

  const live = rows.filter(
    (r) => r.salesGrossCents !== 0 || r.rentChargedCents !== 0 || r.closingBalanceCents !== 0 || r.openingBalanceCents !== 0
  );

  return {
    month,
    totalDays,
    closedDays,
    closures,
    /* Posted when every vendor who is due one already has it on their ledger. */
    creditsPosted: live.length > 0 && live.every((r) => {
      const a = acc.get(r.vendorId);
      const should = closureCreditCents(a?.rent || 0, month, closedDays);
      return should === 0 || (a?.creditPosted || 0) !== 0;
    }),
    rows: live,
    totals: {
      salesGrossCents: live.reduce((n, r) => n + r.salesGrossCents, 0),
      marketShareCents: live.reduce((n, r) => n + r.marketShareCents, 0),
      rentChargedCents: live.reduce((n, r) => n + r.rentChargedCents, 0),
      closureCreditCents: live.reduce((n, r) => n + r.closureCreditCents, 0),
      dueCents: live.reduce((n, r) => n + r.dueCents, 0),
      owedToMarketCents: live.reduce((n, r) => n + (r.closingBalanceCents < 0 ? -r.closingBalanceCents : 0), 0),
    },
  };
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

    /* The rent that was actually charged in the month, vendor by vendor. Not
       the figure on the agreement — see the note in build(). Charges are
       stored negative, so the sum is negated to get what was billed, and a
       vendor who was never billed sums to zero and is skipped. */
    const { start, end } = monthWindow(month);
    const charged = await db.ledgerEntry.groupBy({
      by: ["vendorId"],
      where: { type: "RENT", createdAt: { gte: start, lte: end } },
      _sum: { amountCents: true },
    });

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
    for (const row of charged) {
      if (have.has(row.vendorId)) continue;
      const rent = -(row._sum.amountCents || 0);
      const credit = closureCreditCents(rent, month, closures);
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

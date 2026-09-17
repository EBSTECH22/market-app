import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit, currentAuditActor } from "@/lib/audit";
import { centralInputToDate, centralMonthStart } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * Paying the vendors.
 *
 * Until now this was one ledger entry at a time with a note typed by hand,
 * which left no record of the batch, no statement for the vendor, and no way to
 * answer "did everyone get paid for March".
 *
 * THE AMOUNT IS THE LEDGER BALANCE, NOT THE PERIOD'S SALES, and that is the
 * important decision in this file. The ledger already nets sales, refunds,
 * rent charged, rent paid and previous payouts. Paying a period's sales instead
 * would pay a vendor for goods that have since been refunded, and would ignore
 * the rent they still owe — which is exactly how a market ends up chasing money
 * it handed over last week. The period is what the STATEMENT covers; the
 * balance is what gets paid.
 *
 * A vendor whose balance is negative owes the market and appears in the run as
 * owing, with nothing to pay. They are listed rather than hidden, because "who
 * did I not pay and why" is the question this screen exists to answer.
 */

const MAX_METHODS = ["CASH", "CHECK", "ACH", "STRIPE", "RENT_OFFSET"] as const;
type Method = (typeof MAX_METHODS)[number];

const METHOD_LABEL: Record<Method, string> = {
  CASH: "Cash",
  CHECK: "Check",
  ACH: "Bank transfer",
  STRIPE: "Stripe",
  RENT_OFFSET: "Applied to rent",
};

type PeriodRow = {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  grossCents: number;
  commissionCents: number;
  refundCents: number;
  balanceCents: number;
  netCents: number;
};

/** What each vendor sold in the window, and what the books say they're owed now. */
async function buildRows(periodStart: Date, periodEnd: Date): Promise<PeriodRow[]> {
  const vendors = await db.vendor.findMany({
    where: { active: true },
    select: { id: true, code: true, businessName: true },
    orderBy: { code: "asc" },
  });

  const lines = await db.saleLine.findMany({
    where: { sale: { createdAt: { gte: periodStart, lte: periodEnd }, status: { not: "VOIDED" } } },
    select: { vendorId: true, priceCents: true, quantity: true, commissionCents: true },
  });

  /* Refunds and voids are ledger entries, so the period's give-backs are read
     from there rather than re-derived from the refund table — same source as
     the balance, which means the two can't disagree. */
  const ledger = await db.ledgerEntry.findMany({
    where: { createdAt: { gte: periodStart, lte: periodEnd }, type: { in: ["REFUND", "VOID"] } },
    select: { vendorId: true, amountCents: true },
  });

  const balances = await db.ledgerEntry.groupBy({
    by: ["vendorId"],
    _sum: { amountCents: true },
  });
  const balanceOf = new Map<string, number>(
    balances.map((b) => [b.vendorId, b._sum.amountCents || 0] as [string, number])
  );

  const gross = new Map<string, number>();
  const commission = new Map<string, number>();
  for (const l of lines) {
    gross.set(l.vendorId, (gross.get(l.vendorId) || 0) + l.priceCents * l.quantity);
    commission.set(l.vendorId, (commission.get(l.vendorId) || 0) + l.commissionCents);
  }
  const refunded = new Map<string, number>();
  for (const e of ledger) refunded.set(e.vendorId, (refunded.get(e.vendorId) || 0) + Math.abs(e.amountCents));

  return vendors
    .map((v) => {
      const balanceCents = balanceOf.get(v.id) || 0;
      return {
        vendorId: v.id,
        vendorCode: v.code,
        vendorName: v.businessName,
        grossCents: gross.get(v.id) || 0,
        commissionCents: commission.get(v.id) || 0,
        refundCents: refunded.get(v.id) || 0,
        balanceCents,
        netCents: balanceCents > 0 ? balanceCents : 0,
      };
    })
    .filter((r) => r.grossCents > 0 || r.balanceCents !== 0)
    .sort((a, b) => b.netCents - a.netCents);
}

export async function GET(req: NextRequest) {
  return runRoute("admin/payouts GET", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
    const p = req.nextUrl.searchParams;

    if (p.get("preview")) {
      const from = p.get("from");
      const to = p.get("to");
      const periodStart = from ? centralInputToDate(`${from}T00:00`) : centralMonthStart(new Date());
      const periodEnd = to
        ? new Date(centralInputToDate(`${to}T00:00`).getTime() + 24 * 60 * 60 * 1000 - 1)
        : new Date();
      const rows = await buildRows(periodStart, periodEnd);
      return NextResponse.json({
        preview: true,
        periodStart,
        periodEnd,
        rows,
        payableCents: rows.reduce((n, r) => n + r.netCents, 0),
        owedToMarketCents: rows.reduce((n, r) => n + (r.balanceCents < 0 ? -r.balanceCents : 0), 0),
      });
    }

    const runId = p.get("runId") || "";
    const runs = await db.payoutRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 24,
      include: { payouts: { select: { netCents: true, status: true } } },
    });
    const list = runs.map((r) => ({
      id: r.id,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      status: r.status,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      note: r.note,
      vendorCount: r.payouts.length,
      totalCents: r.payouts.reduce((n, x) => n + x.netCents, 0),
      paidCents: r.payouts.filter((x) => x.status === "PAID").reduce((n, x) => n + x.netCents, 0),
      pendingCount: r.payouts.filter((x) => x.status === "PENDING").length,
    }));

    const openId = runId || list[0]?.id || "";
    const payouts = openId
      ? await db.payout.findMany({ where: { runId: openId }, orderBy: { netCents: "desc" } })
      : [];

    return NextResponse.json({ runs: list, runId: openId, payouts, methodLabels: METHOD_LABEL });
  });
}

// POST { from, to, note } — snapshot a run for that period
export async function POST(req: NextRequest) {
  return runRoute("admin/payouts POST", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
    const body = await req.json();

    const from = String(body.from || "");
    const to = String(body.to || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return NextResponse.json({ error: "Pick a start and end date for the period." }, { status: 400 });
    }
    const periodStart = centralInputToDate(`${from}T00:00`);
    const periodEnd = new Date(centralInputToDate(`${to}T00:00`).getTime() + 24 * 60 * 60 * 1000 - 1);
    if (periodEnd <= periodStart) {
      return NextResponse.json({ error: "The end date has to be after the start date." }, { status: 400 });
    }

    const rows = await buildRows(periodStart, periodEnd);
    const payable = rows.filter((r) => r.netCents > 0 || r.balanceCents !== 0);
    if (!payable.length) {
      return NextResponse.json({ error: "Nothing to pay out for that period." }, { status: 400 });
    }

    const actor = await currentAuditActor();
    const run = await db.payoutRun.create({
      data: {
        periodStart,
        periodEnd,
        createdBy: actor.actorName || (actor.actorType === "OWNER_KEY" ? "Owner password" : ""),
        note: String(body.note || "").slice(0, 200),
        payouts: {
          create: payable.map((r) => ({
            vendorId: r.vendorId,
            vendorCode: r.vendorCode,
            vendorName: r.vendorName,
            grossCents: r.grossCents,
            commissionCents: r.commissionCents,
            refundCents: r.refundCents,
            balanceCents: r.balanceCents,
            netCents: r.netCents,
            /* A vendor with nothing coming starts SKIPPED rather than PENDING,
               so "3 still to pay" means three people actually waiting on money
               and not three rows that will never be paid. */
            status: r.netCents > 0 ? "PENDING" : "SKIPPED",
          })),
        },
      },
      include: { payouts: true },
    });

    await recordAudit(
      {
        action: "PAYOUT_RUN",
        targetType: "PAYOUT_RUN",
        targetId: run.id,
        targetLabel: `${from} – ${to}`,
        amountCents: payable.reduce((n, r) => n + r.netCents, 0),
        detail: `Payout run built for ${from} – ${to}: ${payable.filter((r) => r.netCents > 0).length} vendors payable`,
      },
      req
    );

    return NextResponse.json({ ok: true, runId: run.id, payouts: run.payouts });
  });
}

// PATCH { payoutId, method, reference } — mark one vendor paid
// PATCH { payoutId, status: "SKIPPED" } — hold one back
// PATCH { runId, action: "close" } — close the run
export async function PATCH(req: NextRequest) {
  return runRoute("admin/payouts PATCH", async () => {
    // Money going out of the market, not just reading the books.
    { const denied = await denyUnless("money"); if (denied) return denied; }
    const body = await req.json();

    if (body.action === "close") {
      const run = await db.payoutRun.findUnique({ where: { id: String(body.runId || "") } });
      if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
      await db.payoutRun.update({ where: { id: run.id }, data: { status: "CLOSED", closedAt: new Date() } });
      return NextResponse.json({ ok: true });
    }

    const payout = await db.payout.findUnique({ where: { id: String(body.payoutId || "") } });
    if (!payout) return NextResponse.json({ error: "Payout not found." }, { status: 404 });

    if (body.status === "SKIPPED") {
      if (payout.status === "PAID") {
        return NextResponse.json({ error: "That one is already paid — it can't be held back." }, { status: 400 });
      }
      await db.payout.update({ where: { id: payout.id }, data: { status: "SKIPPED" } });
      return NextResponse.json({ ok: true });
    }

    const method = String(body.method || "").toUpperCase() as Method;
    if (!MAX_METHODS.includes(method)) {
      return NextResponse.json({ error: "Pick how it was paid." }, { status: 400 });
    }
    if (payout.netCents <= 0) {
      return NextResponse.json({ error: "There's nothing owed on that line." }, { status: 400 });
    }

    const actor = await currentAuditActor();
    const paidBy = actor.actorName || (actor.actorType === "OWNER_KEY" ? "Owner password" : "");
    const reference = String(body.reference || "").slice(0, 80);

    /* Conditional update, not a read-then-write. Two clicks on "Mark paid" a
       moment apart would otherwise both see PENDING and both post a ledger
       entry, paying the vendor twice in the books. Whoever loses the race
       matches zero rows and is told it's already done. */
    const claimed = await db.payout.updateMany({
      where: { id: payout.id, status: "PENDING" },
      data: {
        status: "PAID",
        method,
        reference,
        paidAt: new Date(),
        paidBy,
      },
    });
    if (claimed.count === 0) {
      return NextResponse.json({ error: "That payout was already marked paid." }, { status: 409 });
    }

    /* The ledger entry is what actually moves the vendor's balance. Written
       after the claim so a double-click can't produce two of them. */
    const entry = await db.ledgerEntry.create({
      data: {
        vendorId: payout.vendorId,
        type: "PAYOUT",
        amountCents: -payout.netCents,
        note: `Payout ${METHOD_LABEL[method]}${reference ? ` (${reference})` : ""}`,
      },
    });
    await db.payout.update({ where: { id: payout.id }, data: { ledgerEntryId: entry.id } });

    await recordAudit(
      {
        action: "PAYOUT_PAID",
        targetType: "VENDOR",
        targetId: payout.vendorId,
        targetLabel: `${payout.vendorCode} — ${payout.vendorName}`,
        amountCents: payout.netCents,
        detail: `Paid ${METHOD_LABEL[method]}${reference ? ` · ${reference}` : ""}`,
      },
      req
    );

    return NextResponse.json({ ok: true, ledgerEntryId: entry.id });
  });
}

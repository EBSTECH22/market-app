import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit, currentAuditActor } from "@/lib/audit";
import { centralInputToDate, centralMonthStart } from "@/lib/time";
import { transferToVendor, stripeBalanceCents, getPayoutFee, feeFor, refreshAccountStatus } from "@/lib/payouts";

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
  /** Whether Stripe will accept a transfer to them right now. */
  payoutsEnabled: boolean;
  hasAccount: boolean;
};

/** What each vendor sold in the window, and what the books say they're owed now. */
async function buildRows(periodStart: Date, periodEnd: Date): Promise<PeriodRow[]> {
  const vendors = await db.vendor.findMany({
    where: { active: true },
    select: { id: true, code: true, businessName: true, stripeAccountId: true, payoutsEnabled: true },
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
        payoutsEnabled: !!v.payoutsEnabled,
        hasAccount: !!v.stripeAccountId,
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
    const stored = openId
      ? await db.payout.findMany({ where: { runId: openId }, orderBy: { netCents: "desc" } })
      : [];

    /* Whether each vendor can actually be sent money today. Read fresh rather
       than frozen into the run: a vendor who connects their bank on Tuesday
       should be payable on a run built on Monday. */
    const runVendorIds = [...new Set(stored.map((x) => x.vendorId))];
    const connectRows = runVendorIds.length
      ? await db.vendor.findMany({
          where: { id: { in: runVendorIds } },
          select: { id: true, stripeAccountId: true, payoutsEnabled: true, payoutStatusNote: true },
        })
      : [];
    type Connect = { id: string; stripeAccountId: string; payoutsEnabled: boolean; payoutStatusNote: string };
    const connectOf = new Map<string, Connect>(connectRows.map((v) => [v.id, v] as [string, Connect]));

    const fee0 = await getPayoutFee();
    const payouts = stored.map((x) => {
      const c = connectOf.get(x.vendorId);
      const quote = feeFor(x.netCents, fee0);
      return {
        ...x,
        payoutsEnabled: !!c?.payoutsEnabled,
        hasAccount: !!c?.stripeAccountId,
        accountNote: c?.payoutStatusNote || "",
        /* What a bank transfer would cost and deliver, quoted before anyone
           commits to it — the fee comes off the vendor, so they should never
           find out what it was from the statement afterwards. */
        quotedFeeCents: x.status === "PAID" ? x.feeCents : quote.feeCents,
        quotedSendCents: x.status === "PAID" ? x.netCents - x.feeCents : quote.sendableCents,
      };
    });

    /* The Stripe balance sits next to the run total on screen for one reason:
       transfers come out of it, and cash taken at the register never lands
       there. Finding that out from a failed transfer mid-run is a bad way to
       learn it. */
    const [balanceCents, fee] = await Promise.all([stripeBalanceCents(), getPayoutFee()]);
    const payableCents = payouts.filter((p2) => p2.status === "PENDING").reduce((n, p2) => n + p2.netCents, 0);

    return NextResponse.json({
      runs: list,
      runId: openId,
      payouts,
      methodLabels: METHOD_LABEL,
      stripeBalanceCents: balanceCents,
      shortfallCents: balanceCents === null ? 0 : Math.max(0, payableCents - balanceCents),
      fee,
    });
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

/**
 * Send one payout by bank transfer and write it into the books.
 *
 * ORDER MATTERS AND IT IS NOT THE OBVIOUS ONE. The row is claimed FIRST, with a
 * conditional update, and only then is the money sent. Claiming afterwards
 * would leave a window where two clicks both see PENDING and both transfer —
 * and a transfer, unlike a ledger row, cannot be undone from here. If the
 * transfer then fails, the claim is released and the reason is stored, so the
 * row goes back to being payable rather than being stuck as paid.
 *
 * Stripe is also given the payout id as an idempotency key, so even a retry
 * that gets past this code can only ever produce one transfer.
 */
async function payByTransfer(
  payout: { id: string; vendorId: string; vendorCode: string; vendorName: string; netCents: number; status: string; runId: string },
  paidBy: string,
  req: NextRequest
) {
  const claimed = await db.payout.updateMany({
    where: { id: payout.id, status: "PENDING" },
    data: { status: "SENDING", method: "STRIPE", paidBy },
  });
  if (claimed.count === 0) {
    return { ok: false as const, error: "That payout is already being paid.", code: "BUSY" };
  }

  const result = await transferToVendor(
    payout.vendorId,
    payout.netCents,
    payout.id,
    `Community Harvest payout — ${payout.vendorName} (${payout.vendorCode})`
  );

  if (!result.ok) {
    // Put it back. A failed transfer must not leave a row that looks paid.
    await db.payout.update({
      where: { id: payout.id },
      data: { status: "PENDING", method: "", failureReason: result.error.slice(0, 200) },
    });
    return { ok: false as const, error: result.error, code: result.code };
  }

  await db.payout.update({
    where: { id: payout.id },
    data: {
      status: "PAID",
      method: "STRIPE",
      transferId: result.transferId,
      feeCents: result.feeCents,
      reference: result.transferId,
      paidAt: new Date(),
      paidBy,
      failureReason: "",
    },
  });

  /* Two ledger entries, not one. The vendor was owed the full amount; part of
     it went to them and part covered the transfer fee. Netting those into a
     single line would leave a statement that doesn't explain itself when the
     vendor adds up what they received. */
  const entry = await db.ledgerEntry.create({
    data: {
      vendorId: payout.vendorId,
      type: "PAYOUT",
      amountCents: -result.sentCents,
      note: `Paid to your bank (Stripe ${result.transferId.slice(-8)})`,
    },
  });
  if (result.feeCents > 0) {
    await db.ledgerEntry.create({
      data: {
        vendorId: payout.vendorId,
        type: "PAYOUT_FEE",
        amountCents: -result.feeCents,
        note: "Bank transfer fee",
      },
    });
  }
  await db.payout.update({ where: { id: payout.id }, data: { ledgerEntryId: entry.id } });

  await recordAudit(
    {
      action: "PAYOUT_PAID",
      targetType: "VENDOR",
      targetId: payout.vendorId,
      targetLabel: `${payout.vendorCode} — ${payout.vendorName}`,
      amountCents: payout.netCents,
      detail: `Bank transfer of $${(result.sentCents / 100).toFixed(2)}${result.feeCents ? ` (after a $${(result.feeCents / 100).toFixed(2)} fee)` : ""} — Stripe ${result.transferId}`,
    },
    req
  );

  return { ok: true as const, transferId: result.transferId, sentCents: result.sentCents, feeCents: result.feeCents };
}

// PATCH { payoutId, method, reference } — mark one vendor paid
// PATCH { payoutId, status: "SKIPPED" } — hold one back
// PATCH { runId, action: "close" } — close the run
export async function PATCH(req: NextRequest) {
  return runRoute("admin/payouts PATCH", async () => {
    // Money going out of the market, not just reading the books.
    { const denied = await denyUnless("money"); if (denied) return denied; }
    const body = await req.json();

    /* ------------------------------------------------------- pay everyone -- */
    if (body.action === "pay_all") {
      const runId = String(body.runId || "");
      const pending = await db.payout.findMany({
        where: { runId, status: "PENDING", netCents: { gt: 0 } },
        orderBy: { netCents: "desc" },
      });
      if (!pending.length) return NextResponse.json({ error: "Nothing left to pay on this run." }, { status: 400 });

      const actor = await currentAuditActor();
      const paidBy = actor.actorName || (actor.actorType === "OWNER_KEY" ? "Owner password" : "");

      const paid: { vendorName: string; sentCents: number }[] = [];
      const failed: { vendorName: string; reason: string; code: string }[] = [];
      let stopped = "";

      for (const p2 of pending) {
        const r = await payByTransfer(p2, paidBy, req);
        if (r.ok) {
          paid.push({ vendorName: p2.vendorName, sentCents: r.sentCents });
          continue;
        }
        failed.push({ vendorName: p2.vendorName, reason: r.error, code: String(r.code || "") });
        /* Running out of money is not a per-vendor problem, it is the end of
           the run. Carrying on would produce one failure per remaining vendor
           and bury the actual message. */
        if (r.code === "NO_FUNDS") {
          stopped = "Your Stripe balance ran out part way through. Everyone still listed is untouched.";
          break;
        }
      }

      return NextResponse.json({
        ok: true,
        paidCount: paid.length,
        paidCents: paid.reduce((n, x) => n + x.sentCents, 0),
        failed,
        stopped,
      });
    }

    /* Ask Stripe where each vendor's onboarding stands. Cheap, and the answer
       moves without anyone here doing anything. */
    if (body.action === "refresh_accounts") {
      const vendors = await db.vendor.findMany({
        where: { active: true, stripeAccountId: { not: "" } },
        select: { id: true },
      });
      for (const v of vendors) await refreshAccountStatus(v.id);
      return NextResponse.json({ ok: true, checked: vendors.length });
    }

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

    /* ---------------------------------------------- paid by bank transfer -- */
    if (method === "STRIPE") {
      const result = await payByTransfer(payout, paidBy, req);
      if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: 400 });
      return NextResponse.json({
        ok: true,
        transferId: result.transferId,
        sentCents: result.sentCents,
        feeCents: result.feeCents,
      });
    }

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

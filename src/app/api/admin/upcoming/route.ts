import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import {
  planRentRun, monthKey, rentMarker, legacyRentMarker, nextRentRunDate, type RentContract,
} from "@/lib/rentrun";
import { recordAudit } from "@/lib/audit";
import {
  getMarketOpensAt, setMarketOpensAt, getPayoutDay, setPayoutDay, nextPayoutDate,
  closedDaysOwed, closedDayCreditAppliedAt, markClosedDayCreditApplied, creditedPaidThrough,
} from "@/lib/schedule";

export const dynamic = "force-dynamic";

/**
 * The financial position, looking forward rather than back.
 *
 * Every other card on the bank page reports what has happened. This one answers
 * the three questions that get asked standing at the counter on a Tuesday:
 * what is landing in my bank and on which day, what is the rent run going to
 * charge before it charges it, and what do I owe the vendors.
 *
 * The rent figures come from the same planner the cron runs, so the number
 * shown here is the number that will post. A preview written separately would
 * be a second implementation of the billing rules and would eventually lie.
 */
export async function GET() {
  return runRoute("admin/upcoming GET", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }

    const now = new Date();

    /* ------------------------------------------------------- bank deposits -- */
    let deposits: { id: string; amountCents: number; status: string; arrival: string }[] = [];
    let availableCents = 0;
    let stripeError = "";
    if (stripe) {
      try {
        const [balance, payouts] = await Promise.all([
          stripe.balance.retrieve(),
          stripe.payouts.list({ limit: 25 }),
        ]);
        availableCents = balance.available
          .filter((a) => a.currency === "usd")
          .reduce((n, a) => n + a.amount, 0);
        deposits = payouts.data
          .filter((p) => p.status === "pending" || p.status === "in_transit")
          .map((p) => ({
            id: p.id,
            amountCents: p.amount,
            status: p.status,
            arrival: new Date(p.arrival_date * 1000).toISOString(),
          }))
          .sort((a, b) => a.arrival.localeCompare(b.arrival));
      } catch {
        stripeError = "Stripe wouldn't answer — deposit dates are unavailable right now.";
      }
    }

    /* ----------------------------------------------------------- rent run -- */
    const contracts = await db.contract.findMany({
      where: { status: { in: ["ACTIVE", "TERMINATING"] } },
      include: { vendor: { select: { businessName: true, code: true } } },
      orderBy: { boothLabel: "asc" },
    });

    const runAt = nextRentRunDate(now);
    const ym = monthKey(runAt);

    const posted = await db.ledgerEntry.findMany({
      where: { type: "RENT", note: { contains: `[auto ${ym}` } },
      select: { vendorId: true, note: true },
    });
    const perVendor = new Map<string, number>();
    for (const c of contracts) perVendor.set(c.vendorId, (perVendor.get(c.vendorId) || 0) + 1);
    const legacy = legacyRentMarker(ym);
    const isCharged = (c: RentContract) =>
      posted.some((p) => p.note.includes(rentMarker(ym, c.id))) ||
      ((perVendor.get(c.vendorId) || 1) === 1 && posted.some((p) => p.vendorId === c.vendorId && p.note.includes(legacy)));

    const rows: RentContract[] = contracts.map((c) => ({
      id: c.id, vendorId: c.vendorId, boothLabel: c.boothLabel,
      monthlyRentCents: c.monthlyRentCents, status: c.status,
      endDate: c.endDate, paidThrough: c.paidThrough,
    }));
    const plan = planRentRun(rows, ym, runAt, isCharged);

    const nameOf = new Map<string, { businessName: string; code: string }>(
      contracts.map((c) => [c.id, { businessName: c.vendor.businessName, code: c.vendor.code }] as [string, { businessName: string; code: string }])
    );

    /* -------------------------------------------- days the market was shut -- */
    const opensAt = await getMarketOpensAt();
    const creditAppliedAt = await closedDayCreditAppliedAt();
    const closedDays = contracts.map((c) => ({
      contractId: c.id,
      vendorName: c.vendor.businessName,
      boothLabel: c.boothLabel,
      startDate: c.startDate.toISOString(),
      paidThrough: c.paidThrough ? c.paidThrough.toISOString() : null,
      monthlyRentCents: c.monthlyRentCents,
      days: closedDaysOwed(c.startDate, c.paidThrough, opensAt),
    })).filter((r) => r.days > 0);

    const closedDayCreditCents = closedDays.reduce(
      (n, r) => n + Math.round((r.monthlyRentCents * r.days) / 30),
      0
    );

    /* ------------------------------------------------------------ payouts -- */
    const payoutDay = await getPayoutDay();
    const payAt = nextPayoutDate(payoutDay, now);

    /* What the market owes vendors right now: every ledger balance in credit.
       A negative balance is a vendor who owes rent and is not a payout. */
    const balances = await db.ledgerEntry.groupBy({ by: ["vendorId"], _sum: { amountCents: true } });
    const activeVendors = await db.vendor.findMany({ where: { active: true }, select: { id: true, businessName: true, code: true, payoutsEnabled: true } });
    const activeIds = new Set(activeVendors.map((v) => v.id));
    const owedRows = balances
      .filter((b) => activeIds.has(b.vendorId) && (b._sum.amountCents || 0) > 0)
      .map((b) => {
        const v = activeVendors.find((x) => x.id === b.vendorId);
        return {
          vendorId: b.vendorId,
          vendorName: v?.businessName || "Unknown",
          vendorCode: v?.code || "",
          balanceCents: b._sum.amountCents || 0,
          payoutsEnabled: !!v?.payoutsEnabled,
        };
      })
      .sort((a, b) => b.balanceCents - a.balanceCents);

    const owedCents = owedRows.reduce((n, r) => n + r.balanceCents, 0);
    const notSetUpCents = owedRows.filter((r) => !r.payoutsEnabled).reduce((n, r) => n + r.balanceCents, 0);

    return NextResponse.json({
      now: now.toISOString(),
      stripeError,
      availableCents,
      deposits,
      depositTotalCents: deposits.reduce((n, d) => n + d.amountCents, 0),
      rent: {
        runAt: runAt.toISOString(),
        monthLabel: runAt.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
        totalCents: plan.totalCents,
        chargeCount: plan.chargeCount,
        lines: plan.rows
          .filter((r) => r.action !== "END")
          .map((r) => ({
            contractId: r.contractId,
            vendorName: nameOf.get(r.contractId)?.businessName || "Unknown vendor",
            vendorCode: nameOf.get(r.contractId)?.code || "",
            boothLabel: r.boothLabel,
            amountCents: r.amountCents,
            monthlyRentCents: r.monthlyRentCents,
            action: r.action,
            reason: r.reason,
          })),
      },
      closedDays: {
        opensAt: opensAt ? opensAt.toISOString() : null,
        appliedAt: creditAppliedAt ? creditAppliedAt.toISOString() : null,
        rows: closedDays,
        estimatedCreditCents: closedDayCreditCents,
      },
      payout: {
        day: payoutDay,
        nextAt: payAt ? payAt.toISOString() : null,
        owedCents,
        vendorCount: owedRows.length,
        notSetUpCents,
        rows: owedRows.slice(0, 50),
      },
    });
  });
}

/**
 * POST — set the calendar, or hand back the days the market was shut.
 *
 * `settings`   { marketOpensAt?, payoutDay? }
 * `credit`     applies the closed-day credit, once.
 */
export async function POST(req: Request) {
  return runRoute("admin/upcoming POST", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "settings") {
      if (body.marketOpensAt !== undefined) {
        const raw = String(body.marketOpensAt || "").trim();
        if (raw) {
          /* Noon, so the stored instant can't land on the previous day once a
             timezone is applied to it. */
          const d = new Date(`${raw}T12:00:00`);
          if (Number.isNaN(d.getTime())) return NextResponse.json({ error: "That isn't a date." }, { status: 400 });
          await setMarketOpensAt(d.toISOString());
        }
      }
      if (body.payoutDay !== undefined) await setPayoutDay(Number(body.payoutDay));

      await recordAudit(
        {
          action: "SETTING_CHANGE",
          targetType: "SETTING",
          targetId: "money-calendar",
          targetLabel: "Money calendar",
          detail: `Opening day ${body.marketOpensAt || "unchanged"}, payout day ${body.payoutDay ?? "unchanged"}`,
        },
        req
      );
      return NextResponse.json({ ok: true });
    }

    if (action === "credit") {
      const opensAt = await getMarketOpensAt();
      if (!opensAt) return NextResponse.json({ error: "Set the market's opening day first." }, { status: 400 });

      const already = await closedDayCreditAppliedAt();
      if (already && !body.again) {
        return NextResponse.json(
          { error: "That credit has already been given out. Applying it twice would credit everybody a second time." },
          { status: 409 }
        );
      }

      const contracts = await db.contract.findMany({ where: { status: { in: ["ACTIVE", "TERMINATING"] } } });
      const changes: { contractId: string; days: number; from: string; to: string }[] = [];

      for (const c of contracts) {
        const days = closedDaysOwed(c.startDate, c.paidThrough, opensAt);
        if (days <= 0 || !c.paidThrough) continue;
        const moved = creditedPaidThrough(c.paidThrough, days);
        if (!moved) continue;
        await db.contract.update({ where: { id: c.id }, data: { paidThrough: moved } });
        changes.push({
          contractId: c.id,
          days,
          from: c.paidThrough.toISOString(),
          to: moved.toISOString(),
        });
      }

      await markClosedDayCreditApplied();
      await recordAudit(
        {
          action: "SETTING_CHANGE",
          targetType: "SETTING",
          targetId: "closed-day-credit",
          targetLabel: "Closed-day rent credit",
          detail:
            `Credited closed days before ${opensAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ` +
            `on ${changes.length} ${changes.length === 1 ? "agreement" : "agreements"}: ` +
            changes.map((c) => `${c.contractId.slice(0, 8)} +${c.days}d`).join(", "),
        },
        req
      );

      return NextResponse.json({ ok: true, changed: changes.length, changes });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  });
}

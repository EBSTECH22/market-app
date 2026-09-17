import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { MONEY_OUT_ACTIONS } from "@/lib/auditkinds";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

/**
 * The activity log.
 *
 * Read-only on purpose — there is no PATCH or DELETE in this file and there
 * shouldn't be. A log anyone can edit answers no question worth asking.
 */
export async function GET(req: NextRequest) {
  return runRoute("admin/audit GET", async () => {
    /* "financials" rather than "ops": this log carries refunds, balance
       adjustments and staff account changes, which is not something a cashier
       should be able to read about their colleagues. */
    { const denied = await denyUnless("financials"); if (denied) return denied; }

    const p = req.nextUrl.searchParams;
    const days = Math.min(365, Math.max(1, Number(p.get("days") || 30)));
    const limit = Math.min(500, Math.max(1, Number(p.get("limit") || 200)));
    const action = p.get("action") || "";
    const q = (p.get("q") || "").trim();

    const where: Record<string, unknown> = { at: { gte: new Date(Date.now() - days * DAY_MS) } };
    if (action === "MONEY_OUT") where.action = { in: MONEY_OUT_ACTIONS };
    else if (action) where.action = action;
    if (q) {
      where.OR = [
        { actorName: { contains: q, mode: "insensitive" } },
        { targetLabel: { contains: q, mode: "insensitive" } },
        { detail: { contains: q, mode: "insensitive" } },
      ];
    }

    const events = await db.auditEvent.findMany({
      where,
      orderBy: { at: "desc" },
      take: limit,
      select: {
        id: true, at: true, actorType: true, actorName: true, actorRole: true,
        action: true, targetType: true, targetId: true, targetLabel: true,
        amountCents: true, detail: true, approvedBy: true,
      },
    });

    /* A running total of money handed back, so the log answers "how much went
       out the door this month" without exporting it to a spreadsheet. */
    const moneyOutCents = events
      .filter((e) => (MONEY_OUT_ACTIONS as string[]).includes(e.action))
      .reduce((n, e) => n + e.amountCents, 0);

    return NextResponse.json({ events, days, moneyOutCents, truncated: events.length >= limit });
  });
}

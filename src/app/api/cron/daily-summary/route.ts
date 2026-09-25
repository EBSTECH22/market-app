import { vendorGrossCents } from "@/lib/cardprice";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendDailySummaryEmail } from "@/lib/email";
import { TZ, centralDayStart } from "@/lib/time";
import { cronAuthFailure } from "@/lib/cron";
import { runRoute } from "@/lib/handler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Evening cron: one summary email per vendor who sold today and has NO push devices.
// Idempotent via a Setting flag per Central-time day.
export async function GET(req: NextRequest) {
  return runRoute("cron/daily-summary GET", async () => {
  const denied = cronAuthFailure(req);
  if (denied) return denied;

  const now = new Date();
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now); // YYYY-MM-DD
  const flag = `summary:${dayKey}`;
  if (await db.setting.findUnique({ where: { key: flag } })) {
    return NextResponse.json({ ok: true, skipped: "already sent today" });
  }

  const dayStart = centralDayStart(now);
  const sales = await db.sale.findMany({
    where: { createdAt: { gte: dayStart }, status: { not: "VOIDED" } },
    include: { lines: true },
  });
  const refunds = await db.refund.findMany({
    where: { createdAt: { gte: dayStart }, note: { not: { startsWith: "VOID" } } },
  });
  const vendors = await db.vendor.findMany({ where: { active: true } });
  const subs = await db.pushSub.groupBy({ by: ["vendorId"], _count: true });
  const hasPush = new Set(subs.map((s) => s.vendorId));

  const dayLabel = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: TZ });
  let sent = 0;

  for (const v of vendors) {
    if (hasPush.has(v.id) || !v.email) continue;

    const byItem: Record<string, { name: string; quantity: number; grossCents: number }> = {};
    let gross = 0, net = 0;
    for (const sale of sales) {
      for (const l of sale.lines) {
        if (l.vendorId !== v.id) continue;
        /* The vendor's own prices, without the market service fee. */
        const g = vendorGrossCents(l.vendorNetCents, v.commissionPercent || 0);
        gross += g; net += l.vendorNetCents;
        byItem[l.name] = byItem[l.name] || { name: l.name, quantity: 0, grossCents: 0 };
        byItem[l.name].quantity += l.quantity;
        byItem[l.name].grossCents += g;
      }
    }
    if (gross === 0) continue;

    // vendor-side refund reversals posted today (their net given back)
    const refundLedger = await db.ledgerEntry.aggregate({
      where: { vendorId: v.id, type: "REFUND", createdAt: { gte: dayStart } },
      _sum: { amountCents: true },
    });
    const refundBack = Math.abs(refundLedger._sum.amountCents || 0);
    void refunds;

    try {
      await sendDailySummaryEmail(v, dayLabel, Object.values(byItem), gross, net - refundBack, refundBack);
      sent++;
    } catch (err) {
      console.error("summary email failed", v.code, err);
    }
  }

  await db.setting.upsert({ where: { key: flag }, create: { key: flag, value: String(sent) }, update: { value: String(sent) } });
  return NextResponse.json({ ok: true, sent });
  });
}

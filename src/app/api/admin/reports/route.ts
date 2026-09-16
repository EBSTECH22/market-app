import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { TZ, centralDayStart, centralMonthStart, centralInputToDate } from "@/lib/time";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

function centralWeekStart(now = new Date()): Date {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(now);
  const idx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd);
  return new Date(centralDayStart(now).getTime() - idx * 24 * 60 * 60 * 1000);
}

export async function GET(req: NextRequest) {
  { const denied = await denyUnless("financials"); if (denied) return denied; }
  const p = req.nextUrl.searchParams;
  const period = p.get("period") || "day";
  const vendorId = p.get("vendor") || "all";
  const now = new Date();

  let start: Date, end = now;
  if (period === "custom") {
    start = p.get("from") ? centralInputToDate(`${p.get("from")}T00:00`) : new Date(0);
    end = p.get("to") ? new Date(centralInputToDate(`${p.get("to")}T00:00`).getTime() + 24 * 60 * 60 * 1000 - 1) : now;
  } else if (period === "week") start = centralWeekStart(now);
  else if (period === "month") start = centralMonthStart(now);
  else if (period === "quarter") {
    const m = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric" }).format(now)) - 1;
    const y = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" }).format(now);
    start = centralInputToDate(`${y}-${String(Math.floor(m / 3) * 3 + 1).padStart(2, "0")}-01T00:00`);
  } else if (period === "year") {
    const y = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" }).format(now);
    start = centralInputToDate(`${y}-01-01T00:00`);
  } else start = centralDayStart(now);

  const sales = await db.sale.findMany({
    where: { createdAt: { gte: start, lte: end }, status: { not: "VOIDED" } },
    include: { lines: true },
  });
  const refunds = await db.refund.findMany({ where: { createdAt: { gte: start, lte: end }, note: { not: { startsWith: "VOID" } } } });
  const vendors = await db.vendor.findMany({ select: { id: true, code: true, businessName: true, commissionPercent: true } });
  const vmap = new Map(vendors.map((v) => [v.id, v]));

  let gross = 0, tax = 0, cash = 0, card = 0, tickets = 0, vGross = 0, vNet = 0, units = 0;
  const byVendor: Record<string, number> = {};
  const byItem: Record<string, { q: number; c: number }> = {};
  const byHour: Record<number, number> = {};

  for (const s of sales) {
    const mine = vendorId === "all" ? s.lines : s.lines.filter((l) => l.vendorId === vendorId);
    if (!mine.length) continue;
    tickets++;
    if (vendorId === "all") {
      gross += s.subtotalCents; tax += s.taxCents;
      if (s.paymentMethod === "CASH") cash += s.totalCents; else card += s.totalCents;
    }
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(s.createdAt));
    for (const l of mine) {
      const lineGross = l.priceCents * l.quantity;
      vGross += lineGross; vNet += l.vendorNetCents; units += l.quantity;
      byVendor[l.vendorId] = (byVendor[l.vendorId] || 0) + lineGross;
      byItem[l.name] = byItem[l.name] || { q: 0, c: 0 };
      byItem[l.name].q += l.quantity; byItem[l.name].c += lineGross;
      byHour[hour] = (byHour[hour] || 0) + lineGross;
    }
  }

  // refunds reduce the period's money (voided sales are excluded entirely above)
  let refundTotal = 0;
  for (const r of refunds) {
    gross -= r.amountCents; tax -= r.taxCents;
    const back = r.amountCents + r.taxCents;
    refundTotal += back;
    if (r.method === "CASH") cash -= back; else card -= back;
  }

  return NextResponse.json({
    start, end, gross, tax, cash, card, tickets, refundTotal, vGross, vNet, units,
    byVendor: Object.entries(byVendor).map(([id, c]) => ({ vendor: vmap.get(id), cents: c })).sort((a, b) => b.cents - a.cents),
    byItem: Object.entries(byItem).map(([name, x]) => ({ name, ...x })).sort((a, b) => b.c - a.c).slice(0, 20),
    byHour,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { TZ } from "@/lib/time";
import { cronAuthFailure } from "@/lib/cron";
import { runRoute } from "@/lib/handler";

export const dynamic = "force-dynamic";

// Runs on Vercel Cron on the 1st of every month (see vercel.json).
// Idempotent: skips any contract already charged this month.
export async function GET(req: NextRequest) {
  return runRoute("cron/rent GET", async () => {
  const denied = cronAuthFailure(req);
  if (denied) return denied;

  const now = new Date();
  const ym = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(now); // "2026-10"
  const monthTag = `[auto ${ym}]`;

  const contracts = await db.contract.findMany({ where: { status: { in: ["ACTIVE", "TERMINATING"] } } });
  let charged = 0, ended = 0;

  for (const c of contracts) {
    // skip if this month's auto charge already posted
    const already = await db.ledgerEntry.findFirst({
      where: { vendorId: c.vendorId, type: "RENT", note: { contains: monthTag } },
    });

    // ended before this month began? just close it out
    const monthStartCentral = new Date(`${ym}-01T12:00:00`);
    if (c.endDate && c.endDate < monthStartCentral) {
      if (c.status !== "ENDED") { await db.contract.update({ where: { id: c.id }, data: { status: "ENDED" } }); ended++; }
      continue;
    }

    if (already) continue;

    let amount = c.monthlyRentCents;
    let note = `Monthly booth rent, booth ${c.boothLabel} ${monthTag}`;
    if (c.paidThrough) {
      // first full-month payment covered into this month: prorate the remainder, then normal months
      const ptYm = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(c.paidThrough);
      if (c.paidThrough >= monthStartCentral && ptYm === ym) {
        const dim = new Date(c.paidThrough.getFullYear(), c.paidThrough.getMonth() + 1, 0).getDate();
        const fromDay = c.paidThrough.getDate();
        amount = Math.round((c.monthlyRentCents * (dim - fromDay + 1)) / dim);
        note = `Second month rent, prorated from ${c.paidThrough.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ })} ${monthTag}`;
        await db.contract.update({ where: { id: c.id }, data: { paidThrough: null } });
      } else if (c.paidThrough > now) {
        continue; // still inside the paid first month
      } else {
        await db.contract.update({ where: { id: c.id }, data: { paidThrough: null } });
      }
    }
    if (c.status === "TERMINATING" && c.endDate) {
      const endsThisMonth =
        new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(c.endDate) === ym;
      if (endsThisMonth) {
        const dim = new Date(c.endDate.getFullYear(), c.endDate.getMonth() + 1, 0).getDate();
        amount = Math.round((c.monthlyRentCents * c.endDate.getDate()) / dim);
        note = `Final month rent, prorated to ${c.endDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ })} ${monthTag}`;
      }
    }

    if (amount > 0) {
      await db.ledgerEntry.create({ data: { vendorId: c.vendorId, type: "RENT", amountCents: -amount, note } });
      charged++;
    }
  }

  return NextResponse.json({ ok: true, charged, ended });
  });
}

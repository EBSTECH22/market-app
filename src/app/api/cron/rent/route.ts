import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { TZ } from "@/lib/time";

export const dynamic = "force-dynamic";

// Runs on Vercel Cron on the 1st of every month (see vercel.json).
// Idempotent: skips any contract already charged this month.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const isVercelCron = req.headers.get("user-agent")?.includes("vercel-cron");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}` && !isVercelCron) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
}

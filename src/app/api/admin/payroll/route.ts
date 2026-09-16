import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { centralInputToDate } from "@/lib/time";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD — hours, gross, deductions, net per employee
export async function GET(req: NextRequest) {
  { const denied = await denyUnless("people"); if (denied) return denied; }
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  if (!from || !to) return NextResponse.json({ error: "Pick a from and to date." }, { status: 400 });
  const start = centralInputToDate(`${from}T00:00`);
  const end = new Date(centralInputToDate(`${to}T00:00`).getTime() + 24 * 60 * 60 * 1000 - 1);

  const employees = await db.employee.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  const entries = await db.timeEntry.findMany({ where: { clockIn: { gte: start, lte: end } } });
  const deductions = await db.deduction.findMany({ where: { active: true } });

  const rows = employees.map((e) => {
    const mine = entries.filter((t) => t.employeeId === e.id && t.clockOut);
    const ms = mine.reduce((n, t) => n + (t.clockOut!.getTime() - t.clockIn.getTime()), 0);
    const hours = ms / 3600000;
    const grossCents = Math.round(hours * e.payRateCents);
    const myDeds = deductions.filter((d) => d.employeeId === e.id);
    const dedCents = grossCents > 0 ? myDeds.reduce((n, d) => n + d.amountCents, 0) : 0;
    return {
      id: e.id, name: e.name, payRateCents: e.payRateCents,
      hours: Math.round(hours * 100) / 100,
      grossCents, dedCents, netCents: grossCents - dedCents,
      deductions: myDeds.map((d) => ({ name: d.name, amountCents: d.amountCents })),
      openEntries: entries.filter((t) => t.employeeId === e.id && !t.clockOut).length,
    };
  });
  return NextResponse.json({ rows, from, to });
}

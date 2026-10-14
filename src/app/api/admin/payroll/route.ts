import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { centralInputToDate, TZ } from "@/lib/time";
import { periodFor, shiftDays as nextDayBy } from "@/lib/payperiod";

/** The calendar day after an ISO date, in plain date arithmetic. */
const nextDay = (iso: string) => nextDayBy(iso, 1);
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD — hours, gross, deductions, net per employee
export async function GET(req: NextRequest) {
  { const denied = await denyUnless("people"); if (denied) return denied; }
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  if (!from || !to) return NextResponse.json({ error: "Pick a from and to date." }, { status: 400 });
  /* CENTRAL MIDNIGHT TO CENTRAL MIDNIGHT, not "midnight plus 24 hours".
     
     A pay period ends on a Sunday, and in the US the clocks change on a
     Sunday. Adding a flat 24 hours to Central midnight is right for 363 days
     a year and wrong for the two that fall on the end of a period: the
     fall-back Sunday is 25 hours long, so +24h stops at 11pm and loses the
     last hour of somebody's shift; the spring-forward Sunday is 23 hours, so
     +24h runs an hour into Monday and pays it twice.
     
     Taking Central midnight of the NEXT day and stepping back a millisecond
     is correct every time, because the conversion does the offset itself. */
  const start = centralInputToDate(`${from}T00:00`);
  const end = new Date(centralInputToDate(`${nextDay(to)}T00:00`).getTime() - 1);

  const employees = await db.employee.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  const entries = await db.timeEntry.findMany({ where: { clockIn: { gte: start, lte: end } } });
  const deductions = await db.deduction.findMany({ where: { active: true } });

  /* Each punch, not just the total.
     
     A weekly total is what gets paid; the punches are what answers "why is
     Tuesday nine hours". Without them a disputed hour is one person's memory
     against another's, and the only record that could settle it is sitting in
     the database unread. */
  const dayOf = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
  const timeOf = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });

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
      punches: entries
        .filter((t) => t.employeeId === e.id)
        .sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime())
        .map((t) => ({
          id: t.id,
          day: dayOf(t.clockIn),
          inAt: timeOf(t.clockIn),
          outAt: t.clockOut ? timeOf(t.clockOut) : "",
          hours: t.clockOut ? Math.round(((t.clockOut.getTime() - t.clockIn.getTime()) / 3600000) * 100) / 100 : 0,
          note: t.note || "",
        })),
    };
  });

  /* The Friday they're actually paid, worked out from the period rather than
     left for somebody to count on their fingers. */
  const period = periodFor(from);
  const payDate = from === period.from && to === period.to ? period.payDate : "";

  return NextResponse.json({ rows, from, to, payDate });
}

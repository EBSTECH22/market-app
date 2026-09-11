import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentEmployeeId, isAdmin } from "@/lib/auth";
import { TZ } from "@/lib/time";

export const dynamic = "force-dynamic";

// GET: my clock status + this week's entries. Employees see their own; admin passes ?employeeId=
export async function GET(req: NextRequest) {
  const myId = currentEmployeeId();
  const qId = req.nextUrl.searchParams.get("employeeId");
  const employeeId = isAdmin() && qId ? qId : myId;
  if (!employeeId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const open = await db.timeEntry.findFirst({ where: { employeeId, clockOut: null }, orderBy: { clockIn: "desc" } });
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const entries = await db.timeEntry.findMany({
    where: { employeeId, clockIn: { gte: since } },
    orderBy: { clockIn: "desc" },
    take: 40,
  });
  return NextResponse.json({
    open,
    entries: entries.map((e) => ({
      ...e,
      dayStr: e.clockIn.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ }),
      inStr: e.clockIn.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }),
      outStr: e.clockOut ? e.clockOut.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }) : null,
      hours: e.clockOut ? (e.clockOut.getTime() - e.clockIn.getTime()) / 3600000 : null,
    })),
  });
}

// POST { action: "in" | "out" } — employee clocks themselves
export async function POST(req: NextRequest) {
  const employeeId = currentEmployeeId();
  if (!employeeId) return NextResponse.json({ error: "Sign in as an employee to clock time." }, { status: 401 });
  const { action } = await req.json();
  const open = await db.timeEntry.findFirst({ where: { employeeId, clockOut: null } });

  if (action === "in") {
    if (open) return NextResponse.json({ error: "Already clocked in." }, { status: 400 });
    const entry = await db.timeEntry.create({ data: { employeeId } });
    return NextResponse.json({ entry });
  }
  if (action === "out") {
    if (!open) return NextResponse.json({ error: "Not clocked in." }, { status: 400 });
    const entry = await db.timeEntry.update({ where: { id: open.id }, data: { clockOut: new Date() } });
    return NextResponse.json({ entry });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

// PATCH — admin fixes a forgotten punch: { id, clockIn?, clockOut? } ISO strings
export async function PATCH(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, clockIn, clockOut } = await req.json();
  const data: { clockIn?: Date; clockOut?: Date | null } = {};
  if (clockIn) data.clockIn = new Date(clockIn);
  if (clockOut !== undefined) data.clockOut = clockOut ? new Date(clockOut) : null;
  const entry = await db.timeEntry.update({ where: { id }, data });
  return NextResponse.json({ entry });
}

// DELETE ?id= — admin removes a bad entry
export async function DELETE(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "No id." }, { status: 400 });
  await db.timeEntry.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

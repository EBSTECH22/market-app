import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentEmployeeId, isAdmin } from "@/lib/auth";
import { TZ, centralInputToDate } from "@/lib/time";

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

/**
 * PUT — the admin ADDS a punch that never happened.
 *
 * { employeeId, day: "YYYY-MM-DD", inAt: "HH:MM", outAt: "HH:MM", note? }
 *
 * PATCH below can only correct a punch that exists. Somebody who never
 * clocked in at all had no row to correct, so there was no way to pay them for
 * a shift they actually worked short of editing the database — which is how
 * hours get paid off a sticky note.
 *
 * Times are read in MARKET time, not the server's. A shift typed as 9:00 to
 * 5:00 has to mean nine in the morning in Noble whatever timezone Vercel
 * happens to be running in.
 */
export async function PUT(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { employeeId, day, inAt, outAt, note } = await req.json();
  if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) {
    return NextResponse.json({ error: "Pick the person and the day." }, { status: 400 });
  }
  if (!/^\d{1,2}:\d{2}$/.test(String(inAt || ""))) {
    return NextResponse.json({ error: "Start time looks like 9:00 or 14:30." }, { status: 400 });
  }
  const emp = await db.employee.findUnique({ where: { id: String(employeeId) }, select: { id: true } });
  if (!emp) return NextResponse.json({ error: "Employee not found." }, { status: 404 });

  const pad = (t: string) => (t.length === 4 ? `0${t}` : t);
  const clockIn = centralInputToDate(`${day}T${pad(String(inAt))}`);
  let clockOut: Date | null = null;
  if (outAt) {
    if (!/^\d{1,2}:\d{2}$/.test(String(outAt))) {
      return NextResponse.json({ error: "End time looks like 17:00 or 5:30." }, { status: 400 });
    }
    clockOut = centralInputToDate(`${day}T${pad(String(outAt))}`);
    /* A shift that ends before it starts crossed midnight — the end belongs
       to the next day. Refusing it would be right about the data and useless
       to whoever closed up at one in the morning. */
    if (clockOut.getTime() <= clockIn.getTime()) clockOut = new Date(clockOut.getTime() + 24 * 60 * 60 * 1000);
    if (clockOut.getTime() - clockIn.getTime() > 20 * 60 * 60 * 1000) {
      return NextResponse.json({ error: "That shift is over 20 hours — check the times." }, { status: 400 });
    }
  }

  const entry = await db.timeEntry.create({
    data: {
      employeeId: String(employeeId),
      clockIn,
      clockOut,
      note: String(note || "Entered by the office").slice(0, 120),
    },
  });
  return NextResponse.json({ entry });
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

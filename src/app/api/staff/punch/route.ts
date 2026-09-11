import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isStaff } from "@/lib/auth";
import { createHash } from "crypto";
import { TZ } from "@/lib/time";

export const dynamic = "force-dynamic";

const pinHash = (pin: string) => createHash("sha256").update(`pin:${pin}`).digest("hex");

// Kiosk punch from the register: any employee, PIN each time. Toggles in/out.
export async function POST(req: NextRequest) {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name, pin } = await req.json();
  const emp = await db.employee.findUnique({ where: { name: (name || "").trim() } });
  if (!emp || !emp.active || emp.pinHash !== pinHash(pin || "")) {
    return NextResponse.json({ error: "Wrong name or PIN." }, { status: 401 });
  }
  const open = await db.timeEntry.findFirst({ where: { employeeId: emp.id, clockOut: null }, orderBy: { clockIn: "desc" } });
  if (!open) {
    const entry = await db.timeEntry.create({ data: { employeeId: emp.id } });
    return NextResponse.json({
      punched: "IN",
      msg: `${emp.name} clocked IN at ${entry.clockIn.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ })}.`,
    });
  }
  const entry = await db.timeEntry.update({ where: { id: open.id }, data: { clockOut: new Date() } });
  const hrs = (entry.clockOut!.getTime() - entry.clockIn.getTime()) / 3600000;
  return NextResponse.json({
    punched: "OUT",
    msg: `${emp.name} clocked OUT — ${hrs.toFixed(2)} hrs this shift.`,
  });
}

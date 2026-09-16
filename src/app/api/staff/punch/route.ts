import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isStaff, verifyPin, pinUpgrade } from "@/lib/auth";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";
import { TZ } from "@/lib/time";

export const dynamic = "force-dynamic";

// Kiosk punch from the register: any employee, PIN each time. Toggles in/out.
export async function POST(req: NextRequest) {
  return runRoute("staff/punch POST", async () => {
    if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { name, pin } = await req.json();
    const who = String(name || "").trim();

    const limited = enforceRateLimit(req, "staff-punch", who, LIMITS.pin, "Too many PIN attempts.");
    if (limited) return limited;

    const emp = await db.employee.findUnique({ where: { name: who } });
    if (!emp || !emp.active || !verifyPin(String(pin || ""), emp.pinHash)) {
      return NextResponse.json({ error: "Wrong name or PIN." }, { status: 401 });
    }
    const upgraded = pinUpgrade(String(pin || ""), emp.pinHash);
    if (upgraded) {
      try {
        await db.employee.update({ where: { id: emp.id }, data: { pinHash: upgraded } });
      } catch (err) {
        console.error("pin hash upgrade failed", err);
      }
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
  });
}

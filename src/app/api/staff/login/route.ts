import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { staffCookie, verifyPin, pinUpgrade, SESSION_COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS } from "@/lib/auth";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";

export async function POST(req: NextRequest) {
  return runRoute("staff/login POST", async () => {
    const { name, pin } = await req.json();
    const who = String(name || "").trim();

    const limited = await enforceRateLimit(req, "staff-login", who, LIMITS.pin, "Too many PIN attempts.");
    if (limited) return limited;

    const emp = await db.employee.findUnique({ where: { name: who } });
    if (!emp || !emp.active || !verifyPin(String(pin || ""), emp.pinHash)) {
      return NextResponse.json({ error: "Wrong name or PIN." }, { status: 401 });
    }
    // legacy unsalted sha256 PIN verified — quietly re-store it as salted scrypt
    const upgraded = pinUpgrade(String(pin || ""), emp.pinHash);
    if (upgraded) {
      try {
        await db.employee.update({ where: { id: emp.id }, data: { pinHash: upgraded } });
      } catch (err) {
        console.error("pin hash upgrade failed", err);
      }
    }

    const res = NextResponse.json({ ok: true, employee: { id: emp.id, name: emp.name } });
    const c = staffCookie(emp.id);
    res.cookies.set(c.name, c.value, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_SECONDS.staff });
    return res;
  });
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("nm_staff", "", { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
  return res;
}

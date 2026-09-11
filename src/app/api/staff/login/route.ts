import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { staffCookie } from "@/lib/auth";
import { createHash } from "crypto";

const pinHash = (pin: string) => createHash("sha256").update(`pin:${pin}`).digest("hex");

export async function POST(req: NextRequest) {
  const { name, pin } = await req.json();
  const emp = await db.employee.findUnique({ where: { name: (name || "").trim() } });
  if (!emp || !emp.active || emp.pinHash !== pinHash(pin || "")) {
    return NextResponse.json({ error: "Wrong name or PIN." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, employee: { id: emp.id, name: emp.name } });
  const c = staffCookie(emp.id);
  res.cookies.set(c.name, c.value, { httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 14 });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("nm_staff", "", { maxAge: 0 });
  return res;
}

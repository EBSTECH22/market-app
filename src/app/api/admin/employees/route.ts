import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPin } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

export async function GET() {
  /* "ops", not "people": this is the name list the register's time clock fills
     its dropdown from, so gating it to owners would stop every employee
     punching in. The select is names only — no pay rates, no PIN hashes. */
  { const denied = await denyUnless("ops"); if (denied) return denied; }
  const employees = await db.employee.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  return NextResponse.json({ employees });
}

export async function POST(req: NextRequest) {
  return runRoute("admin/employees POST", async () => {
    { const denied = await denyUnless("people"); if (denied) return denied; }
    const { name, pin } = await req.json();
    if (!name?.trim() || !/^\d{4,6}$/.test(pin || "")) {
      return NextResponse.json({ error: "Name and a 4-6 digit PIN required." }, { status: 400 });
    }
    // new/changed PINs are always stored salted (scrypt) — see verifyPin in lib/auth
    const employee = await db.employee.upsert({
      where: { name: name.trim() },
      create: { name: name.trim(), pinHash: hashPin(pin) },
      update: { pinHash: hashPin(pin), active: true },
    });
    return NextResponse.json({ employee: { id: employee.id, name: employee.name } });
  });
}

export async function DELETE(req: NextRequest) {
  { const denied = await denyUnless("people"); if (denied) return denied; }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "No id." }, { status: 400 });
  await db.employee.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ ok: true });
}


import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin, isStaff, hashPin } from "@/lib/auth";
import { runRoute } from "@/lib/handler";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const employees = await db.employee.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  return NextResponse.json({ employees });
}

export async function POST(req: NextRequest) {
  return runRoute("admin/employees POST", async () => {
    if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "No id." }, { status: 400 });
  await db.employee.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ ok: true });
}


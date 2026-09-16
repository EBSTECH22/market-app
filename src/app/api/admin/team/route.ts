import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

// GET: full team roster with pay, W-4 elections, deductions, doc list (no file data)
export async function GET() {
  { const denied = await denyUnless("people"); if (denied) return denied; }
  const employees = await db.employee.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  const deductions = await db.deduction.findMany({ where: { active: true } });
  const docs = await db.employeeDoc.findMany({ select: { id: true, employeeId: true, kind: true, filename: true, createdAt: true }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({
    employees: employees.map((e) => ({
      id: e.id, name: e.name, payRateCents: e.payRateCents, w4: JSON.parse(e.w4Json || "{}"),
      deductions: deductions.filter((d) => d.employeeId === e.id),
      docs: docs.filter((d) => d.employeeId === e.id),
    })),
  });
}

// PATCH { employeeId, payRateDollars?, w4? }
export async function PATCH(req: NextRequest) {
  { const denied = await denyUnless("people"); if (denied) return denied; }
  const { employeeId, payRateDollars, w4 } = await req.json();
  const data: { payRateCents?: number; w4Json?: string } = {};
  if (payRateDollars !== undefined) {
    const c = Math.round(Number(payRateDollars) * 100);
    if (isNaN(c) || c < 0) return NextResponse.json({ error: "Bad pay rate." }, { status: 400 });
    data.payRateCents = c;
  }
  if (w4 !== undefined) data.w4Json = JSON.stringify(w4 || {});
  const employee = await db.employee.update({ where: { id: employeeId }, data });
  return NextResponse.json({ ok: true, employee: { id: employee.id } });
}

// POST — add a recurring per-paycheck deduction { employeeId, name, amountDollars }
export async function POST(req: NextRequest) {
  { const denied = await denyUnless("people"); if (denied) return denied; }
  const { employeeId, name, amountDollars } = await req.json();
  const cents = Math.round(Number(amountDollars) * 100);
  if (!name?.trim() || isNaN(cents) || cents <= 0) {
    return NextResponse.json({ error: "Deduction needs a name and a positive amount." }, { status: 400 });
  }
  const deduction = await db.deduction.create({ data: { employeeId, name: name.trim(), amountCents: cents } });
  return NextResponse.json({ deduction });
}

// DELETE ?id= — retire a deduction
export async function DELETE(req: NextRequest) {
  { const denied = await denyUnless("people"); if (denied) return denied; }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "No id." }, { status: 400 });
  await db.deduction.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ ok: true });
}

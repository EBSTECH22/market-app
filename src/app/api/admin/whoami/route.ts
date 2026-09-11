import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin, currentEmployeeId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isAdmin()) return NextResponse.json({ role: "admin" });
  const empId = currentEmployeeId();
  if (empId) {
    const emp = await db.employee.findUnique({ where: { id: empId }, select: { name: true, active: true } });
    if (emp?.active) return NextResponse.json({ role: "staff", name: emp.name });
  }
  return NextResponse.json({ role: null }, { status: 401 });
}

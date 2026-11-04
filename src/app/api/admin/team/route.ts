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
      id: e.id, name: e.name, payRateCents: e.payRateCents,
      payType: e.payType,
      /* The W-4 as real fields. `w4Notes` is the old free-text blob, carried
         so anything typed before these fields existed is still readable. */
      w4: {
        fedFilingStatus: e.fedFilingStatus,
        fedStep2: e.fedStep2,
        fedDependentsCents: e.fedDependentsCents,
        fedOtherIncomeCents: e.fedOtherIncomeCents,
        fedDeductionsCents: e.fedDeductionsCents,
        fedExtraCents: e.fedExtraCents,
        okFilingStatus: e.okFilingStatus,
        okAllowances: e.okAllowances,
        okExtraCents: e.okExtraCents,
      },
      w4Notes: JSON.parse(e.w4Json || "{}"),
      /* Never the PIN — it is a one-way hash and there is nothing to send.
         Only whether one exists and when it was last set. */
      hasPin: !!e.pinHash,
      pinSetAt: e.pinSetAt,
      deductions: deductions.filter((d) => d.employeeId === e.id),
      docs: docs.filter((d) => d.employeeId === e.id),
    })),
  });
}

// PATCH { employeeId, payRateDollars?, payType?, w4?: { ...fields } }
export async function PATCH(req: NextRequest) {
  { const denied = await denyUnless("people"); if (denied) return denied; }
  const body = await req.json();
  const { employeeId, payRateDollars, payType, w4 } = body;

  const data: Record<string, unknown> = {};
  if (payRateDollars !== undefined) {
    const c = Math.round(Number(payRateDollars) * 100);
    if (isNaN(c) || c < 0) return NextResponse.json({ error: "Bad pay rate." }, { status: 400 });
    data.payRateCents = c;
  }
  if (payType !== undefined) {
    if (payType !== "W2" && payType !== "CONTRACTOR") {
      return NextResponse.json({ error: "Pay type is W2 or CONTRACTOR." }, { status: 400 });
    }
    data.payType = payType;
  }

  /* THE W-4, FIELD BY FIELD, EACH VALIDATED.
  
     Written as columns rather than a JSON blob because withholding reads them:
     a filing status that arrives as "single " or "Single" or an empty string
     is a filing status the engine can't use, and the point of failure would be
     somebody's paycheck rather than this request. Anything unrecognised is
     refused here instead. */
  if (w4 && typeof w4 === "object") {
    const cents = (v: unknown, label: string): number | { error: string } => {
      if (v === undefined) return 0;
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 0) return { error: `${label} has to be a positive amount.` };
      return n;
    };
    if (w4.fedFilingStatus !== undefined) {
      if (!["SINGLE", "MFJ", "HOH"].includes(w4.fedFilingStatus)) {
        return NextResponse.json({ error: "Federal filing status is Single, Married filing jointly, or Head of household." }, { status: 400 });
      }
      data.fedFilingStatus = w4.fedFilingStatus;
    }
    if (w4.fedStep2 !== undefined) data.fedStep2 = !!w4.fedStep2;
    for (const [key, label] of [
      ["fedDependentsCents", "The dependant credit"],
      ["fedOtherIncomeCents", "Other income"],
      ["fedDeductionsCents", "Deductions"],
      ["fedExtraCents", "Extra withholding"],
      ["okExtraCents", "Extra Oklahoma withholding"],
    ] as const) {
      if (w4[key] !== undefined) {
        const v = cents(w4[key], label);
        if (typeof v !== "number") return NextResponse.json(v, { status: 400 });
        data[key] = v;
      }
    }
    if (w4.okFilingStatus !== undefined) {
      if (!["SINGLE", "MARRIED"].includes(w4.okFilingStatus)) {
        return NextResponse.json({ error: "Oklahoma filing status is Single or Married." }, { status: 400 });
      }
      data.okFilingStatus = w4.okFilingStatus;
    }
    if (w4.okAllowances !== undefined) {
      const n = Math.round(Number(w4.okAllowances));
      if (!Number.isFinite(n) || n < 0 || n > 99) {
        return NextResponse.json({ error: "Allowances are a whole number from 0 to 99." }, { status: 400 });
      }
      data.okAllowances = n;
    }
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
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

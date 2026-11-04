import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { denyUnless } from "@/lib/perm";
import { runRoute } from "@/lib/handler";
import { recordAudit, currentAuditActor } from "@/lib/audit";
import { centralInputToDate, centralDayEnd } from "@/lib/time";
import { periodFor } from "@/lib/payperiod";
import { buildStub, DEFAULT_W4, isComplete, type Stub, type W4 } from "@/lib/paystub";
import { YEAR as TAX_YEAR, type FilingStatus, type OkStatus } from "@/lib/taxtables";

export const dynamic = "force-dynamic";

/**
 * Running payroll.
 *
 * GET  ?from=YYYY-MM-DD        → the run for that period, drafting one in
 *                                memory if none has been started
 * POST { from }                → start the run (writes the draft stubs)
 * PATCH { stubId, ... }        → type over anything on one stub
 * PATCH { runId, action:"pay" }→ freeze the run and stamp year-to-date
 * DELETE ?runId=               → throw a draft away
 *
 * WHY A DRAFT IS WRITTEN RATHER THAN COMPUTED EVERY TIME: the office corrects
 * hours, types a withholding the tables don't cover, adds a bonus. Those edits
 * have to survive a page reload, so they need somewhere to live. The draft is
 * that place, and until it is paid it can be rebuilt from the clock at a
 * button press.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function w4Of(e: {
  fedFilingStatus: string; fedStep2: boolean; fedDependentsCents: number;
  fedOtherIncomeCents: number; fedDeductionsCents: number; fedExtraCents: number;
  okFilingStatus: string; okAllowances: number; okExtraCents: number;
}): W4 {
  const fed = ["SINGLE", "MFJ", "HOH"].includes(e.fedFilingStatus) ? (e.fedFilingStatus as FilingStatus) : "SINGLE";
  const ok = e.okFilingStatus === "MARRIED" ? "MARRIED" : "SINGLE";
  return {
    fedFilingStatus: fed,
    fedStep2: !!e.fedStep2,
    fedDependentsCents: e.fedDependentsCents || 0,
    fedOtherIncomeCents: e.fedOtherIncomeCents || 0,
    fedDeductionsCents: e.fedDeductionsCents || 0,
    fedExtraCents: e.fedExtraCents || 0,
    okFilingStatus: ok as OkStatus,
    okAllowances: e.okAllowances || 0,
    okExtraCents: e.okExtraCents || 0,
  };
}

/**
 * Hours on the clock for a period, per employee, in hundredths of an hour.
 *
 * Central midnight to Central midnight, taken as "the next day's midnight
 * minus a millisecond" rather than "midnight plus 24 hours" — a pay period
 * ends on a Sunday and so do the clock changes, so the fall-back Sunday is 25
 * hours long and +24h would lose the last hour of somebody's shift.
 */
async function clockHours(from: string, to: string) {
  const start = centralInputToDate(`${from}T00:00`);
  const end = centralDayEnd(to);
  const entries = await db.timeEntry.findMany({ where: { clockIn: { gte: start, lte: end } } });

  const hundredths = new Map<string, number>();
  const open = new Map<string, number>();
  for (const e of entries) {
    if (!e.clockOut) { open.set(e.employeeId, (open.get(e.employeeId) || 0) + 1); continue; }
    const hh = Math.round(((e.clockOut.getTime() - e.clockIn.getTime()) / 3600000) * 100);
    hundredths.set(e.employeeId, (hundredths.get(e.employeeId) || 0) + Math.max(0, hh));
  }
  return { hundredths, open, entries };
}

/** Everything already paid this calendar year, for the year-to-date columns. */
async function ytdBefore(year: number, beforeRunId: string | null) {
  const stubs = await db.paystub.findMany({
    where: {
      payRun: { status: "PAID", taxYear: year, ...(beforeRunId ? { id: { not: beforeRunId } } : {}) },
    },
    select: {
      employeeId: true, grossCents: true, ssCents: true, medicareCents: true,
      federalCents: true, stateCents: true, netCents: true,
    },
  });
  const map = new Map<string, { gross: number; ss: number; med: number; fed: number; state: number; net: number }>();
  for (const s of stubs) {
    const cur = map.get(s.employeeId) || { gross: 0, ss: 0, med: 0, fed: 0, state: 0, net: 0 };
    cur.gross += s.grossCents; cur.ss += s.ssCents; cur.med += s.medicareCents;
    cur.fed += s.federalCents; cur.state += s.stateCents; cur.net += s.netCents;
    map.set(s.employeeId, cur);
  }
  return map;
}

const shape = (s: {
  id: string; employeeId: string; employeeName: string; hourHundredths: number; rateCents: number;
  grossCents: number; ssCents: number; medicareCents: number; federalCents: number; stateCents: number;
  otherDedCents: number; netCents: number; ytdGrossCents: number; ytdNetCents: number;
  manualJson: string; missingJson: string; deductionsJson: string; hoursFromClock: boolean; note: string;
}) => ({
  ...s,
  manual: JSON.parse(s.manualJson || "[]") as string[],
  missing: JSON.parse(s.missingJson || "[]") as string[],
  deductions: JSON.parse(s.deductionsJson || "[]") as { name: string; amountCents: number }[],
});

export async function GET(req: NextRequest) {
  return runRoute("admin/payrun GET", async () => {
    { const denied = await denyUnless("people"); if (denied) return denied; }
    const from = (req.nextUrl.searchParams.get("from") || "").trim();
    if (!DAY.test(from)) return NextResponse.json({ error: "Pick a week." }, { status: 400 });

    const period = periodFor(from);
    const existing = await db.payRun.findUnique({
      where: { periodFrom: period.from },
      include: { stubs: { orderBy: { employeeName: "asc" } } },
    });

    const { hundredths, open } = await clockHours(period.from, period.to);
    const employees = await db.employee.findMany({ where: { active: true }, orderBy: { name: "asc" } });
    const deductions = await db.deduction.findMany({ where: { active: true } });

    if (existing) {
      return NextResponse.json({
        period, taxYear: TAX_YEAR,
        run: {
          id: existing.id, status: existing.status, payDate: existing.payDate,
          taxYear: existing.taxYear, periodsPerYear: existing.periodsPerYear,
          paidAt: existing.paidAt, paidBy: existing.paidBy, note: existing.note,
        },
        /* payType comes off the employee, not the stub — so a 1099 row is
           labelled on a started run the same way it is on the preview.
           Without it the badge only appeared before the run existed. */
        rows: existing.stubs.map((st) => ({
          ...shape(st),
          payType: employees.find((e) => e.id === st.employeeId)?.payType || "W2",
        })),
        clockHundredths: Object.fromEntries(hundredths),
        openPunches: Object.fromEntries(open),
        canPay: existing.status === "DRAFT" && existing.stubs.every((s) => (JSON.parse(s.missingJson || "[]") as string[]).length === 0),
      });
    }

    /* No run started yet — show what one WOULD look like, without writing
       anything. Opening the screen must not create records. */
    const ytd = await ytdBefore(TAX_YEAR, null);
    const preview = employees.map((e) => {
      const hh = hundredths.get(e.id) || 0;
      const mine = deductions.filter((d) => d.employeeId === e.id);
      const prior = ytd.get(e.id) || { gross: 0, ss: 0, med: 0, fed: 0, state: 0, net: 0 };
      const stub = buildStub({
        hourHundredths: hh,
        rateCents: e.payRateCents,
        periodsPerYear: 52,
        w4: e.payType === "W2" ? w4Of(e) : DEFAULT_W4,
        otherDeductionsCents: hh > 0 ? mine.reduce((n, d) => n + d.amountCents, 0) : 0,
        ytdGrossCents: prior.gross,
        ytdSsWagesCents: prior.gross,
      });
      /* The stub is spread FIRST and the identity fields added after, so
         nothing it carries can be silently overwritten by a duplicate — the
         hours and rate it was built with are the ones to report.

         `otherDedCents` is renamed on the way out: the engine calls it
         `otherDeductionsCents` and the screen (and the stored row) call it
         `otherDedCents`. Spreading alone left it undefined on the preview,
         which rendered as NaN in the deductions box. */
      const { otherDeductionsCents, totalWithheldCents, ...rest } = stub;
      void totalWithheldCents;
      return {
        ...rest,
        otherDedCents: otherDeductionsCents,
        employeeId: e.id,
        employeeName: e.name,
        payType: e.payType,
        deductions: mine.map((d) => ({ name: d.name, amountCents: d.amountCents })),
      };
    });

    return NextResponse.json({
      period, taxYear: TAX_YEAR, run: null, preview,
      clockHundredths: Object.fromEntries(hundredths),
      openPunches: Object.fromEntries(open),
    });
  });
}

/** Start the run — turn the preview into real draft stubs. */
export async function POST(req: NextRequest) {
  return runRoute("admin/payrun POST", async () => {
    { const denied = await denyUnless("people"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const from = String(body.from || "").trim();
    if (!DAY.test(from)) return NextResponse.json({ error: "Pick a week." }, { status: 400 });

    const period = periodFor(from);
    const already = await db.payRun.findUnique({ where: { periodFrom: period.from } });
    if (already) return NextResponse.json({ error: "That week already has a run." }, { status: 409 });

    const actor = await currentAuditActor();
    const { hundredths } = await clockHours(period.from, period.to);
    const employees = await db.employee.findMany({ where: { active: true }, orderBy: { name: "asc" } });
    const deductions = await db.deduction.findMany({ where: { active: true } });
    const ytd = await ytdBefore(TAX_YEAR, null);

    const run = await db.payRun.create({
      data: {
        periodFrom: period.from, periodTo: period.to, payDate: period.payDate,
        taxYear: TAX_YEAR, periodsPerYear: 52, createdBy: actor.actorName,
      },
    });

    for (const e of employees) {
      const hh = hundredths.get(e.id) || 0;
      const mine = deductions.filter((d) => d.employeeId === e.id);
      const prior = ytd.get(e.id) || { gross: 0, ss: 0, med: 0, fed: 0, state: 0, net: 0 };
      const w4 = e.payType === "W2" ? w4Of(e) : DEFAULT_W4;
      /* A contractor has nothing withheld — the stub is a record of gross. */
      const stub: Stub = e.payType === "W2"
        ? buildStub({
            hourHundredths: hh, rateCents: e.payRateCents, periodsPerYear: 52, w4,
            otherDeductionsCents: hh > 0 ? mine.reduce((n, d) => n + d.amountCents, 0) : 0,
            ytdGrossCents: prior.gross, ytdSsWagesCents: prior.gross,
          })
        : buildStub({
            hourHundredths: hh, rateCents: e.payRateCents, periodsPerYear: 52, w4,
            otherDeductionsCents: 0, ytdGrossCents: prior.gross, ytdSsWagesCents: prior.gross,
            overrides: { ssCents: 0, medicareCents: 0, federalCents: 0, stateCents: 0 },
          });

      await db.paystub.create({
        data: {
          payRunId: run.id, employeeId: e.id, employeeName: e.name,
          hourHundredths: hh, rateCents: e.payRateCents, grossCents: stub.grossCents,
          ssCents: stub.ssCents, medicareCents: stub.medicareCents,
          federalCents: stub.federalCents, stateCents: stub.stateCents,
          otherDedCents: stub.otherDeductionsCents, netCents: stub.netCents,
          w4Json: JSON.stringify(w4),
          deductionsJson: JSON.stringify(mine.map((d) => ({ name: d.name, amountCents: d.amountCents }))),
          manualJson: JSON.stringify(e.payType === "W2" ? stub.manual : []),
          missingJson: JSON.stringify(e.payType === "W2" ? stub.missing : []),
          hoursFromClock: true,
        },
      });
    }

    await recordAudit(
      { action: "SETTING_CHANGE", targetType: "PAYRUN", targetId: run.id,
        targetLabel: `${period.from} – ${period.to}`,
        detail: `Payroll run started for ${period.label} — ${employees.length} on the roster` },
      req
    );
    return NextResponse.json({ ok: true, runId: run.id });
  });
}

export async function PATCH(req: NextRequest) {
  return runRoute("admin/payrun PATCH", async () => {
    { const denied = await denyUnless("people"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));

    /* ---- pay it, or reopen it ------------------------------------------- */
    if (body.action === "pay" || body.action === "reopen") {
      const runId = String(body.runId || "");
      const run = await db.payRun.findUnique({ where: { id: runId }, include: { stubs: true } });
      if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
      const actor = await currentAuditActor();

      if (body.action === "reopen") {
        if (run.status !== "PAID") return NextResponse.json({ error: "That run isn't paid." }, { status: 400 });
        await db.payRun.update({ where: { id: runId }, data: { status: "DRAFT", paidAt: null, paidBy: "" } });
        await recordAudit(
          { action: "SETTING_CHANGE", targetType: "PAYRUN", targetId: runId,
            targetLabel: `${run.periodFrom} – ${run.periodTo}`,
            detail: `Payroll run reopened for editing by ${actor.actorName}` },
          req
        );
        return NextResponse.json({ ok: true });
      }

      if (run.status === "PAID") return NextResponse.json({ error: "Already paid." }, { status: 400 });
      /* A stub with a withholding nobody has supplied must not be paid — the
         net on it is too big by exactly the amount nobody worked out. */
      const unfinished = run.stubs.filter((s) => (JSON.parse(s.missingJson || "[]") as string[]).length > 0);
      if (unfinished.length > 0) {
        return NextResponse.json(
          { error: `${unfinished.length} ${unfinished.length === 1 ? "paystub still needs" : "paystubs still need"} a figure entering: ${unfinished.map((s) => s.employeeName).join(", ")}.` },
          { status: 400 }
        );
      }

      /* Year-to-date is stamped at the moment of payment, from every other
         PAID run in the same tax year plus this one. Computed here rather
         than kept running, so a reopened and corrected run can't leave the
         totals drifting. */
      const prior = await ytdBefore(run.taxYear, run.id);
      for (const s of run.stubs) {
        const p = prior.get(s.employeeId) || { gross: 0, ss: 0, med: 0, fed: 0, state: 0, net: 0 };
        await db.paystub.update({
          where: { id: s.id },
          data: {
            ytdGrossCents: p.gross + s.grossCents,
            ytdSsCents: p.ss + s.ssCents,
            ytdMedicareCents: p.med + s.medicareCents,
            ytdFederalCents: p.fed + s.federalCents,
            ytdStateCents: p.state + s.stateCents,
            ytdNetCents: p.net + s.netCents,
          },
        });
      }
      await db.payRun.update({ where: { id: runId }, data: { status: "PAID", paidAt: new Date(), paidBy: actor.actorName } });

      const total = run.stubs.reduce((n, s) => n + s.netCents, 0);
      await recordAudit(
        { action: "SETTING_CHANGE", targetType: "PAYRUN", targetId: runId,
          targetLabel: `${run.periodFrom} – ${run.periodTo}`,
          amountCents: -total,
          detail: `Payroll paid for ${run.periodFrom} – ${run.periodTo}: ${run.stubs.length} ${run.stubs.length === 1 ? "paystub" : "paystubs"}, $${(total / 100).toFixed(2)} net` },
        req
      );
      return NextResponse.json({ ok: true });
    }

    /* ---- edit one stub -------------------------------------------------- */
    const stubId = String(body.stubId || "");
    const stub = await db.paystub.findUnique({ where: { id: stubId }, include: { payRun: true } });
    if (!stub) return NextResponse.json({ error: "Paystub not found." }, { status: 404 });
    if (stub.payRun.status === "PAID") {
      return NextResponse.json({ error: "That run is paid. Reopen it first if something needs changing." }, { status: 400 });
    }

    const num = (v: unknown): number | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.max(0, n) : undefined;
    };

    /* "Pull it back from the clock" — drop every override on this row. */
    const reset = body.action === "reset";

    const hoursIn = num(body.hourHundredths);
    const hourHundredths = reset
      ? (await clockHours(stub.payRun.periodFrom, stub.payRun.periodTo)).hundredths.get(stub.employeeId) || 0
      : (hoursIn === undefined || hoursIn === null ? stub.hourHundredths : hoursIn);
    const rateCents = reset ? stub.rateCents : (num(body.rateCents) ?? stub.rateCents);

    const w4 = JSON.parse(stub.w4Json || "{}") as W4;
    const prior = await ytdBefore(stub.payRun.taxYear, stub.payRunId);
    const p = prior.get(stub.employeeId) || { gross: 0, ss: 0, med: 0, fed: 0, state: 0, net: 0 };
    const deds = JSON.parse(stub.deductionsJson || "[]") as { name: string; amountCents: number }[];
    const wasManual = new Set(JSON.parse(stub.manualJson || "[]") as string[]);

    /* An override already on the row stays on it unless this request clears
       it or resets the row. Sent as null = "go back to computing it". */
    const keep = (field: string, sent: number | null | undefined, stored: number) =>
      reset ? undefined
      : sent === null ? undefined
      : sent !== undefined ? sent
      : wasManual.has(field) ? stored
      : undefined;

    const built = buildStub({
      hourHundredths,
      rateCents,
      grossOverrideCents: keep("gross", num(body.grossCents), stub.grossCents) ?? null,
      periodsPerYear: stub.payRun.periodsPerYear,
      w4: { ...DEFAULT_W4, ...w4 },
      otherDeductionsCents:
        num(body.otherDedCents) ?? (hourHundredths > 0 ? deds.reduce((n, d) => n + d.amountCents, 0) : 0),
      ytdGrossCents: p.gross,
      ytdSsWagesCents: p.gross,
      overrides: {
        ssCents: keep("ss", num(body.ssCents), stub.ssCents),
        medicareCents: keep("medicare", num(body.medicareCents), stub.medicareCents),
        federalCents: keep("federal", num(body.federalCents), stub.federalCents),
        stateCents: keep("state", num(body.stateCents), stub.stateCents),
      },
    });

    const updated = await db.paystub.update({
      where: { id: stubId },
      data: {
        hourHundredths, rateCents, grossCents: built.grossCents,
        ssCents: built.ssCents, medicareCents: built.medicareCents,
        federalCents: built.federalCents, stateCents: built.stateCents,
        otherDedCents: built.otherDeductionsCents, netCents: built.netCents,
        manualJson: JSON.stringify(built.manual),
        missingJson: JSON.stringify(built.missing),
        hoursFromClock: reset ? true : hourHundredths === ((await clockHours(stub.payRun.periodFrom, stub.payRun.periodTo)).hundredths.get(stub.employeeId) || 0),
        ...(typeof body.note === "string" ? { note: String(body.note).slice(0, 200) } : {}),
      },
    });

    return NextResponse.json({ ok: true, row: shape(updated), complete: isComplete(built) });
  });
}

/** Throw a draft away. A paid run is never deleted. */
export async function DELETE(req: NextRequest) {
  return runRoute("admin/payrun DELETE", async () => {
    { const denied = await denyUnless("people"); if (denied) return denied; }
    const runId = (req.nextUrl.searchParams.get("runId") || "").trim();
    const run = await db.payRun.findUnique({ where: { id: runId } });
    if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    if (run.status === "PAID") {
      return NextResponse.json({ error: "A paid run can't be deleted — reopen it if it needs correcting." }, { status: 400 });
    }
    await db.payRun.delete({ where: { id: runId } });
    await recordAudit(
      { action: "SETTING_CHANGE", targetType: "PAYRUN", targetId: runId,
        targetLabel: `${run.periodFrom} – ${run.periodTo}`,
        detail: `Draft payroll run discarded for ${run.periodFrom} – ${run.periodTo}` },
      req
    );
    return NextResponse.json({ ok: true });
  });
}


import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { denyUnless } from "@/lib/perm";
import { runRoute } from "@/lib/handler";
import { recordAudit, currentAuditActor } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * The days the market didn't open.
 *
 * GET    ?month=2026-10  → that month's closed days (all of them if no month)
 * POST   { day, reason } → mark a day closed
 * DELETE { day }         → it was open after all
 *
 * "financials", not "market": a closed day is money off every vendor's rent,
 * so the person entering one is deciding what the market gives back.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  return runRoute("admin/closures GET", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
    const month = (req.nextUrl.searchParams.get("month") || "").trim();
    const where = /^\d{4}-\d{2}$/.test(month) ? { day: { startsWith: `${month}-` } } : {};
    const closures = await db.marketClosure.findMany({ where, orderBy: { day: "asc" } });
    return NextResponse.json({ closures });
  });
}

export async function POST(req: NextRequest) {
  return runRoute("admin/closures POST", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const day = String(body.day || "").trim();
    if (!DAY.test(day)) return NextResponse.json({ error: "Pick a date." }, { status: 400 });

    const reason = String(body.reason || "").trim().slice(0, 120);
    const actor = await currentAuditActor();

    /* Marking the same day twice is somebody being thorough, not an error —
       and silently keeping the first one means the reason they just typed is
       thrown away, so the later one wins. */
    const closure = await db.marketClosure.upsert({
      where: { day },
      create: { day, reason, createdBy: actor.actorName },
      update: { reason, createdBy: actor.actorName },
    });

    await recordAudit(
      {
        action: "SETTING_CHANGE",
        targetType: "CLOSURE",
        targetId: closure.id,
        targetLabel: day,
        detail: `Market marked closed on ${day}${reason ? ` — ${reason}` : ""}`,
      },
      req
    );

    return NextResponse.json({ closure });
  });
}

export async function DELETE(req: NextRequest) {
  return runRoute("admin/closures DELETE", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const day = String(body.day || "").trim();
    if (!DAY.test(day)) return NextResponse.json({ error: "Which day?" }, { status: 400 });

    const existing = await db.marketClosure.findUnique({ where: { day } });
    if (!existing) return NextResponse.json({ ok: true });

    await db.marketClosure.delete({ where: { day } });
    await recordAudit(
      {
        action: "SETTING_CHANGE",
        targetType: "CLOSURE",
        targetId: existing.id,
        targetLabel: day,
        detail: `${day} is no longer marked closed`,
      },
      req
    );
    return NextResponse.json({ ok: true });
  });
}

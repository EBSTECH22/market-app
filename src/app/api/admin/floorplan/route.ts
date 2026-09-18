import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";
import { closureGapIn, roomAreaSqFt, SPACE_KINDS, type Wall, type Opening } from "@/lib/floorplan";

export const dynamic = "force-dynamic";

/**
 * The site map: rooms, their walls, and the booths in them.
 *
 * One route rather than four, because everything here is small and always read
 * together — the editor needs every plan, every space and every signed
 * agreement in one go to draw anything at all.
 *
 * Gated on "market": the people who let booths. A cashier has no business
 * moving the floor around.
 */

/** Trust nothing typed. A wall with a NaN length draws a room with no corners. */
function cleanWalls(raw: unknown): Wall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((w) => {
      const o = (w || {}) as Record<string, unknown>;
      const lengthIn = Math.round(Number(o.lengthIn));
      const turnDeg = Math.round(Number(o.turnDeg));
      if (!Number.isFinite(lengthIn) || lengthIn <= 0) return null;
      return {
        lengthIn: Math.min(100000, lengthIn),
        /* Any angle is allowed — not every room is square — but it is clamped
           so a stray keystroke can't spin the drawing into orbit. */
        turnDeg: Number.isFinite(turnDeg) ? Math.max(-180, Math.min(180, turnDeg)) : 90,
        label: String(o.label || "").slice(0, 60),
        openings: cleanOpenings(o.openings, lengthIn),
      };
    })
    .filter((w): w is { lengthIn: number; turnDeg: number; label: string; openings: Opening[] } => w !== null)
    .slice(0, 200);
}

/** Doors, arches and windows, kept inside the wall they belong to. */
function cleanOpenings(raw: unknown, wallLengthIn: number): Opening[] {
  if (!Array.isArray(raw)) return [];
  const kinds = ["DOOR", "ARCH", "WINDOW", "SERVICE"];
  return raw
    .map((o) => {
      const v = (o || {}) as Record<string, unknown>;
      const widthIn = Math.round(Number(v.widthIn));
      const offsetIn = Math.round(Number(v.offsetIn));
      if (!Number.isFinite(widthIn) || widthIn <= 0) return null;
      const kind = String(v.kind || "DOOR").toUpperCase();
      return {
        kind: (kinds.includes(kind) ? kind : "DOOR") as Opening["kind"],
        /* Clamped rather than rejected: a door typed past the end of its wall
           is a mistyped offset, and sliding it to the end is more useful than
           dropping it silently. */
        widthIn: Math.max(1, Math.min(widthIn, wallLengthIn)),
        offsetIn: Math.max(0, Math.min(Number.isFinite(offsetIn) ? offsetIn : 0, Math.max(0, wallLengthIn - 1))),
        label: String(v.label || "").slice(0, 40),
      };
    })
    .filter((o): o is { kind: Opening["kind"]; widthIn: number; offsetIn: number; label: string } => o !== null)
    .slice(0, 40);
}

export async function GET() {
  return runRoute("admin/floorplan GET", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }

    const plans = await db.floorPlan.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: { spaces: { orderBy: { createdAt: "asc" } } },
    });

    const vendors = await db.vendor.findMany({
      where: { active: true },
      select: { id: true, code: true, businessName: true },
      orderBy: { businessName: "asc" },
    });
    const nameOf = new Map<string, { code: string; businessName: string }>(
      vendors.map((v) => [v.id, { code: v.code, businessName: v.businessName }] as [string, { code: string; businessName: string }])
    );

    /* Signed agreements, so a booth can be pointed at the vendor who is
       actually paying for one. Both signatures, because an unsigned agreement
       is not a tenancy. */
    const contracts = await db.contract.findMany({
      where: { vendorSignedAt: { not: null }, marketSignedAt: { not: null }, status: { in: ["ACTIVE", "TERMINATING"] } },
      select: { id: true, vendorId: true, boothLabel: true, monthlyRentCents: true, status: true },
      orderBy: { createdAt: "desc" },
    });

    const placedContractIds = new Set(
      plans.flatMap((p) => p.spaces.map((s) => s.contractId)).filter(Boolean)
    );

    return NextResponse.json({
      plans: plans.map((p) => {
        const walls = cleanWalls(p.walls);
        return {
          id: p.id,
          name: p.name,
          gridIn: p.gridIn,
          notes: p.notes,
          walls,
          gapIn: closureGapIn(walls),
          areaSqFt: roomAreaSqFt(walls),
          spaces: p.spaces.map((s) => ({
            id: s.id,
            kind: s.kind,
            label: s.label,
            xIn: s.xIn, yIn: s.yIn,
            widthIn: s.widthIn, depthIn: s.depthIn,
            rotationDeg: s.rotationDeg,
            status: s.status,
            vendorId: s.vendorId,
            contractId: s.contractId,
            notes: s.notes,
            vendorName: s.vendorId ? nameOf.get(s.vendorId)?.businessName || "" : "",
            vendorCode: s.vendorId ? nameOf.get(s.vendorId)?.code || "" : "",
          })),
        };
      }),
      vendors,
      contracts: contracts.map((c) => ({
        ...c,
        vendorName: nameOf.get(c.vendorId)?.businessName || "Unknown",
        vendorCode: nameOf.get(c.vendorId)?.code || "",
        /* So the editor can show which signed booths still have nowhere to
           stand — the whole point of drawing the map before opening. */
        placed: placedContractIds.has(c.id),
      })),
    });
  });
}

/**
 * POST — create a plan, or add a space to one.
 *
 * `what` says which, NOT `kind`: a space carries its own `kind` (BOOTH, DESK,
 * WALKWAY…) in the same body, and using one word for both meant adding a
 * walkway sent `kind: "space"` and created a booth.
 */
export async function POST(req: NextRequest) {
  return runRoute("admin/floorplan POST", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));

    if (body.what === "plan") {
      const count = await db.floorPlan.count();
      const plan = await db.floorPlan.create({
        data: {
          name: String(body.name || "New room").slice(0, 80),
          sortOrder: count,
          walls: cleanWalls(body.walls) as unknown as object,
        },
      });
      await recordAudit({ action: "SETTING_CHANGE", targetType: "FLOORPLAN", targetId: plan.id, targetLabel: plan.name, detail: `Added the room "${plan.name}" to the site map` }, req);
      return NextResponse.json({ ok: true, id: plan.id });
    }

    if (body.what === "space") {
      const planId = String(body.planId || "");
      const plan = await db.floorPlan.findUnique({ where: { id: planId }, select: { id: true } });
      if (!plan) return NextResponse.json({ error: "That room is gone." }, { status: 404 });

      const space = await db.floorSpace.create({
        data: {
          planId,
          kind: kindOf(body.kind),
          label: String(body.label || "").slice(0, 40),
          xIn: int(body.xIn, 0), yIn: int(body.yIn, 0),
          widthIn: Math.max(6, int(body.widthIn, 60)),
          depthIn: Math.max(6, int(body.depthIn, 60)),
          rotationDeg: rot(body.rotationDeg),
        },
      });
      return NextResponse.json({ ok: true, id: space.id });
    }

    return NextResponse.json({ error: "Unknown thing to create." }, { status: 400 });
  });
}

const int = (v: unknown, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
};
const kindOf = (v: unknown): string => {
  const k = String(v || "BOOTH").toUpperCase();
  return (SPACE_KINDS as readonly string[]).includes(k) ? k : "BOOTH";
};

/** Booths sit square to the room, so rotation is one of four values. */
const rot = (v: unknown): number => (((Math.round(Number(v) / 90) * 90) % 360) + 360) % 360 || 0;

/** PATCH — rename a room, redraw its walls, or move/assign a space. */
export async function PATCH(req: NextRequest) {
  return runRoute("admin/floorplan PATCH", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));

    if (body.what === "plan") {
      const data: Record<string, unknown> = {};
      if (body.name !== undefined) data.name = String(body.name).slice(0, 80);
      if (body.notes !== undefined) data.notes = String(body.notes).slice(0, 1000);
      if (body.gridIn !== undefined) data.gridIn = Math.max(0, Math.min(24, int(body.gridIn, 3)));
      if (body.walls !== undefined) data.walls = cleanWalls(body.walls) as unknown as object;
      await db.floorPlan.update({ where: { id: String(body.id || "") }, data });
      return NextResponse.json({ ok: true });
    }

    if (body.what === "space") {
      const id = String(body.id || "");
      const existing = await db.floorSpace.findUnique({ where: { id } });
      if (!existing) return NextResponse.json({ error: "That space is gone." }, { status: 404 });

      const data: Record<string, unknown> = {};
      if (body.kind !== undefined) data.kind = kindOf(body.kind);
      if (body.label !== undefined) data.label = String(body.label).slice(0, 40);
      if (body.notes !== undefined) data.notes = String(body.notes).slice(0, 500);
      if (body.xIn !== undefined) data.xIn = int(body.xIn, existing.xIn);
      if (body.yIn !== undefined) data.yIn = int(body.yIn, existing.yIn);
      if (body.widthIn !== undefined) data.widthIn = Math.max(6, int(body.widthIn, existing.widthIn));
      if (body.depthIn !== undefined) data.depthIn = Math.max(6, int(body.depthIn, existing.depthIn));
      if (body.rotationDeg !== undefined) data.rotationDeg = rot(body.rotationDeg);
      if (body.status !== undefined) {
        const v = String(body.status).toUpperCase();
        data.status = ["AVAILABLE", "HELD", "TAKEN"].includes(v) ? v : "AVAILABLE";
      }

      /* Assigning a vendor is the one change worth recording: it is the answer
         to "who was standing there in November" long after the booth moved. */
      if (body.vendorId !== undefined) {
        const vendorId = String(body.vendorId || "");
        const contractId = String(body.contractId || "");
        data.vendorId = vendorId;
        data.contractId = contractId;
        /* Putting somebody in it means it is taken. Taking them out frees it,
           unless it was explicitly put on hold in the same breath. */
        if (body.status === undefined) data.status = vendorId ? "TAKEN" : "AVAILABLE";

        const vendor = vendorId ? await db.vendor.findUnique({ where: { id: vendorId }, select: { businessName: true, code: true } }) : null;
        await recordAudit(
          {
            action: "SETTING_CHANGE",
            targetType: "FLOORSPACE",
            targetId: id,
            targetLabel: existing.label || "Booth",
            detail: vendor
              ? `Assigned ${vendor.code} ${vendor.businessName} to ${existing.label || "a booth"} on the site map`
              : `Cleared ${existing.label || "a booth"} on the site map`,
          },
          req
        );
      }

      await db.floorSpace.update({ where: { id }, data });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown thing to change." }, { status: 400 });
  });
}

/** DELETE ?plan=id or ?space=id */
export async function DELETE(req: NextRequest) {
  return runRoute("admin/floorplan DELETE", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }

    const spaceId = req.nextUrl.searchParams.get("space");
    if (spaceId) {
      await db.floorSpace.deleteMany({ where: { id: spaceId } });
      return NextResponse.json({ ok: true });
    }

    const planId = req.nextUrl.searchParams.get("plan");
    if (planId) {
      const plan = await db.floorPlan.findUnique({ where: { id: planId }, select: { name: true, _count: { select: { spaces: true } } } });
      if (!plan) return NextResponse.json({ error: "Already gone." }, { status: 404 });
      /* The spaces go with it — the schema cascades. Said out loud in the audit
         line because "where did Room 2's twelve booths go" is a question. */
      await db.floorPlan.delete({ where: { id: planId } });
      await recordAudit({ action: "SETTING_CHANGE", targetType: "FLOORPLAN", targetId: planId, targetLabel: plan.name, detail: `Deleted the room "${plan.name}" and its ${plan._count.spaces} booths from the site map` }, req);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Nothing to delete." }, { status: 400 });
  });
}

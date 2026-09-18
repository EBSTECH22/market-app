import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { roomPolygon, type Wall } from "@/lib/floorplan";

export const dynamic = "force-dynamic";

/**
 * Where this vendor's booth is, for their own portal.
 *
 * Their space and the outline of the room it sits in — and nothing about any
 * other booth beyond a plain rectangle. A vendor has no business learning what
 * their neighbour pays, or even who their neighbour is, from this endpoint; the
 * surrounding squares are returned only so their own is recognisable in
 * context.
 */
export async function GET() {
  return runRoute("vendor/booth GET", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

    const mine = await db.floorSpace.findMany({ where: { vendorId } });
    if (mine.length === 0) return NextResponse.json({ spaces: [] });

    const planIds = [...new Set(mine.map((s) => s.planId))];
    const plans = await db.floorPlan.findMany({
      where: { id: { in: planIds } },
      include: {
        spaces: {
          select: { id: true, kind: true, xIn: true, yIn: true, widthIn: true, depthIn: true, rotationDeg: true },
        },
      },
    });

    return NextResponse.json({
      spaces: mine.map((s) => {
        const plan = plans.find((p) => p.id === s.planId);
        const walls = (Array.isArray(plan?.walls) ? plan?.walls : []) as unknown as Wall[];
        return {
          id: s.id,
          label: s.label,
          widthIn: s.widthIn,
          depthIn: s.depthIn,
          rotationDeg: s.rotationDeg,
          xIn: s.xIn,
          yIn: s.yIn,
          roomName: plan?.name || "",
          walls,
          polygon: roomPolygon(walls),
          /* Neighbours as bare rectangles: shape only, no names, no rents. */
          others: (plan?.spaces || [])
            .filter((o) => o.id !== s.id)
            .map((o) => ({ id: o.id, kind: o.kind, xIn: o.xIn, yIn: o.yIn, widthIn: o.widthIn, depthIn: o.depthIn, rotationDeg: o.rotationDeg })),
        };
      }),
    });
  });
}

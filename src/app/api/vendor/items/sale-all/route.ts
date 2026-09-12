import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST { percent } — set a sale on every active item (0 ends all sales)
export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const pct = Math.round(Number((await req.json()).percent));
  if (Number.isNaN(pct) || pct < 0 || pct > 90) return NextResponse.json({ error: "Sale must be 0–90%." }, { status: 400 });
  const r = await db.item.updateMany({ where: { vendorId, active: true }, data: { salePercent: pct } });
  return NextResponse.json({ ok: true, updated: r.count, percent: pct });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { effectivePriceCents } from "@/lib/pricing";
import { isStaff } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sku = req.nextUrl.searchParams.get("sku")?.trim().toUpperCase();
  if (!sku) return NextResponse.json({ error: "No code." }, { status: 400 });

  const item = await db.item.findUnique({
    where: { sku },
    include: { vendor: { select: { businessName: true, code: true, active: true } } },
  });
  if (!item || !item.active) return NextResponse.json({ error: `No item found for ${sku}.` }, { status: 404 });
  if (!item.vendor.active) {
    return NextResponse.json({ error: `${item.vendor.businessName} is deactivated — their items can't be sold. Pull it from the floor.` }, { status: 400 });
  }
  const unit = effectivePriceCents(item);
  return NextResponse.json({ item: { ...item, priceCents: unit, taxClass: String(item.taxClass || "STANDARD"), basePriceCents: item.priceCents, salePercent: item.salePercent } });
}

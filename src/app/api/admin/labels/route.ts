import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { denyUnless } from "@/lib/perm";
import { getCardAdjustPercent, getMarketFeePercent } from "@/lib/settings";
import { marketFeeFor } from "@/lib/marketfee";

export const dynamic = "force-dynamic";

/**
 * Barcode labels for somebody else's items.
 *
 * The labels page has always been a vendor printing their own, which is right
 * until a vendor turns up with a box of jam and no printer — then the office
 * prints for them, and the only way to do that was to sign in as them.
 *
 * "ops", not "market": printing a sticker is a counter job, the same as
 * ringing a sale, and the person who takes the delivery should be able to do
 * it without being an owner. Nothing here changes anything — it only reads
 * names, prices and SKUs, all of which are already on the shelf edge.
 *
 * GET                  → every vendor with something to label
 * GET ?vendorId=<id>   → that vendor's items, ready to print
 */
export async function GET(req: NextRequest) {
  { const denied = await denyUnless("ops"); if (denied) return denied; }

  const vendorId = (req.nextUrl.searchParams.get("vendorId") || "").trim();

  if (!vendorId) {
    const vendors = await db.vendor.findMany({
      where: { active: true },
      orderBy: { businessName: "asc" },
      select: { id: true, code: true, businessName: true, _count: { select: { items: true } } },
    });
    return NextResponse.json({
      staff: true,
      vendors: vendors.map((v) => ({
        id: v.id,
        code: v.code,
        businessName: v.businessName,
        itemCount: v._count.items,
      })),
    });
  }

  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, code: true, businessName: true, marketFeePercent: true },
  });
  if (!vendor) return NextResponse.json({ error: "No such vendor." }, { status: 404 });

  /* The same shape the vendor's own page gets, so the printing side doesn't
     have to care which of the two it is looking at. */
  const items = await db.item.findMany({
    where: { vendorId },
    orderBy: { createdAt: "asc" },
    select: { id: true, sku: true, name: true, priceCents: true, quantity: true, active: true },
  });

  return NextResponse.json({
    staff: true,
    vendor,
    items,
    cardPercent: await getCardAdjustPercent(),
    feePercent: marketFeeFor(vendor, await getMarketFeePercent()),
  });
}

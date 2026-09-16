import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { effectivePriceCents } from "@/lib/pricing";
import { PUBLIC_VENDOR_WHERE } from "@/lib/vendor";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { code: string } }) {
  const vendor = await db.vendor.findFirst({
    where: { code: params.code.toUpperCase(), ...PUBLIC_VENDOR_WHERE },
    select: { id: true, code: true, businessName: true, publicBlurb: true, acceptsPreorders: true, acceptsRequests: true },
  });
  if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
  const items = await db.item.findMany({
    where: { vendorId: vendor.id, active: true, quantity: { gt: 0 } },
    select: { id: true, name: true, priceCents: true, salePercent: true, quantity: true },
    orderBy: { name: "asc" },
  });
  const photos = await db.vendorPhoto.findMany({ where: { vendorId: vendor.id, kind: "PRODUCT" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const itemPhotos = await db.vendorPhoto.findMany({ where: { vendorId: vendor.id, kind: "ITEM" }, select: { id: true, itemId: true } });
  const itemPhotoMap = new Map(itemPhotos.map((x) => [x.itemId, x.id]));
  const logo = await db.vendorPhoto.findFirst({ where: { vendorId: vendor.id, kind: "LOGO" }, select: { id: true } });
  const reviews = await db.review.findMany({ where: { vendorId: vendor.id }, orderBy: { createdAt: "desc" }, take: 100 });
  const comments = await db.reviewComment.findMany({
    where: { reviewId: { in: reviews.map((r) => r.id) } },
    orderBy: { createdAt: "asc" },
  });
  const { id, ...pub } = vendor;
  return NextResponse.json({
    vendor: pub,
    logoId: logo?.id || null,
    photos: photos.map((x) => x.id),
    items: items.map((i) => ({ name: i.name, quantity: i.quantity, priceCents: effectivePriceCents(i), basePriceCents: i.priceCents, salePercent: Math.max(0, Math.min(90, i.salePercent || 0)), photoId: itemPhotoMap.get(i.id) || null })),
    reviews: reviews.map((r) => ({
      ...r,
      comments: comments.filter((c) => c.reviewId === r.id),
    })),
  });
}

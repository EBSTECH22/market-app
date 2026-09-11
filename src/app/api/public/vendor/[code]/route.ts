import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { code: string } }) {
  const vendor = await db.vendor.findFirst({
    where: { code: params.code.toUpperCase(), active: true },
    select: { id: true, code: true, businessName: true, publicBlurb: true, acceptsPreorders: true, acceptsRequests: true },
  });
  if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
  const items = await db.item.findMany({
    where: { vendorId: vendor.id, active: true, quantity: { gt: 0 } },
    select: { name: true, priceCents: true, quantity: true },
    orderBy: { name: "asc" },
  });
  const reviews = await db.review.findMany({ where: { vendorId: vendor.id }, orderBy: { createdAt: "desc" }, take: 100 });
  const comments = await db.reviewComment.findMany({
    where: { reviewId: { in: reviews.map((r) => r.id) } },
    orderBy: { createdAt: "asc" },
  });
  const { id, ...pub } = vendor;
  return NextResponse.json({
    vendor: pub,
    items,
    reviews: reviews.map((r) => ({
      ...r,
      comments: comments.filter((c) => c.reviewId === r.id),
    })),
  });
}

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Public: every active vendor + what's actually on the floor right now
export async function GET() {
  const vendors = await db.vendor.findMany({
    where: { active: true },
    select: { code: true, businessName: true, publicBlurb: true, acceptsPreorders: true, acceptsRequests: true },
    orderBy: { businessName: "asc" },
  });
  const items = await db.item.findMany({
    where: { active: true, quantity: { gt: 0 }, vendor: { active: true } },
    select: { name: true, priceCents: true, quantity: true, vendor: { select: { code: true } } },
    orderBy: { name: "asc" },
  });
  const logos = await db.vendorPhoto.findMany({ where: { kind: "LOGO" }, select: { id: true, vendorId: true } });
  const reviews = await db.review.groupBy({ by: ["vendorId"], _avg: { rating: true }, _count: true });
  const vmap = await db.vendor.findMany({ where: { active: true }, select: { id: true, code: true } });
  const idToCode = new Map(vmap.map((v) => [v.id, v.code]));
  const ratings: Record<string, { avg: number; n: number }> = {};
  for (const r of reviews) {
    const code = idToCode.get(r.vendorId);
    if (code) ratings[code] = { avg: Math.round((r._avg.rating || 0) * 10) / 10, n: r._count };
  }
  const logoByCode: Record<string, string> = {};
  for (const lg of logos) {
    const code = idToCode.get(lg.vendorId);
    if (code) logoByCode[code] = lg.id;
  }
  return NextResponse.json({
    vendors: vendors.map((v) => ({
      ...v,
      items: items.filter((i) => i.vendor.code === v.code).map(({ vendor, ...rest }) => rest),
      rating: ratings[v.code] || null,
      logoId: logoByCode[v.code] || null,
    })),
  });
}

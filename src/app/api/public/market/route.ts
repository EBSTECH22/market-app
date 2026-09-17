import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { effectivePriceCents } from "@/lib/pricing";
import { PUBLIC_VENDOR_WHERE } from "@/lib/vendor";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Public: every active vendor + what's actually on the floor right now
export async function GET() {
  const vendors = await db.vendor.findMany({
    where: PUBLIC_VENDOR_WHERE,
    select: { code: true, businessName: true, publicBlurb: true, tagline: true, acceptsPreorders: true, acceptsRequests: true },
    orderBy: { businessName: "asc" },
  });
  const items = await db.item.findMany({
    where: { active: true, quantity: { gt: 0 }, vendor: PUBLIC_VENDOR_WHERE },
    select: { name: true, priceCents: true, salePercent: true, quantity: true, vendor: { select: { code: true } } },
    orderBy: { name: "asc" },
  });
  const logos = await db.vendorPhoto.findMany({ where: { kind: "LOGO" }, select: { id: true, vendorId: true } });
  const reviews = await db.review.groupBy({ by: ["vendorId"], _avg: { rating: true }, _count: true });
  const vmap = await db.vendor.findMany({ where: PUBLIC_VENDOR_WHERE, select: { id: true, code: true } });
  /* Explicit generics: `new Map(arr.map(...))` infers the value as `{}`, which
     typechecks at the call site and then fails the production build on the
     first use. This codebase has lost a deploy to it twice. */
  const idToCode = new Map<string, string>(vmap.map((v) => [v.id, v.code] as [string, string]));
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
      items: items.filter((i) => i.vendor.code === v.code).map((i) => ({ name: i.name, quantity: i.quantity, priceCents: effectivePriceCents(i), basePriceCents: i.priceCents, salePercent: Math.max(0, Math.min(90, i.salePercent || 0)) })),
      rating: ratings[v.code] || null,
      logoId: logoByCode[v.code] || null,
    })),
  });
}

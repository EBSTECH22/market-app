import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PUBLIC_VENDOR_WHERE } from "@/lib/vendor";

export const dynamic = "force-dynamic";

export async function GET() {
  const posts = await db.post.findMany({ orderBy: { createdAt: "desc" }, take: 40 });
  const vendors = await db.vendor.findMany({ where: PUBLIC_VENDOR_WHERE, select: { id: true, code: true, businessName: true } });
  const vmap = Object.fromEntries(vendors.map((v) => [v.id, v]));
  const logos = await db.vendorPhoto.findMany({ where: { kind: "LOGO" }, select: { id: true, vendorId: true } });
  const lmap = Object.fromEntries(logos.map((l) => [l.vendorId, l.id]));
  return NextResponse.json({
    posts: posts.filter((p) => vmap[p.vendorId]).map((p) => ({
      id: p.id, body: p.body, photoId: p.photoId || null, createdAt: p.createdAt,
      vendor: { code: vmap[p.vendorId].code, businessName: vmap[p.vendorId].businessName, logoId: lmap[p.vendorId] || null },
    })),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PUBLIC_VENDOR_WHERE } from "@/lib/vendor";

export const dynamic = "force-dynamic";

// Serves a vendor product photo publicly (only photos of active vendors)
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const photo = await db.vendorPhoto.findUnique({ where: { id: params.id } });
  if (!photo) return new NextResponse("Not found", { status: 404 });
  const vendor = await db.vendor.findFirst({ where: { id: photo.vendorId, ...PUBLIC_VENDOR_WHERE }, select: { id: true } });
  if (!vendor) return new NextResponse("Not found", { status: 404 });
  const buf = Buffer.from(photo.data, "base64");
  return new NextResponse(buf, {
    headers: { "Content-Type": photo.mime, "Cache-Control": "public, max-age=3600" },
  });
}

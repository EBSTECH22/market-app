import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const photo = await db.vendorPhoto.findFirst({ where: { id: params.id, vendorId } });
  if (!photo) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await db.vendorPhoto.delete({ where: { id: photo.id } });
  return NextResponse.json({ ok: true });
}

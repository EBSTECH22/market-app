import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";

export const dynamic = "force-dynamic";

const MAX_PHOTOS = 6;
const MAX_BYTES = 2 * 1024 * 1024; // post-compression cap

export async function GET() {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const photos = await db.vendorPhoto.findMany({ where: { vendorId }, orderBy: { createdAt: "asc" }, select: { id: true, kind: true, itemId: true } });
  return NextResponse.json({ photos });
}

export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const { data, mime, kind, itemId } = await req.json();
  if (!/^image\/(jpeg|png|webp)$/.test(mime || "")) return NextResponse.json({ error: "JPEG, PNG, or WebP only." }, { status: 400 });
  const k = kind === "LOGO" ? "LOGO" : kind === "ITEM" ? "ITEM" : "PRODUCT";
  const b64 = String(data || "");
  const bytes = Math.floor(b64.length * 0.75);
  if (!b64 || bytes > MAX_BYTES) return NextResponse.json({ error: "Photo too large even after compression — try a smaller one." }, { status: 400 });
  if (k === "ITEM") {
    const iid = String(itemId || "");
    const item = await db.item.findUnique({ where: { id: iid } });
    if (!item || item.vendorId !== vendorId) return NextResponse.json({ error: "Item not found." }, { status: 404 });
    await db.vendorPhoto.deleteMany({ where: { vendorId, kind: "ITEM", itemId: iid } }); // one photo per product
    const photo = await db.vendorPhoto.create({ data: { vendorId, mime, data: b64, kind: "ITEM", itemId: iid } });
    return NextResponse.json({ photo: { id: photo.id, kind: "ITEM", itemId: iid } });
  }
  if (k === "LOGO") {
    await db.vendorPhoto.deleteMany({ where: { vendorId, kind: "LOGO" } }); // one logo — new replaces old
  } else {
    const count = await db.vendorPhoto.count({ where: { vendorId, kind: "PRODUCT" } });
    if (count >= MAX_PHOTOS) return NextResponse.json({ error: `${MAX_PHOTOS} photos max — delete one to add another.` }, { status: 400 });
  }
  const photo = await db.vendorPhoto.create({ data: { vendorId, mime, data: b64, kind: k } });
  return NextResponse.json({ photo: { id: photo.id, kind: k } });
}

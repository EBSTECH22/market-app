import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const posts = await db.post.findMany({ where: { vendorId }, orderBy: { createdAt: "desc" }, take: 30 });
  return NextResponse.json({ posts });
}

export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const { body, photoId } = await req.json();
  const text = String(body || "").trim().slice(0, 1200);
  if (!text) return NextResponse.json({ error: "Write something first." }, { status: 400 });
  const post = await db.post.create({ data: { vendorId, body: text, photoId: String(photoId || "") } });
  return NextResponse.json({ post });
}

export async function DELETE(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const { id } = await req.json();
  await db.post.deleteMany({ where: { id: String(id || ""), vendorId } });
  return NextResponse.json({ ok: true });
}

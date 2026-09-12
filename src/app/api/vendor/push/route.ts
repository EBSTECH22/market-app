import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const { endpoint, keys } = await req.json();
  if (!endpoint || !keys?.p256dh || !keys?.auth) return NextResponse.json({ error: "Bad subscription." }, { status: 400 });
  await db.pushSub.upsert({
    where: { endpoint },
    create: { vendorId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    update: { vendorId, p256dh: keys.p256dh, auth: keys.auth },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const { endpoint, all } = await req.json().catch(() => ({}));
  if (all) {
    await db.pushSub.deleteMany({ where: { vendorId } });
  } else if (endpoint) {
    await db.pushSub.deleteMany({ where: { endpoint, vendorId } });
  }
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const count = await db.pushSub.count({ where: { vendorId } });
  return NextResponse.json({ devices: count, publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || "" });
}

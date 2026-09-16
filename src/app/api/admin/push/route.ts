import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

// POST { endpoint, keys } — register this device for admin notifications
export async function POST(req: NextRequest) {
  { const denied = await denyUnless("people"); if (denied) return denied; }
  const { endpoint, keys } = await req.json();
  if (!endpoint || !keys?.p256dh || !keys?.auth) return NextResponse.json({ error: "Bad subscription." }, { status: 400 });
  await db.pushSub.upsert({
    where: { endpoint },
    create: { vendorId: "ADMIN", endpoint, p256dh: keys.p256dh, auth: keys.auth },
    update: { vendorId: "ADMIN", p256dh: keys.p256dh, auth: keys.auth },
  });
  return NextResponse.json({ ok: true });
}

export async function GET() {
  { const denied = await denyUnless("people"); if (denied) return denied; }
  const devices = await db.pushSub.count({ where: { vendorId: "ADMIN" } });
  return NextResponse.json({ devices, publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || "" });
}

export async function DELETE(req: NextRequest) {
  { const denied = await denyUnless("people"); if (denied) return denied; }
  const { endpoint } = await req.json();
  if (endpoint) await db.pushSub.deleteMany({ where: { endpoint, vendorId: "ADMIN" } });
  return NextResponse.json({ ok: true });
}

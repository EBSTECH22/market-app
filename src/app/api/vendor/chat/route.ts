import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const msgs = await db.vendorChatMsg.findMany({ orderBy: { createdAt: "asc" }, take: 200 });
  const vendors = await db.vendor.findMany({ select: { id: true, businessName: true } });
  const vmap = Object.fromEntries(vendors.map((v) => [v.id, v.businessName]));
  return NextResponse.json({ me: vendorId, messages: msgs.map((m) => ({ id: m.id, vendorId: m.vendorId, name: vmap[m.vendorId] || "Vendor", body: m.body, createdAt: m.createdAt })) });
}

export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const body = String((await req.json()).body || "").trim().slice(0, 1000);
  if (!body) return NextResponse.json({ error: "Empty message." }, { status: 400 });
  const msg = await db.vendorChatMsg.create({ data: { vendorId, body } });
  return NextResponse.json({ message: msg });
}

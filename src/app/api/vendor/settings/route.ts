import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const { acceptsPreorders, acceptsRequests, publicBlurb } = await req.json();
  const data: { acceptsPreorders?: boolean; acceptsRequests?: boolean; publicBlurb?: string } = {};
  if (acceptsPreorders !== undefined) data.acceptsPreorders = !!acceptsPreorders;
  if (acceptsRequests !== undefined) data.acceptsRequests = !!acceptsRequests;
  if (publicBlurb !== undefined) data.publicBlurb = String(publicBlurb).slice(0, 300);
  const vendor = await db.vendor.update({ where: { id: vendorId }, data });
  return NextResponse.json({ ok: true, vendor: { acceptsPreorders: vendor.acceptsPreorders, acceptsRequests: vendor.acceptsRequests, publicBlurb: vendor.publicBlurb } });
}

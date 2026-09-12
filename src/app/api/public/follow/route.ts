import { NextRequest, NextResponse } from "next/server";
import { followVendor } from "@/lib/customers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { vendorCode, email } = await req.json();
  const res = await followVendor(String(vendorCode || ""), String(email || "").slice(0, 120));
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}

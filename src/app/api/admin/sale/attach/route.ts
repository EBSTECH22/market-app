import { NextRequest, NextResponse } from "next/server";

import { attachCustomerToSale } from "@/lib/customers";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  { const denied = await denyUnless("ops"); if (denied) return denied; }
  const { saleId, contact } = await req.json();
  const res = await attachCustomerToSale(String(saleId || ""), String(contact || "").slice(0, 120));
  if (!res) return NextResponse.json({ error: "Couldn't attach — check the email or phone." }, { status: 400 });
  return NextResponse.json(res);
}

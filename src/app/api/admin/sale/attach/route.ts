import { NextRequest, NextResponse } from "next/server";
import { isStaff } from "@/lib/auth";
import { attachCustomerToSale } from "@/lib/customers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { saleId, contact } = await req.json();
  const res = await attachCustomerToSale(String(saleId || ""), String(contact || "").slice(0, 120));
  if (!res) return NextResponse.json({ error: "Couldn't attach — check the email or phone." }, { status: 400 });
  return NextResponse.json(res);
}

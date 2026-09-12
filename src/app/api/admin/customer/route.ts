import { NextRequest, NextResponse } from "next/server";
import { isStaff } from "@/lib/auth";
import { lookupCustomer } from "@/lib/customers";

export const dynamic = "force-dynamic";

// register lookup: GET ?q=email-or-phone
export async function GET(req: NextRequest) {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = req.nextUrl.searchParams.get("q") || "";
  const customer = await lookupCustomer(q);
  if (!customer) return NextResponse.json({ customer: null });
  return NextResponse.json({ customer: { id: customer.id, email: customer.email, phone: customer.phone, points: customer.points } });
}

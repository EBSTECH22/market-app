import { NextRequest, NextResponse } from "next/server";

import { lookupCustomer } from "@/lib/customers";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

// register lookup: GET ?q=email-or-phone
export async function GET(req: NextRequest) {
  { const denied = await denyUnless("ops"); if (denied) return denied; }
  const q = req.nextUrl.searchParams.get("q") || "";
  const customer = await lookupCustomer(q);
  if (!customer) return NextResponse.json({ customer: null });
  return NextResponse.json({ customer: { id: customer.id, email: customer.email, phone: customer.phone, points: customer.points } });
}

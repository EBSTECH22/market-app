import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword, vendorCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { email, password } = await req.json();
  if (!email || !password) return NextResponse.json({ error: "Email and password required." }, { status: 400 });

  const vendor = await db.vendor.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!vendor || !vendor.active || !verifyPassword(password, vendor.passwordHash)) {
    return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
  }
  if (vendor.portalLocked) {
    return NextResponse.json({ error: "Your portal unlocks once your booth contract is fully signed — check your email for the signing link, or ask us at the market." }, { status: 403 });
  }

  const res = NextResponse.json({ ok: true });
  const c = vendorCookie(vendor.id);
  res.cookies.set(c.name, c.value, { httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 30 });
  return res;
}

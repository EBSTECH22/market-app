import { NextRequest, NextResponse } from "next/server";
import { adminCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  const c = adminCookie();
  res.cookies.set(c.name, c.value, { httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 90 });
  return res;
}

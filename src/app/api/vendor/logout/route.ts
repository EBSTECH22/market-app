import { NextResponse } from "next/server";
import { cookieNames, SESSION_COOKIE_OPTIONS } from "@/lib/auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookieNames.VENDOR_COOKIE, "", { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
  return res;
}

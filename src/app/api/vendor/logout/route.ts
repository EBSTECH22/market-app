import { NextResponse } from "next/server";
import { cookieNames } from "@/lib/auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookieNames.VENDOR_COOKIE, "", { maxAge: 0 });
  return res;
}

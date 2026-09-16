import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword, vendorCookie, SESSION_COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS } from "@/lib/auth";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";

export async function POST(req: NextRequest) {
  return runRoute("vendor/login POST", async () => {
    const { email, password } = await req.json();
    if (!email || !password) return NextResponse.json({ error: "Email and password required." }, { status: 400 });

    const limited = enforceRateLimit(req, "vendor-login", String(email), LIMITS.login, "Too many sign-in attempts.");
    if (limited) return limited;

    const vendor = await db.vendor.findUnique({ where: { email: String(email).toLowerCase().trim() } });
    if (!vendor || !vendor.active || !verifyPassword(String(password), vendor.passwordHash)) {
      return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
    }
    if (vendor.portalLocked) {
      return NextResponse.json({ error: "Your portal unlocks once your booth contract is fully signed — check your email for the signing link, or ask us at the market." }, { status: 403 });
    }

    const res = NextResponse.json({ ok: true });
    const c = vendorCookie(vendor.id);
    res.cookies.set(c.name, c.value, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_SECONDS.vendor });
    return res;
  });
}

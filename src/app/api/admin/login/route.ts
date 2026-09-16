import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { adminCookie, SESSION_COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS } from "@/lib/auth";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: NextRequest) {
  return runRoute("admin/login POST", async () => {
    const limited = await enforceRateLimit(req, "admin-login", "", LIMITS.login, "Too many sign-in attempts.");
    if (limited) return limited;

    const { password } = await req.json();
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected || typeof password !== "string" || !constantTimeEquals(password, expected)) {
      return NextResponse.json({ error: "Wrong password." }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true });
    const c = adminCookie();
    res.cookies.set(c.name, c.value, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_SECONDS.admin });
    return res;
  });
}

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

/**
 * Auth for the scheduled jobs under /api/cron/*.
 *
 * Fails CLOSED:
 *  - CRON_SECRET must be set. If it isn't, every request is rejected (the old
 *    code treated an unset secret as "no auth required", which left the jobs
 *    open to the whole internet on a half-configured deploy).
 *  - The Authorization header is compared with timingSafeEqual.
 *  - There is deliberately no user-agent path. `user-agent: vercel-cron` is
 *    attacker-controlled and proved nothing.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when
 * CRON_SECRET is set in the project's environment variables.
 */
export function cronAuthFailure(req: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("CRON_SECRET is not set — refusing to run the scheduled job.");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const provided = req.headers.get("authorization") || "";
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(`Bearer ${expected}`, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

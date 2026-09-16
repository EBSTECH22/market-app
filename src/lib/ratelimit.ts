import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Rate limiter backed by Postgres, so the count holds across instances.
 *
 * The previous version kept counters in process memory. On Vercel that meant
 * the real limit was (limit x however many instances happen to be warm), and
 * every cold start handed an attacker a fresh allowance — which is exactly
 * the wrong behaviour for the 4-digit staff PINs this protects.
 *
 * Fixed window rather than sliding: one atomic upsert per attempt instead of a
 * row per hit. The trade-off is that a burst straddling a window boundary can
 * briefly reach 2x the limit. For slowing down credential guessing that is
 * irrelevant; for anything where the exact number matters, it would not be.
 *
 * FAILS OPEN. If the database is unreachable this allows the request and logs.
 * A rate limiter is a speed bump — it must never be the reason nobody can open
 * the register. Authentication itself still fails closed.
 */

type Window = { limit: number; windowMs: number };

export type RateLimitResult = { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number };

/** Occasional cleanup of expired rows, on a rough 1-in-50 sample. */
async function maybePrune(): Promise<void> {
  if (Math.random() > 0.02) return;
  try {
    await db.rateLimit.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch { /* cleanup is best effort */ }
}

/**
 * Record an attempt against `key` and report whether it is allowed.
 * `key` should combine the client IP with the thing being guessed
 * (see `limitKey`), so one attacker can't lock every user out.
 */
export async function rateLimit(key: string, { limit, windowMs }: Window): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const windowKey = `${key}|${windowStart}`;
  const expiresAt = new Date(windowStart + windowMs);

  try {
    // Atomic: Postgres resolves this as INSERT ... ON CONFLICT DO UPDATE, so
    // two simultaneous attempts can't both read the same count and both pass.
    const row = await db.rateLimit.upsert({
      where: { key: windowKey },
      create: { key: windowKey, count: 1, expiresAt },
      update: { count: { increment: 1 } },
      select: { count: true },
    });

    void maybePrune();

    if (row.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
      return { ok: false, retryAfterSeconds };
    }
    return { ok: true, remaining: Math.max(0, limit - row.count) };
  } catch (err) {
    console.error("[ratelimit] store unavailable, allowing request:", err);
    return { ok: true, remaining: limit };
  }
}

/** Best-effort client IP from the proxy headers Vercel sets. */
export function clientIp(req: Request): string {
  const h = req.headers;
  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip") || h.get("cf-connecting-ip") || "unknown";
}

/** Namespaced key: bucket + client IP + the identifier being attempted. */
export function limitKey(bucket: string, req: Request, identifier = ""): string {
  return `${bucket}|${clientIp(req)}|${identifier.toLowerCase().trim().slice(0, 120)}`;
}

function waitPhrase(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const mins = Math.ceil(seconds / 60);
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}

/**
 * Convenience for route handlers: resolves to a 429 NextResponse when the
 * caller is over the limit, or null when the request may proceed.
 *
 *   const limited = await enforceRateLimit(req, "admin-login", "", LIMITS.login);
 *   if (limited) return limited;
 *
 * NOTE: async, unlike the in-memory version it replaces. Every call site must
 * await it — forgetting returns a Promise, which is truthy, so the route would
 * return a pending promise as its response instead of rate limiting.
 */
export async function enforceRateLimit(
  req: Request,
  bucket: string,
  identifier: string,
  window: Window,
  message?: string
): Promise<NextResponse | null> {
  const result = await rateLimit(limitKey(bucket, req, identifier), window);
  if (result.ok) return null;
  const wait = waitPhrase(result.retryAfterSeconds);
  return NextResponse.json(
    { error: message ? `${message} Wait ${wait} and try again.` : `Too many attempts. Wait ${wait} and try again.` },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
}

/** Common windows, so the numbers aren't scattered across routes. */
export const LIMITS = {
  login: { limit: 8, windowMs: 10 * 60 * 1000 }, // 8 password attempts / 10 min
  pin: { limit: 10, windowMs: 10 * 60 * 1000 }, // 10 PIN attempts / 10 min
  reset: { limit: 5, windowMs: 15 * 60 * 1000 }, // 5 reset requests / 15 min
} as const;

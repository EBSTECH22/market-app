import { NextResponse } from "next/server";

/**
 * Dependency-free sliding-window rate limiter.
 *
 * NOTE: this counter lives in the Node process's memory, so it is PER INSTANCE.
 * On a multi-instance / serverless deploy each instance keeps its own window,
 * which means the effective limit is (limit x instances) and the window resets
 * whenever an instance is recycled. It is a real speed bump against credential
 * stuffing and PIN brute force, not a hard guarantee. For a multi-instance
 * deploy move the `hits` map behind Redis (or a small `RateLimit` table in
 * Postgres with a periodic prune) — the call sites below don't need to change.
 */

type Window = { limit: number; windowMs: number };

const hits = new Map<string, number[]>();
let lastPrune = Date.now();
const PRUNE_EVERY_MS = 5 * 60 * 1000;
const MAX_KEYS = 20_000;

function prune(now: number) {
  if (now - lastPrune < PRUNE_EVERY_MS && hits.size < MAX_KEYS) return;
  lastPrune = now;
  const cutoff = now - 60 * 60 * 1000; // nothing we track uses a window over an hour
  for (const [key, stamps] of hits) {
    const kept = stamps.filter((t) => t > cutoff);
    if (kept.length) hits.set(key, kept);
    else hits.delete(key);
  }
}

export type RateLimitResult = { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number };

/**
 * Record an attempt against `key` and report whether it is allowed.
 * `key` should combine the client IP with the thing being guessed
 * (see `limitKey`), so one attacker can't lock every user out.
 */
export function rateLimit(key: string, { limit, windowMs }: Window): RateLimitResult {
  const now = Date.now();
  prune(now);
  const start = now - windowMs;
  const stamps = (hits.get(key) || []).filter((t) => t > start);

  if (stamps.length >= limit) {
    hits.set(key, stamps);
    const oldest = stamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { ok: false, retryAfterSeconds };
  }

  stamps.push(now);
  hits.set(key, stamps);
  return { ok: true, remaining: limit - stamps.length };
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
 * Convenience for route handlers: returns a 429 NextResponse when the caller is
 * over the limit, or null when the request may proceed.
 *
 *   const limited = enforceRateLimit(req, "admin-login", "", { limit: 8, windowMs: 60_000 });
 *   if (limited) return limited;
 */
export function enforceRateLimit(
  req: Request,
  bucket: string,
  identifier: string,
  window: Window,
  message?: string
): NextResponse | null {
  const result = rateLimit(limitKey(bucket, req, identifier), window);
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
} as const;

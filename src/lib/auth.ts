import { cookies } from "next/headers";
import { createHash, createHmac, scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";

const ADMIN_COOKIE = "nm_admin";
const VENDOR_COOKIE = "nm_vendor";
const STAFF_COOKIE = "nm_staff";

/**
 * Thrown when a required secret is missing. Route handlers wrapped in
 * `runRoute` (src/lib/handler.ts) turn this into a clean 500 instead of an
 * unhandled exception / crash loop.
 */
export class ConfigError extends Error {
  readonly isConfigError = true;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// Obviously-not-a-secret placeholder. Only ever used outside production so a
// local `npm run dev` without a .env still works.
const DEV_ONLY_INSECURE_SECRET = "dev-only-insecure-not-a-secret";

/**
 * HMAC key for every signed session cookie.
 * Production REQUIRES SESSION_SECRET — there is deliberately no fallback to
 * ADMIN_PASSWORD (which is low-entropy and user-chosen) or to a literal
 * constant, either of which would let anyone forge staff/vendor cookies.
 */
function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length > 0) return s;
  if (process.env.NODE_ENV !== "production") return DEV_ONLY_INSECURE_SECRET;
  throw new ConfigError("SESSION_SECRET is not set — refusing to sign or verify session cookies.");
}

function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Signed sessions
//
// v2 cookie format:  <id>.<issuedAtSeconds>.<hmac>
//   hmac = HMAC-SHA256(secret, "<scope>:<id>:<issuedAt>")
// The issued-at is inside the signed payload, so a copied cookie expires
// server-side even if the client keeps sending it past the browser maxAge.
//
// v1 (legacy) format: <id>.<hmac>  — no expiry at all. Still accepted until
// LEGACY_SESSION_GRACE_UNTIL so an existing deploy doesn't log everyone out;
// after that date only v2 verifies. New cookies are always issued as v2.
// ---------------------------------------------------------------------------

export type SessionScope = "admin" | "staff" | "vendor";
type Scope = SessionScope;

/** Server-side max session age per scope, matching the cookie maxAge values. */
export const SESSION_MAX_AGE_SECONDS: Record<Scope, number> = {
  admin: 60 * 60 * 24 * 90, // 90 days
  vendor: 60 * 60 * 24 * 30, // 30 days
  staff: 60 * 60 * 14, // 14 hours
};

/**
 * Old un-expiring cookies stop verifying after this date. Set comfortably past
 * the longest maxAge (90d) from the deploy so no one is kicked out mid-session.
 */
const LEGACY_SESSION_GRACE_UNTIL = Date.parse("2027-01-31T00:00:00Z");

function withinLegacyGrace(): boolean {
  return Date.now() < LEGACY_SESSION_GRACE_UNTIL;
}

function signV2(scope: Scope, id: string, issuedAt: string): string {
  return createHmac("sha256", secret()).update(`${scope}:${id}:${issuedAt}`).digest("hex");
}

/** Exactly what v1 signed, so old cookies keep verifying during the grace window. */
function signV1(scope: Scope, id: string): string {
  const payload = scope === "staff" ? `staff:${id}` : id;
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

function issueSession(scope: Scope, id: string): string {
  const issuedAt = String(Math.floor(Date.now() / 1000));
  return `${id}.${issuedAt}.${signV2(scope, id, issuedAt)}`;
}

/** Returns the id carried by a valid cookie, or null. Never throws. */
function verifySession(scope: Scope, raw: string): string | null {
  try {
    const parts = raw.split(".");

    if (parts.length === 3) {
      const [id, issuedAt, sig] = parts;
      if (!id || !issuedAt || !sig) return null;
      const iat = Number(issuedAt);
      if (!Number.isFinite(iat) || !/^\d+$/.test(issuedAt)) return null;
      if (!safeEqualHex(sig, signV2(scope, id, issuedAt))) return null;
      const ageSeconds = Math.floor(Date.now() / 1000) - iat;
      // small negative tolerance for clock skew between instances
      if (ageSeconds < -300) return null;
      if (ageSeconds > SESSION_MAX_AGE_SECONDS[scope]) return null;
      return id;
    }

    if (parts.length === 2) {
      if (!withinLegacyGrace()) return null;
      const [id, sig] = parts;
      if (!id || !sig) return null;
      return safeEqualHex(sig, signV1(scope, id)) ? id : null;
    }

    return null;
  } catch {
    // missing SESSION_SECRET in production → no session is valid (fail closed)
    return null;
  }
}

// ----- admin (market owner) -----
function adminToken(): string {
  return createHash("sha256").update(`nm:${process.env.ADMIN_PASSWORD}`).digest("hex");
}

export function isAdmin(): boolean {
  if (!process.env.ADMIN_PASSWORD) return false;
  /* A named person signed in on this device wins over the shared owner
     password. The owner session lasts 90 days and used to be checked first
     everywhere, so on a computer where it had ever been used, a manager
     signing in with their own account was quietly treated as the owner —
     the owner's name, the owner's access, on every screen. Whoever signed in
     as themselves is who is using it. */
  if (currentEmployeeId() !== null) return false;
  const raw = cookies().get(ADMIN_COOKIE)?.value;
  if (!raw) return false;
  const token = adminToken();
  // legacy admin cookie: the bare token, no signature and no issued-at
  if (!raw.includes(".")) return withinLegacyGrace() && safeEqualHex(raw, token);
  const id = verifySession("admin", raw);
  return id !== null && safeEqualHex(id, token);
}

export function adminCookie(): { name: string; value: string } {
  return { name: ADMIN_COOKIE, value: issueSession("admin", adminToken()) };
}

// ----- employee sessions (limited staff role) -----
export function staffCookie(employeeId: string): { name: string; value: string } {
  return { name: STAFF_COOKIE, value: issueSession("staff", employeeId) };
}

export function currentEmployeeId(): string | null {
  const raw = cookies().get(STAFF_COOKIE)?.value;
  if (!raw) return null;
  return verifySession("staff", raw);
}

// admin OR signed-in employee — for daily-operations endpoints
export function isStaff(): boolean {
  return isAdmin() || currentEmployeeId() !== null;
}

// ----- vendor accounts -----
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  let test: Buffer;
  try {
    test = scryptSync(password, salt, 32);
  } catch {
    return false;
  }
  const real = Buffer.from(hash, "hex");
  return test.length === real.length && timingSafeEqual(test, real);
}

export function vendorCookie(vendorId: string): { name: string; value: string } {
  return { name: VENDOR_COOKIE, value: issueSession("vendor", vendorId) };
}

export function currentVendorId(): string | null {
  const raw = cookies().get(VENDOR_COOKIE)?.value;
  if (!raw) return null;
  return verifySession("vendor", raw);
}

// ---------------------------------------------------------------------------
// Self-serve password reset links
//
// Format:  base64url(<vendorId>).<expiryEpochSeconds>.<hmacHex>
//   hmac = HMAC-SHA256(secret, "reset:<vendorId>:<expiry>:<passwordHash>")
//
// There is deliberately NO reset-token table. Everything the server needs to
// judge a link is either inside the link or already on the vendor row:
//
//   1. Expiry  — the deadline is signed, so it can't be pushed out, and
//      verification refuses anything past it (RESET_TOKEN_TTL_SECONDS).
//   2. Single use — the vendor's CURRENT passwordHash is an input to the
//      signature. The moment the password changes (by this link, by a later
//      link, or by an admin-issued temporary password) every previously issued
//      link stops verifying. That is why verification has to load the vendor
//      and recompute against what's stored right now, and why this function is
//      async while the rest of this file isn't.
//   3. No storage — nothing is written anywhere when a link is issued.
//
// A link therefore proves: "whoever holds this was emailed it within the last
// hour, and the account's password hasn't moved since."
// ---------------------------------------------------------------------------

/** Reset links are good for 60 minutes. */
export const RESET_TOKEN_TTL_SECONDS = 60 * 60;

function signReset(vendorId: string, expiry: string, passwordHash: string): string {
  return createHmac("sha256", secret()).update(`reset:${vendorId}:${expiry}:${passwordHash}`).digest("hex");
}

/**
 * Mint a password-reset token for `vendorId`, bound to `passwordHash`
 * (the vendor's hash as it is right now).
 *
 * Throws ConfigError when SESSION_SECRET is missing in production — callers
 * inside `runRoute` turn that into a clean 500.
 */
export function makeResetToken(vendorId: string, passwordHash: string): string {
  const expiry = String(Math.floor(Date.now() / 1000) + RESET_TOKEN_TTL_SECONDS);
  const encodedId = Buffer.from(String(vendorId), "utf8").toString("base64url");
  return `${encodedId}.${expiry}.${signReset(String(vendorId), expiry, String(passwordHash))}`;
}

/**
 * Returns the vendor a reset token is good for, or null.
 *
 * Null covers every failure — malformed, unparseable, expired, unknown vendor,
 * bad signature, already-used (password since changed), or a missing secret.
 * Never throws, so route handlers can treat "not null" as the only green light.
 */
export async function verifyResetToken(token: string): Promise<{ vendorId: string } | null> {
  try {
    if (typeof token !== "string" || token.length === 0 || token.length > 512) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedId, expiry, sig] = parts;
    if (!encodedId || !expiry || !sig) return null;
    if (!/^\d{1,15}$/.test(expiry)) return null;
    if (!/^[0-9a-f]{64}$/i.test(sig)) return null;

    const exp = Number(expiry);
    if (!Number.isFinite(exp)) return null;
    if (Math.floor(Date.now() / 1000) > exp) return null;

    // base64url decoding is lenient, so sanity-check the shape of what came out
    // rather than trusting it — cuids are [a-z0-9] but stay permissive.
    const vendorId = Buffer.from(encodedId, "base64url").toString("utf8");
    if (!vendorId || vendorId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(vendorId)) return null;

    const vendor = await db.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, passwordHash: true },
    });
    if (!vendor) return null;

    // Recomputed against the CURRENT hash — this is what makes the link
    // single-use without anything being stored.
    if (!safeEqualHex(sig, signReset(vendor.id, expiry, vendor.passwordHash))) return null;

    return { vendorId: vendor.id };
  } catch {
    return null;
  }
}

// ----- employee PINs -----
//
// Historically PINs were stored as an unsalted sha256("pin:" + pin) — 64 hex
// chars, no salt, trivially rainbow-tabled. We cannot migrate the column, so
// verifyPin() accepts BOTH that legacy format and the salted scrypt format
// produced by hashPassword(), and call sites transparently re-write a legacy
// hash to scrypt on the next successful PIN entry (see pinUpgrade()).

/** true when `stored` is the old unsalted sha256 digest rather than salt:hash scrypt. */
export function isLegacyPinHash(stored: string): boolean {
  return typeof stored === "string" && /^[0-9a-f]{64}$/i.test(stored);
}

function legacyPinHash(pin: string): string {
  return createHash("sha256").update(`pin:${pin}`).digest("hex");
}

/** Hash a PIN for storage — always the salted scrypt format. */
export function hashPin(pin: string): string {
  return hashPassword(pin);
}

/** Constant-time-ish check of a PIN against either storage format. */
export function verifyPin(pin: string, stored: string): boolean {
  const p = typeof pin === "string" ? pin : "";
  if (!stored) return false;
  if (isLegacyPinHash(stored)) return safeEqualHex(legacyPinHash(p), stored);
  return verifyPassword(p, stored);
}

/**
 * After a successful verifyPin(), returns the scrypt hash to persist when the
 * stored value is still in the legacy format, or null when nothing to do.
 * Callers write it back: `if (up) await db.employee.update({ ... pinHash: up })`.
 */
export function pinUpgrade(pin: string, stored: string): string | null {
  return isLegacyPinHash(stored) ? hashPin(pin) : null;
}

/** Cookie flags every session cookie must be set with. */
export const SESSION_COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax", secure: true } as const;

export const cookieNames = { ADMIN_COOKIE, VENDOR_COOKIE, STAFF_COOKIE };

type CookieWriter = { cookies: { set: (name: string, value: string, opts: Record<string, unknown>) => unknown } };

/**
 * Sign-in replaces whoever was signed in before, rather than stacking on top.
 *
 * The owner password and personal accounts are separate cookies, and nothing
 * used to remove the other one — so two identities lived on the same device
 * and the app had to guess which was real. Every sign-in now clears the other
 * kind, and every sign-out clears both.
 */
export function clearOwnerSession(res: CookieWriter): void {
  res.cookies.set(ADMIN_COOKIE, "", { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
}
export function clearStaffSession(res: CookieWriter): void {
  res.cookies.set(STAFF_COOKIE, "", { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
}
export function clearAllStaffSessions(res: CookieWriter): void {
  clearOwnerSession(res);
  clearStaffSession(res);
}

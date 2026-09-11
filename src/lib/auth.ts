import { cookies } from "next/headers";
import { createHash, createHmac, scryptSync, randomBytes, timingSafeEqual } from "crypto";

const ADMIN_COOKIE = "nm_admin";
const VENDOR_COOKIE = "nm_vendor";

function secret(): string {
  return process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "dev-secret";
}

// ----- admin (market owner) -----
function adminToken(): string {
  return createHash("sha256").update(`nm:${process.env.ADMIN_PASSWORD}`).digest("hex");
}

export function isAdmin(): boolean {
  if (!process.env.ADMIN_PASSWORD) return false;
  return cookies().get(ADMIN_COOKIE)?.value === adminToken();
}

export function adminCookie(): { name: string; value: string } {
  return { name: ADMIN_COOKIE, value: adminToken() };
}

// ----- vendor accounts -----
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = scryptSync(password, salt, 32);
  const real = Buffer.from(hash, "hex");
  return test.length === real.length && timingSafeEqual(test, real);
}

function signVendor(vendorId: string): string {
  const sig = createHmac("sha256", secret()).update(vendorId).digest("hex");
  return `${vendorId}.${sig}`;
}

export function vendorCookie(vendorId: string): { name: string; value: string } {
  return { name: VENDOR_COOKIE, value: signVendor(vendorId) };
}

export function currentVendorId(): string | null {
  const raw = cookies().get(VENDOR_COOKIE)?.value;
  if (!raw) return null;
  const [id, sig] = raw.split(".");
  if (!id || !sig) return null;
  const expect = createHmac("sha256", secret()).update(id).digest("hex");
  return sig === expect ? id : null;
}

export const cookieNames = { ADMIN_COOKIE, VENDOR_COOKIE };

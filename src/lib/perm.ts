import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin, currentEmployeeId } from "@/lib/auth";
import { type Role, type Capability, can, normalizeRole } from "@/lib/roles";

/**
 * Session-aware permission checks. SERVER ONLY — this reaches for cookies and
 * the database, so importing it from a client component pulls `next/headers`
 * into the browser bundle and fails the build. Client code wants @/lib/roles.
 */

export { ROLE_LABEL, ROLE_BLURB, can, capabilitiesFor, normalizeRole } from "@/lib/roles";
export type { Role, Capability } from "@/lib/roles";

/**
 * The role of whoever is making this request, or null if nobody is.
 *
 * The ADMIN_PASSWORD session stays OWNER. It predates individual accounts and
 * is the way back in if an owner account is ever locked out or mistyped, so it
 * is deliberately not being removed.
 */
export async function currentRole(): Promise<Role | null> {
  if (isAdmin()) return "OWNER";
  const empId = currentEmployeeId();
  if (!empId) return null;
  const emp = await db.employee.findUnique({
    where: { id: empId },
    select: { active: true, role: true },
  });
  if (!emp || !emp.active) return null;
  return normalizeRole(emp.role);
}

export type Actor = { role: Role; employeeId: string | null };

export async function currentActor(): Promise<Actor | null> {
  const role = await currentRole();
  if (!role) return null;
  return { role, employeeId: isAdmin() ? null : currentEmployeeId() };
}

/**
 * Route guard. Returns a response to send when the caller may NOT proceed, and
 * null when they may:
 *
 *   const denied = await denyUnless("market");
 *   if (denied) return denied;
 *
 * 401 for "we don't know who you are" and 403 for "we do, and no" — so a
 * signed-in manager hitting an owner-only screen gets told they lack access
 * rather than being bounced to a login they're already past.
 */
export async function denyUnless(cap: Capability): Promise<NextResponse | null> {
  const role = await currentRole();
  if (!role) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(role, cap)) {
    return NextResponse.json(
      { error: "Your account doesn't have access to that. Ask the owner if you need it." },
      { status: 403 }
    );
  }
  return null;
}

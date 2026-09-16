import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin, currentEmployeeId } from "@/lib/auth";

/**
 * Who can do what.
 *
 * THE POINT OF THIS FILE: hiding a tab is not security. A manager whose browser
 * never renders the Payroll button can still POST to /api/admin/payroll with
 * two lines of JavaScript. So every route is gated by a CAPABILITY here, and
 * the navigation is derived from the same table — the screen and the server can
 * disagree about what's pretty, never about what's allowed.
 *
 * THREE ROLES:
 *   OWNER    — everything. Kalie.
 *   MANAGER  — runs the market day to day: vendors, agreements, applications,
 *              and chasing what's owed. Cannot move money, see the books, touch
 *              payroll, or change settings.
 *   EMPLOYEE — the register, the drawer, their own timeclock. What a cashier
 *              needs and nothing else.
 *
 * Adding a capability is deliberately a bit of work: a new one has to be named
 * here, granted to a role here, and asserted in the route. That friction is the
 * feature — it's what stops a new endpoint quietly shipping wide open.
 */

export type Role = "OWNER" | "MANAGER" | "EMPLOYEE";

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner",
  MANAGER: "Office manager",
  EMPLOYEE: "Employee",
};

export const ROLE_BLURB: Record<Role, string> = {
  OWNER: "Everything, including payroll, settings, refunds and the books.",
  MANAGER: "Vendors, agreements, applications and chasing what's owed — plus the register. No payroll, settings, refunds or financials.",
  EMPLOYEE: "The register, the drawer and their own time clock.",
};

export type Capability =
  /** Register, drawer, tickets, item lookup, time clock, customer lookup. */
  | "ops"
  /** Vendors, agreements, applications, onboarding, calendar, complaints, posts, tents, customers. */
  | "market"
  /** The invoice ledger and chasing what's owed: reading balances, re-sending pay links. */
  | "collections"
  /** Money going OUT: refunds, voids, balance adjustments, charging a card on file. */
  | "money"
  /** Reports, Stripe balance, payouts, month-end settlement. */
  | "financials"
  /** Employees, roles, wages, W-4s, staff documents, push alerts. */
  | "people"
  /** Tax rates, market configuration. */
  | "config";

const GRANTS: Record<Role, Capability[]> = {
  OWNER: ["ops", "market", "collections", "money", "financials", "people", "config"],
  MANAGER: ["ops", "market", "collections"],
  EMPLOYEE: ["ops"],
};

export function normalizeRole(raw: unknown): Role {
  const v = String(raw || "").toUpperCase();
  if (v === "OWNER") return "OWNER";
  if (v === "MANAGER") return "MANAGER";
  // Anything unrecognised is the least privileged role, never the most.
  return "EMPLOYEE";
}

export function can(role: Role | null, cap: Capability): boolean {
  if (!role) return false;
  return GRANTS[role].includes(cap);
}

export function capabilitiesFor(role: Role | null): Capability[] {
  return role ? [...GRANTS[role]] : [];
}

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

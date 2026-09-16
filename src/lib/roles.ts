/**
 * Roles and what they can reach — the pure half.
 *
 * Deliberately free of `next/headers`, Prisma and anything else that only
 * exists on the server, because the admin screen is a client component and
 * imports the labels from here. Pulling the server half into that bundle is
 * exactly what broke the build: a "use client" file importing one constant
 * drags the whole module graph behind it, including `cookies()`.
 *
 * The guards that read a session live in @/lib/perm and import from this file.
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

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin, currentEmployeeId } from "@/lib/auth";
import { currentRole, capabilitiesFor, normalizeRole, ROLE_LABEL } from "@/lib/perm";

export const dynamic = "force-dynamic";

export async function GET() {
  /* `role` keeps its old two values ("admin" | "staff") so nothing that already
     reads it breaks; `access` carries the new one, plus the capability list the
     navigation is built from. */
  if (isAdmin()) {
    return NextResponse.json({ role: "admin", access: "OWNER", roleLabel: ROLE_LABEL.OWNER, capabilities: capabilitiesFor("OWNER") });
  }
  const empId = currentEmployeeId();
  if (empId) {
    const emp = await db.employee.findUnique({ where: { id: empId }, select: { name: true, active: true, role: true } });
    if (emp?.active) {
      const access = normalizeRole(emp.role);
      return NextResponse.json({
        // An owner or manager account still reports role "staff" here — the old
        // field means "not the shared admin password", and changing it would
        // silently alter every existing check that reads it.
        role: "staff",
        name: emp.name,
        access,
        roleLabel: ROLE_LABEL[access],
        capabilities: capabilitiesFor(access),
      });
    }
  }
  return NextResponse.json({ role: null }, { status: 401 });
}

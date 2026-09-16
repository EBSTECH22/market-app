import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentEmployeeId, hashPassword, verifyPassword } from "@/lib/auth";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";
import { normalizeRole, ROLE_LABEL } from "@/lib/roles";

export const dynamic = "force-dynamic";

/**
 * Your own account: see it, change your own email and password.
 *
 * Deliberately NOT part of /api/admin/team/access, which needs the "people"
 * capability. Changing your own password is not an administrative act — a
 * manager has to be able to do it without being able to touch anyone else's,
 * and an owner shouldn't have to go through the team roster to rotate their
 * own.
 *
 * Nothing here can change a ROLE. That stays on the admin route with its own
 * guard rails, so this endpoint can never become a way to promote yourself.
 */

export async function GET() {
  return runRoute("staff/me GET", async () => {
    const empId = currentEmployeeId();
    if (!empId) {
      /* An ADMIN_PASSWORD session is not a person — there's no Employee row
         behind it, so there's nothing here to edit. Say that plainly instead
         of 401ing, because the caller IS signed in and the UI needs to show
         them why this screen is empty. */
      return NextResponse.json({ account: null, reason: "shared-password" });
    }
    const emp = await db.employee.findUnique({
      where: { id: empId },
      select: { id: true, name: true, email: true, role: true, active: true, passwordHash: true, mustChangePassword: true },
    });
    if (!emp || !emp.active) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const role = normalizeRole(emp.role);
    return NextResponse.json({
      account: {
        id: emp.id, name: emp.name, email: emp.email || "",
        role, roleLabel: ROLE_LABEL[role],
        hasPassword: !!emp.passwordHash,
        mustChangePassword: !!emp.mustChangePassword,
      },
    });
  });
}

// PATCH { email?, currentPassword?, newPassword? }
export async function PATCH(req: NextRequest) {
  return runRoute("staff/me PATCH", async () => {
    const empId = currentEmployeeId();
    if (!empId) {
      return NextResponse.json(
        { error: "You're signed in with the shared admin password, which isn't a personal account. Make yourself an Owner account on the Team page first." },
        { status: 400 }
      );
    }

    const emp = await db.employee.findUnique({ where: { id: empId } });
    if (!emp || !emp.active) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const data: { email?: string; passwordHash?: string; mustChangePassword?: boolean } = {};

    if (body.email !== undefined) {
      const addr = String(body.email).toLowerCase().trim();
      if (addr) {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
          return NextResponse.json({ error: "That email doesn't look right." }, { status: 400 });
        }
        const clash = await db.employee.findFirst({
          where: { email: { equals: addr, mode: "insensitive" }, id: { not: emp.id } },
          select: { id: true },
        });
        if (clash) return NextResponse.json({ error: "Somebody else already uses that email." }, { status: 409 });
      } else if (normalizeRole(emp.role) !== "EMPLOYEE") {
        /* Clearing your own email when it's how you sign in locks you out of
           your own account. Refuse rather than let someone discover it at the
           next login screen. */
        return NextResponse.json({ error: "That's how you sign in — you can't remove it." }, { status: 400 });
      }
      data.email = addr;
    }

    if (body.newPassword !== undefined) {
      const next = String(body.newPassword);
      if (next.length < 8) {
        return NextResponse.json({ error: "Password needs to be at least 8 characters." }, { status: 400 });
      }
      /* Proving you know the current one is what stops a walk-up at an unlocked
         screen from quietly taking the account over. Skipped only when there is
         no password yet — a first-time set has nothing to prove. */
      if (emp.passwordHash) {
        const limited = await enforceRateLimit(req, "staff-me-password", emp.id, LIMITS.login, "Too many attempts.");
        if (limited) return limited;
        if (!verifyPassword(String(body.currentPassword || ""), emp.passwordHash)) {
          return NextResponse.json({ error: "That's not your current password." }, { status: 401 });
        }
      }
      data.passwordHash = hashPassword(next);
      data.mustChangePassword = false;
    }

    if (!Object.keys(data).length) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    const updated = await db.employee.update({ where: { id: emp.id }, data });
    return NextResponse.json({ ok: true, account: { email: updated.email, hasPassword: !!updated.passwordHash } });
  });
}

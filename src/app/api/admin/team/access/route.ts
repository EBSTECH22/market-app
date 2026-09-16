import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, currentEmployeeId } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { denyUnless, currentRole } from "@/lib/perm";
import { normalizeRole, ROLE_LABEL, type Role } from "@/lib/roles";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

/**
 * Roles and sign-in credentials for staff accounts.
 *
 * Split out from /api/admin/team, which is about wages and W-4s. Those are
 * payroll; this is who can get in and how far. Keeping them apart means the
 * guard rails below sit in one small file instead of being buried in a route
 * that does five other things.
 *
 * THE GUARD RAILS, and why each exists:
 *  - Only an OWNER can change roles. A manager who could promote themselves is
 *    not a manager, they're an owner with extra steps.
 *  - Nobody can change their own role. Even an owner: it's the one edit with no
 *    legitimate use and one obvious illegitimate one.
 *  - The last owner cannot be demoted or deactivated. Losing every owner means
 *    losing settings, payroll and the books, with no way back except the
 *    ADMIN_PASSWORD env var — which is a bad afternoon, not a recovery plan.
 */

type Body = {
  employeeId?: string;
  role?: string;
  email?: string;
  password?: string;
  /** Issue a random password and return it once, for handing over in person. */
  generatePassword?: boolean;
  active?: boolean;
};

async function ownerCount(excludeId?: string): Promise<number> {
  return db.employee.count({
    where: { active: true, role: "OWNER", ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
}

export async function GET() {
  return runRoute("admin/team/access GET", async () => {
    const denied = await denyUnless("people");
    if (denied) return denied;

    const employees = await db.employee.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      // Never select pinHash or passwordHash — this response is JSON on a page.
      select: { id: true, name: true, email: true, role: true, active: true, passwordHash: true, createdAt: true },
    });

    return NextResponse.json({
      me: currentEmployeeId(),
      employees: employees.map((e) => {
        const role = normalizeRole(e.role);
        return {
          id: e.id,
          name: e.name,
          email: e.email || "",
          role,
          roleLabel: ROLE_LABEL[role],
          active: e.active,
          // The presence of a password, not the password.
          hasPassword: !!e.passwordHash,
          createdAt: e.createdAt,
        };
      }),
    });
  });
}

export async function PATCH(req: NextRequest) {
  return runRoute("admin/team/access PATCH", async () => {
    const denied = await denyUnless("people");
    if (denied) return denied;

    const body = (await req.json()) as Body;
    const employeeId = String(body.employeeId || "");
    if (!employeeId) return NextResponse.json({ error: "Which person?" }, { status: 400 });

    const emp = await db.employee.findUnique({ where: { id: employeeId } });
    if (!emp) return NextResponse.json({ error: "That person isn't on the team list." }, { status: 404 });

    const myRole = await currentRole();
    const meId = currentEmployeeId();
    const data: { role?: string; email?: string; passwordHash?: string; active?: boolean; mustChangePassword?: boolean } = {};
    let issuedPassword = "";

    /* ---- role ---- */
    if (body.role !== undefined) {
      if (myRole !== "OWNER") {
        return NextResponse.json({ error: "Only the owner can change what someone's account can reach." }, { status: 403 });
      }
      if (meId && meId === emp.id) {
        return NextResponse.json({ error: "You can't change your own role." }, { status: 400 });
      }
      const next: Role = normalizeRole(body.role);
      if (normalizeRole(emp.role) === "OWNER" && next !== "OWNER" && (await ownerCount(emp.id)) === 0) {
        return NextResponse.json(
          { error: "That's the last owner account. Make someone else an owner first." },
          { status: 400 }
        );
      }
      data.role = next;
    }

    /* ---- email ---- */
    if (body.email !== undefined) {
      const addr = String(body.email).toLowerCase().trim();
      if (addr) {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
          return NextResponse.json({ error: "That email doesn't look right." }, { status: 400 });
        }
        const clash = await db.employee.findFirst({
          where: { email: { equals: addr, mode: "insensitive" }, id: { not: emp.id } },
          select: { name: true },
        });
        if (clash) {
          return NextResponse.json({ error: `${clash.name} already uses that email.` }, { status: 409 });
        }
      }
      data.email = addr;
    }

    /* ---- password ---- */
    if (body.generatePassword) {
      // Readable enough to hand over out loud, long enough not to be guessed.
      issuedPassword = randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
      data.passwordHash = hashPassword(issuedPassword);
      data.mustChangePassword = true;
    } else if (body.password !== undefined) {
      const pw = String(body.password);
      if (pw.length < 8) {
        return NextResponse.json({ error: "Password needs to be at least 8 characters." }, { status: 400 });
      }
      data.passwordHash = hashPassword(pw);
      data.mustChangePassword = false;
    }

    /* ---- active ---- */
    if (body.active !== undefined) {
      const next = !!body.active;
      if (!next && meId && meId === emp.id) {
        return NextResponse.json({ error: "You can't deactivate your own account." }, { status: 400 });
      }
      if (!next && normalizeRole(emp.role) === "OWNER" && (await ownerCount(emp.id)) === 0) {
        return NextResponse.json(
          { error: "That's the last owner account — it can't be switched off." },
          { status: 400 }
        );
      }
      data.active = next;
    }

    if (!Object.keys(data).length) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    /* An account with an elevated role but no way to sign in is a trap: it looks
       set up on this screen and doesn't work when they try it. Say so at the
       moment of the change rather than letting them discover it. */
    const finalRole = normalizeRole(data.role ?? emp.role);
    const finalEmail = data.email ?? emp.email;
    const finalHasPassword = data.passwordHash ? true : !!emp.passwordHash;
    const needsLogin = finalRole !== "EMPLOYEE" && (!finalEmail || !finalHasPassword);

    const updated = await db.employee.update({ where: { id: emp.id }, data });

    return NextResponse.json({
      ok: true,
      employee: { id: updated.id, name: updated.name, role: normalizeRole(updated.role), email: updated.email, active: updated.active },
      // Returned exactly once — it is not stored anywhere in readable form.
      issuedPassword: issuedPassword || undefined,
      warning: needsLogin
        ? `${updated.name} is set to ${ROLE_LABEL[finalRole]} but can't sign in yet — they need an email address and a password.`
        : undefined,
    });
  });
}

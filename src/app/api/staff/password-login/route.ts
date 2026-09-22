import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword, staffCookie, SESSION_COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS, clearOwnerSession, clearAllStaffSessions } from "@/lib/auth";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";
import { normalizeRole, ROLE_LABEL } from "@/lib/perm";

export const dynamic = "force-dynamic";

/**
 * Email + password sign-in for owners and office managers.
 *
 * Separate from the PIN routes on purpose. A four-digit PIN is fine for opening
 * a till in front of you; it is thin for an account that can edit agreements
 * and vendor records, and it gets typed where customers can watch. Employees
 * keep the PIN, because that's what standing at a register actually needs.
 *
 * Sets the same staff cookie the PIN routes set, so everything downstream —
 * the capability checks, the drawer, the register — works identically however
 * somebody signed in. The role is read from the database on each request rather
 * than baked into the cookie, so revoking access takes effect immediately
 * instead of whenever a session happens to expire.
 */
export async function POST(req: NextRequest) {
  return runRoute("staff/password-login POST", async () => {
    const { email, password } = await req.json();
    const addr = String(email || "").toLowerCase().trim();

    const limited = await enforceRateLimit(req, "staff-password", addr, LIMITS.login, "Too many sign-in attempts.");
    if (limited) return limited;

    if (!addr || !password) {
      return NextResponse.json({ error: "Email and password required." }, { status: 400 });
    }

    const emp = await db.employee.findFirst({
      where: { email: { equals: addr, mode: "insensitive" } },
    });

    /* One message for "no such account", "no password set" and "wrong
       password". Telling them which is a free list of who works here. */
    const bad = NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
    if (!emp || !emp.active || !emp.passwordHash) return bad;
    if (!verifyPassword(String(password), emp.passwordHash)) return bad;

    const role = normalizeRole(emp.role);
    if (role === "EMPLOYEE") {
      /* An employee with a password but no elevated role has nothing this login
         unlocks that their PIN doesn't, and sending them here instead of the
         register is a dead end. */
      return NextResponse.json(
        { error: "Sign in with your PIN at the register instead." },
        { status: 403 }
      );
    }

    const res = NextResponse.json({
      ok: true,
      employee: { id: emp.id, name: emp.name, role, roleLabel: ROLE_LABEL[role] },
      mustChangePassword: !!emp.mustChangePassword,
    });
    clearOwnerSession(res);
    const c = staffCookie(emp.id);
    res.cookies.set(c.name, c.value, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_SECONDS.staff });
    return res;
  });
}

/* Signing out clears BOTH the personal session and the owner password, so the
   next person to open the app on this device gets the sign-in screen, not the
   previous person's account. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  clearAllStaffSessions(res);
  return res;
}

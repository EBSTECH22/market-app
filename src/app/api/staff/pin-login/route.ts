import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { staffCookie, verifyPin, pinUpgrade, SESSION_COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS } from "@/lib/auth";
import { enforceRateLimit, LIMITS, clientIp } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";

export const dynamic = "force-dynamic";

/**
 * Sign in to the register kiosk with a PIN alone — no name to pick first.
 *
 * WHY IT LOOKS LIKE THIS: PINs are salted scrypt hashes, so there is no way to
 * look someone up BY their PIN. The only option is to try each active employee
 * in turn. That is fine at this scale — a market has a handful of staff, and a
 * handful of scrypt verifies is milliseconds — but it would not be fine at a
 * hundred, and this comment is here so nobody wonders later.
 *
 * SECURITY, PLAINLY: a PIN alone is weaker than a name plus a PIN. It is a
 * 4-digit secret against a device standing in a public market. Three things
 * hold it up:
 *   - rate limiting by IP (not by the PIN, which would let an attacker reset
 *     their own budget by guessing a different number each time)
 *   - refusing to sign anyone in when two employees share a PIN, since "some
 *     employee" on a ticket is worse than no ticket
 *   - a session that expires, so a walk-away doesn't stay open forever
 * The name+PIN endpoint is untouched and is still what /admin uses.
 */
export async function POST(req: NextRequest) {
  return runRoute("staff/pin-login POST", async () => {
    const { pin } = await req.json();
    const entered = String(pin || "").trim();

    /* Keyed on IP ONLY. The obvious thing — keying on the PIN, the way the
       name+PIN endpoint keys on the name — is wrong here: the PIN is the thing
       being guessed, so each new guess would land in a fresh bucket and the
       limit would never bite. */
    const limited = await enforceRateLimit(req, "staff-pin-kiosk", clientIp(req), LIMITS.pin, "Too many PIN attempts.");
    if (limited) return limited;

    if (!/^\d{3,12}$/.test(entered)) {
      return NextResponse.json({ error: "Enter your PIN." }, { status: 400 });
    }

    const employees = await db.employee.findMany({
      where: { active: true },
      select: { id: true, name: true, pinHash: true },
      orderBy: { name: "asc" },
    });

    const matches = employees.filter((e) => verifyPin(entered, e.pinHash));

    if (matches.length === 0) {
      return NextResponse.json({ error: "That PIN doesn't match anyone." }, { status: 401 });
    }
    if (matches.length > 1) {
      /* Refuse rather than pick one. Signing in as whichever row sorted first
         would put the wrong name on every ticket that shift, and the drawer
         count would be attributed to someone who never touched it. */
      console.error(`[pin-login] shared PIN across ${matches.length} employees: ${matches.map((m) => m.name).join(", ")}`);
      return NextResponse.json(
        { error: "More than one person has that PIN. Ask the owner to give you your own before signing in." },
        { status: 409 }
      );
    }

    const emp = matches[0];

    // Same quiet upgrade the name+PIN route does: legacy unsalted sha256 PINs
    // get re-stored as salted scrypt the first time they're verified.
    const upgraded = pinUpgrade(entered, emp.pinHash);
    if (upgraded) {
      try {
        await db.employee.update({ where: { id: emp.id }, data: { pinHash: upgraded } });
      } catch (err) {
        console.error("pin hash upgrade failed", err);
      }
    }

    const res = NextResponse.json({ ok: true, employee: { id: emp.id, name: emp.name } });
    const c = staffCookie(emp.id);
    res.cookies.set(c.name, c.value, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_SECONDS.staff });
    return res;
  });
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("nm_staff", "", { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
  return res;
}

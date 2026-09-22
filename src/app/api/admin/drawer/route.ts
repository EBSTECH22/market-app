import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPin, pinUpgrade, currentEmployeeId } from "@/lib/auth";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";
import { denyUnless, currentRole, can } from "@/lib/perm";
import { drawerForRequest, drawerCashCents, openDrawers, openDrawerFor, signedInEmployee, type DrawerRow } from "@/lib/drawer";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * GET — YOUR drawer, plus a list of every drawer open right now.
 *
 * `session` is the signed-in person's own drawer (or, for the shared owner
 * password, the only one open). It used to be "the" open drawer for the whole
 * market, which is why everyone saw the name of whoever opened up first.
 */
export async function GET() {
  { const denied = await denyUnless("ops"); if (denied) return denied; }
  const { drawer, who, ambiguous } = await drawerForRequest();
  const all = await openDrawers();
  const open = all.map((d) => ({ id: d.id, employee: d.employee, openedAt: d.openedAt, mine: !!drawer && d.id === drawer.id }));
  if (!drawer) return NextResponse.json({ session: null, open, me: who?.name || "", ambiguous });
  const cashSalesCents = await drawerCashCents(drawer);
  return NextResponse.json({ session: { ...drawer, cashSalesCents }, open, me: who?.name || "" });
}

export async function POST(req: NextRequest) {
  return runRoute("admin/drawer POST", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const { employee, pin, counts, totalCents } = await req.json();
    const who = String(employee || "");

    /* Two ways in, same strength.
       /admin sends a name and a PIN, because an owner opening the drawer for
       someone has no staff session of their own to speak for that person.
       The kiosk sends neither: whoever is standing there already proved a PIN
       to unlock the screen, and that session says who they are. Asking for the
       same PIN twice in thirty seconds teaches people to type it where anyone
       can watch, which is worse than not asking. */
    let emp: { id: string; name: string; active: boolean; pinHash: string } | null = null;

    if (who || pin) {
      const limited = await enforceRateLimit(req, "drawer-pin", who, LIMITS.pin, "Too many PIN attempts.");
      if (limited) return limited;

      const found = await db.employee.findUnique({ where: { name: who } });
      if (!found || !found.active || !verifyPin(String(pin || ""), found.pinHash)) {
        return NextResponse.json({ error: "Wrong employee or PIN." }, { status: 401 });
      }
      const upgraded = pinUpgrade(String(pin || ""), found.pinHash);
      if (upgraded) {
        try {
          await db.employee.update({ where: { id: found.id }, data: { pinHash: upgraded } });
        } catch (err) {
          console.error("pin hash upgrade failed", err);
        }
      }
      emp = found;
    } else {
      const empId = currentEmployeeId();
      if (!empId) {
        // An admin-password session isn't a person, so it can't open a drawer
        // in anyone's name. Say which thing is missing.
        return NextResponse.json({ error: "Sign in with your PIN before opening the drawer." }, { status: 401 });
      }
      const found = await db.employee.findUnique({ where: { id: empId } });
      if (!found || !found.active) {
        return NextResponse.json({ error: "That employee is no longer active." }, { status: 401 });
      }
      emp = found;
    }

    // Both branches above either assign `emp` or return, but narrowing doesn't
    // survive the await, so make it explicit rather than asserting.
    if (!emp) return NextResponse.json({ error: "Couldn't work out who's opening the drawer." }, { status: 401 });

    /* One open drawer per PERSON. Somebody else having a drawer open is
       normal — two cashiers, two tills — and is no reason to refuse. */
    const existing = await openDrawerFor({ id: emp.id, name: emp.name });
    if (existing) return NextResponse.json({ error: `${emp.name} already has a drawer open. Close it first.` }, { status: 400 });

    const session = await db.drawerSession.create({
      data: {
        employee: emp.name,
        employeeId: emp.id,
        openTotalCents: Math.max(0, Math.round(Number(totalCents) || 0)),
        openCounts: JSON.stringify(counts || {}),
      },
    });
    return NextResponse.json({ session });
  });
}

export async function PATCH(req: NextRequest) {
  { const denied = await denyUnless("ops"); if (denied) return denied; }
  const { counts, countedCents, drawerId } = await req.json();

  /* Your own drawer by default. Closing SOMEONE ELSE'S — a cashier who went
     home without counting out — is a money decision, so it needs the money
     capability, and it has to name the drawer rather than guess. */
  let session: DrawerRow | null = null;
  if (drawerId) {
    session = await db.drawerSession.findUnique({ where: { id: String(drawerId) } });
    if (!session || session.status !== "OPEN") return NextResponse.json({ error: "That drawer isn't open." }, { status: 400 });
    const me = await signedInEmployee();
    const isMine = !!me && (session.employeeId === me.id || (!session.employeeId && session.employee === me.name));
    if (!isMine) {
      const role = await currentRole();
      if (!role || !can(role, "money")) {
        return NextResponse.json({ error: "Only an owner or manager can close somebody else's drawer." }, { status: 403 });
      }
    }
  } else {
    const { drawer, ambiguous } = await drawerForRequest();
    if (!drawer) {
      return NextResponse.json(
        { error: ambiguous ? "More than one drawer is open. Sign in as yourself, or pick which one to close." : "You don't have a drawer open." },
        { status: 400 }
      );
    }
    session = drawer;
  }

  const cashSalesCents = await drawerCashCents(session);
  const counted = Math.max(0, Math.round(Number(countedCents) || 0));
  const expected = session.openTotalCents + cashSalesCents;

  const closed = await db.drawerSession.update({
    where: { id: session.id },
    data: {
      status: "CLOSED",
      closedAt: new Date(),
      closeCounts: JSON.stringify(counts || {}),
      cashSalesCents,
      countedCents: counted,
      diffCents: counted - expected,
    },
  });
  /* Only a drawer that didn't balance goes in the log. Logging every clean
     close would bury the ones that matter — and a till that is out is the
     single most useful thing this log can show a month later. */
  if (closed.diffCents !== 0) {
    const over = closed.diffCents > 0;
    await recordAudit(
      {
        action: "DRAWER_CLOSE",
        targetType: "DRAWER",
        targetId: closed.id,
        targetLabel: closed.employee,
        amountCents: -closed.diffCents,
        detail: `Drawer closed $${(Math.abs(closed.diffCents) / 100).toFixed(2)} ${over ? "OVER" : "SHORT"} — counted $${(counted / 100).toFixed(2)}, expected $${(expected / 100).toFixed(2)}`,
        after: { countedCents: counted, expectedCents: expected, diffCents: closed.diffCents },
      },
      req
    );
  }

  return NextResponse.json({ session: closed, expected });
}

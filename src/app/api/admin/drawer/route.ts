import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPin, pinUpgrade, currentEmployeeId } from "@/lib/auth";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";
import { denyUnless, currentRole, can } from "@/lib/perm";
import { drawerForRequest, drawerCashCents, openDrawers, openDrawerFor, signedInEmployee, expectedCents, readAdjustments, clockInForDrawer, clockOutForDrawer, employeeIdForDrawer, type DrawerRow } from "@/lib/drawer";
import { printDrawerSlip } from "@/lib/receiptjob";
import { getTillSettings, getSingleRegister } from "@/lib/settings";
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

  /* WHAT'S ACTUALLY IN SOMEBODY ELSE'S TILL.
     
     This list used to be a name and a time, which is all anyone needed when
     the only thing you could do to another person's drawer was close it. An
     owner counting out a cashier who went home was doing it blind — no
     opening float, no idea what it had taken, no way to tell $40 short from
     $40 of paid-outs nobody wrote down. Anyone who can be trusted with the
     money can see the whole drawer. */
  const role = await currentRole();
  const seesAll = !!role && can(role, "money");

  const open = await Promise.all(
    all.map(async (d) => {
      const mine = !!drawer && d.id === drawer.id;
      const base = { id: d.id, employee: d.employee, openedAt: d.openedAt, mine };
      if (!seesAll && !mine) return base;
      const cash = await drawerCashCents(d);
      return {
        ...base,
        openTotalCents: d.openTotalCents,
        cashSalesCents: cash,
        adjustTotalCents: d.adjustTotalCents || 0,
        adjustments: readAdjustments(d.adjustmentsJson),
        expectedCents: expectedCents(d, cash),
      };
    })
  );

  if (!drawer) return NextResponse.json({ session: null, open, me: who?.name || "", ambiguous, canWorkOthers: seesAll });
  const cashSalesCents = await drawerCashCents(drawer);
  return NextResponse.json({
    session: { ...drawer, cashSalesCents, adjustments: readAdjustments(drawer.adjustmentsJson) },
    open,
    me: who?.name || "",
    canWorkOthers: seesAll,
  });
}

export async function POST(req: NextRequest) {
  return runRoute("admin/drawer POST", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const { employee, pin, counts, totalCents, printHere } = await req.json();
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

    /* One open drawer per PERSON — your own, still open, is yours to close. */
    const existing = await openDrawerFor({ id: emp.id, name: emp.name });
    if (existing) return NextResponse.json({ error: `${emp.name} already has a drawer open. Close it first.` }, { status: 400 });

    /* ------------------------------------------------ TAKING THE TILL ON --
    
       With one register, somebody else's drawer still being open does not mean
       two cashiers are working. It means the last person walked off without
       counting out, and without this every sale the new cashier rings would
       land on that person's shift — their name on the ticket, their drawer
       carrying the money, and a count at the end of the night covering two
       people's work with no way to separate them.
    
       THE RUNNING TOTAL TRANSFERS, COUNTED OR NOT. The money is physically
       still in the drawer: the float it started with, plus the cash taken,
       plus anything handed in or out. That figure is what the next person is
       holding, so that figure is what they start with — whether or not anybody
       stopped to count it. Making the handover depend on a count would mean a
       till that can't change hands until somebody has a quiet minute, which is
       never when it actually happens.
    
       The outgoing shift is therefore closed WITHOUT a verified count, and
       both the slip and the log say so rather than recording a tidy zero that
       nobody checked.
    
       Off the moment a second till exists; see getSingleRegister. */
    const takeoverCfg = await getTillSettings();
    const countedNow = Math.max(0, Math.round(Number(totalCents) || 0));
    let carriedCents: number | null = null;
    let handover: { employee: string; carriedCents: number } | null = null;

    if (await getSingleRegister()) {
      const others = (await openDrawers()).filter((d) => d.id !== existing?.id);
      for (const other of others) {
        const otherCash = await drawerCashCents(other);
        /* What is in the drawer right now, on the books. */
        const running = expectedCents(other, otherCash);

        const closedOther = await db.drawerSession.update({
          where: { id: other.id },
          data: {
            status: "CLOSED",
            closedAt: new Date(),
            cashSalesCents: otherCash,
            /* Not a count — the running total, carried across. diffCents stays
               0 because nothing was counted, and `handedOverTo` is what tells
               every later reader that this shift was never verified. */
            countedCents: running,
            diffCents: 0,
            handedOverTo: emp.name,
          },
        });

        /* Always logged, unlike an ordinary close: a shift that ended without
           being counted is exactly the one somebody will ask about later. */
        await recordAudit(
          {
            action: "DRAWER_CLOSE",
            targetType: "DRAWER",
            targetId: closedOther.id,
            targetLabel: closedOther.employee,
            detail:
              `Drawer taken over by ${emp.name} without being counted out. ` +
              `$${(running / 100).toFixed(2)} carried across to their shift. Not verified.`,
            after: { carriedCents: running, countedByIncoming: countedNow, handedOverTo: emp.name },
          },
          req
        );

        /* Off the clock. A forgotten punch would otherwise run all night. */
        try { await clockOutForDrawer(await employeeIdForDrawer(other)); } catch { /* the drawer is closed either way */ }

        await printDrawerSlip(
          {
            kind: "CLOSE",
            employee: closedOther.employee,
            at: closedOther.closedAt || new Date(),
            openTotalCents: closedOther.openTotalCents,
            cashSalesCents: otherCash,
            adjustTotalCents: closedOther.adjustTotalCents || 0,
            expectedCents: running,
            countedCents: running,
            diffCents: 0,
            notCounted: true,
            closedBy: emp.name,
            handedOverTo: emp.name,
          },
          { drawerId: closedOther.id, clerk: emp.name, printHere: false, cfg: takeoverCfg }
        );

        carriedCents = running;
        handover = { employee: closedOther.employee, carriedCents: running };
      }
    }

    const session = await db.drawerSession.create({
      data: {
        employee: emp.name,
        employeeId: emp.id,
        /* Taking the till on: the running total carried across, not whatever
           was typed in. Opening fresh: what they counted. */
        openTotalCents: carriedCents ?? countedNow,
        openCounts: JSON.stringify(counts || {}),
        handedOverFrom: handover?.employee || "",
      },
    });
    /* On the clock from the moment the till opens. Cashiers only ever see
       the kiosk, so this is the punch — there is no second screen for them
       to remember. */
    const clock = await clockInForDrawer(emp.id);

    /* THE HANDOVER SLIP.
    
       One register, changing hands all day. Whoever takes it gets a printed
       figure for what should be in it before they sell anything — otherwise
       the float is whatever the last person says it was, and a shortage found
       at nine at night belongs to nobody.
    
       The last shift's difference rides along when it didn't balance, because
       the person inheriting the till is exactly who needs to know. */
    const lastClosed = await db.drawerSession.findFirst({
      where: { status: "CLOSED" },
      orderBy: { closedAt: "desc" },
      select: { employee: true, diffCents: true },
    });

    const printNow = await printDrawerSlip(
      {
        kind: "OPEN",
        employee: emp.name,
        at: session.openedAt,
        openTotalCents: session.openTotalCents,
        previousEmployee: handover?.employee || lastClosed?.employee || "",
        /* On a handover there is no difference to report — nothing was
           counted. The last balanced-or-not figure only belongs on a slip for
           a shift that someone actually counted out. */
        previousDiffCents: handover ? 0 : (lastClosed?.diffCents || 0),
        takenOverFrom: handover?.employee || "",
        /* Shown beside the carried figure when they did count, so a
           discrepancy is visible at the moment it can still be explained. */
        countedByYouCents: handover && countedNow > 0 ? countedNow : undefined,
      },
      { drawerId: session.id, clerk: emp.name, printHere: printHere === true, cfg: takeoverCfg }
    );

    return NextResponse.json({
      session,
      clockedIn: clock === "IN",
      alreadyOnClock: clock === "ALREADY",
      printNow,
      handover,
      carriedCents,
    });
  });
}

export async function PATCH(req: NextRequest) {
  { const denied = await denyUnless("ops"); if (denied) return denied; }
  const { counts, countedCents, drawerId, printHere } = await req.json();

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
  /* Anything handed in or out during the shift counts towards what the till
     should hold — otherwise a recorded paid-out reads as a shortage. */
  const expected = expectedCents(session, cashSalesCents);

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

  /* Off the clock when the drawer is counted out — including when the office
     closes it for somebody who went home, which is the case where a forgotten
     punch would otherwise run all night. The clock belongs to whoever the
     DRAWER belongs to, never to whoever pressed the button. */
  const clockEmpId = await employeeIdForDrawer(session);
  const clock = await clockOutForDrawer(clockEmpId);

  /* THE COUNT, ON PAPER, INCLUDING WHEN IT IS WRONG.
  
     Over and short are printed in double height and in words. A till out by
     six dollars is the most useful thing this slip can say, and a figure
     buried in a column is how a month of them goes unnoticed. */
  const me = await signedInEmployee();
  const printNow = await printDrawerSlip(
    {
      kind: "CLOSE",
      employee: closed.employee,
      at: closed.closedAt || new Date(),
      openTotalCents: closed.openTotalCents,
      cashSalesCents,
      adjustTotalCents: closed.adjustTotalCents || 0,
      expectedCents: expected,
      countedCents: counted,
      diffCents: closed.diffCents,
      closedBy: me?.name || "",
    },
    { drawerId: closed.id, clerk: me?.name || closed.employee, printHere: printHere === true, cfg: await getTillSettings() }
  );

  return NextResponse.json({
    session: closed,
    expected,
    clockedOut: clock.state === "OUT",
    clockHours: Number(clock.hours.toFixed(2)),
    printNow,
  });
}

/**
 * PUT — work inside an open drawer without closing it.
 *
 * Two things happen in a real shift that the till otherwise has no way to
 * record: a float keyed wrong at open, and cash going in or out by hand — a
 * paid-out to a vendor, a drop to the safe, change fetched from the office.
 * Both used to surface hours later as an unexplained over or short, which is
 * the one thing a cash system must never make somebody guess about.
 *
 * PUT { drawerId, openTotalCents? }           — correct the opening float
 * PUT { drawerId, adjustCents, reason }       — cash in (+) or out (-)
 *
 * Either on your own drawer, or on anybody's with the money capability. Both
 * are written to the audit log every time, with a name and a reason: a
 * correction nobody can see is indistinguishable from a hand in the till.
 */
export async function PUT(req: NextRequest) {
  return runRoute("admin/drawer PUT", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const body = await req.json();
    const drawerId = String(body.drawerId || "");
    if (!drawerId) return NextResponse.json({ error: "Which drawer?" }, { status: 400 });

    const session = await db.drawerSession.findUnique({ where: { id: drawerId } });
    if (!session || session.status !== "OPEN") {
      return NextResponse.json({ error: "That drawer isn't open." }, { status: 400 });
    }

    const me = await signedInEmployee();
    const isMine = !!me && (session.employeeId === me.id || (!session.employeeId && session.employee === me.name));
    const role = await currentRole();
    if (!isMine && !(role && can(role, "money"))) {
      return NextResponse.json({ error: "Only an owner or manager can work in somebody else's drawer." }, { status: 403 });
    }

    const who = me?.name || "the office";
    const reason = String(body.reason || "").trim().slice(0, 200);

    /* ---- correcting the opening float ---- */
    if (body.openTotalCents !== undefined) {
      const next = Math.max(0, Math.round(Number(body.openTotalCents) || 0));
      if (!reason) return NextResponse.json({ error: "Say why the opening amount is changing." }, { status: 400 });
      const before = session.openTotalCents;
      if (next === before) return NextResponse.json({ ok: true, session });

      const updated = await db.drawerSession.update({
        where: { id: session.id },
        data: { openTotalCents: next },
      });
      await recordAudit(
        {
          action: "DRAWER_ADJUST",
          targetType: "DRAWER",
          targetId: session.id,
          targetLabel: session.employee,
          amountCents: next - before,
          detail: `${who} corrected ${session.employee}'s opening float from $${(before / 100).toFixed(2)} to $${(next / 100).toFixed(2)} — ${reason}`,
          before: { openTotalCents: before },
          after: { openTotalCents: next },
        },
        req
      );
      return NextResponse.json({ ok: true, session: updated });
    }

    /* ---- cash in or out ---- */
    if (body.adjustCents !== undefined) {
      const cents = Math.round(Number(body.adjustCents) || 0);
      if (!cents) return NextResponse.json({ error: "Enter an amount." }, { status: 400 });
      if (!reason) return NextResponse.json({ error: "Say what the money was for." }, { status: 400 });

      const rows = readAdjustments(session.adjustmentsJson);
      rows.push({ at: new Date().toISOString(), by: who, cents, reason });

      const updated = await db.drawerSession.update({
        where: { id: session.id },
        data: {
          adjustTotalCents: (session.adjustTotalCents || 0) + cents,
          adjustmentsJson: JSON.stringify(rows.slice(-200)),
        },
      });
      await recordAudit(
        {
          action: "DRAWER_ADJUST",
          targetType: "DRAWER",
          targetId: session.id,
          targetLabel: session.employee,
          amountCents: cents,
          detail: `${who} recorded $${(Math.abs(cents) / 100).toFixed(2)} ${cents > 0 ? "INTO" : "OUT OF"} ${session.employee}'s drawer — ${reason}`,
          after: { adjustTotalCents: updated.adjustTotalCents },
        },
        req
      );
      return NextResponse.json({ ok: true, session: updated });
    }

    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  });
}

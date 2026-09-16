import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isStaff, verifyPin, pinUpgrade, currentEmployeeId } from "@/lib/auth";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const session = await db.drawerSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
  if (!session) return NextResponse.json({ session: null });
  const cash = await db.sale.aggregate({
    where: { paymentMethod: "CASH", createdAt: { gte: session.openedAt }, status: { not: "VOIDED" } },
    _sum: { totalCents: true },
  });
  // Voided sales are already excluded above via status: { not: "VOIDED" },
  // and cashRefunds filters out VOID-prefixed notes, so there is nothing
  // further to subtract for voids here.
  const cashRefunds = await db.refund.aggregate({
    where: { method: "CASH", createdAt: { gte: session.openedAt }, note: { not: { startsWith: "VOID" } } },
    _sum: { amountCents: true, taxCents: true },
  });
  const outflow = (cashRefunds._sum.amountCents || 0) + (cashRefunds._sum.taxCents || 0);
  return NextResponse.json({ session: { ...session, cashSalesCents: (cash._sum.totalCents || 0) - outflow } });
}

export async function POST(req: NextRequest) {
  return runRoute("admin/drawer POST", async () => {
    if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    const existing = await db.drawerSession.findFirst({ where: { status: "OPEN" } });
    if (existing) return NextResponse.json({ error: `Drawer is already open (${existing.employee}). Close it first.` }, { status: 400 });

    const session = await db.drawerSession.create({
      data: {
        employee: emp.name,
        openTotalCents: Math.max(0, Math.round(Number(totalCents) || 0)),
        openCounts: JSON.stringify(counts || {}),
      },
    });
    return NextResponse.json({ session });
  });
}

export async function PATCH(req: NextRequest) {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { counts, countedCents } = await req.json();
  const session = await db.drawerSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
  if (!session) return NextResponse.json({ error: "No open drawer." }, { status: 400 });

  const cash = await db.sale.aggregate({
    where: { paymentMethod: "CASH", createdAt: { gte: session.openedAt }, status: { not: "VOIDED" } },
    _sum: { totalCents: true },
  });
  // Voided sales are already excluded above via status: { not: "VOIDED" },
  // and cashRefunds filters out VOID-prefixed notes, so there is nothing
  // further to subtract for voids here.
  const cashRefunds = await db.refund.aggregate({
    where: { method: "CASH", createdAt: { gte: session.openedAt }, note: { not: { startsWith: "VOID" } } },
    _sum: { amountCents: true, taxCents: true },
  });
  const cashSalesCents = (cash._sum.totalCents || 0) - ((cashRefunds._sum.amountCents || 0) + (cashRefunds._sum.taxCents || 0));
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
  return NextResponse.json({ session: closed, expected });
}

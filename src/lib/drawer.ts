import { db } from "@/lib/db";
import { currentEmployeeId } from "@/lib/auth";

/**
 * Cash drawers — one per person, not one per market.
 *
 * THE OLD DESIGN: a single OPEN drawer for the whole market. Every screen
 * asked "is a drawer open?" and got the same one back, so whoever opened it
 * was the name on everybody's register, and every cash sale anyone rang was
 * counted against that one till. Two cashiers could not work at once, and a
 * manager signing in on her phone saw the owner's name on "her" drawer.
 *
 * NOW: each person opens their own. A sale goes on the drawer of the person
 * ringing it, and is linked to it by id, so a drawer's expected cash is exactly
 * the cash rung on it — not "all cash since 9 AM", which stops meaning anything
 * the moment two tills are open.
 *
 * Drawers opened before this change have no employeeId. They keep the old
 * time-window arithmetic so a shift that straddles the deploy still balances.
 */

export type DrawerRow = {
  id: string;
  employee: string;
  employeeId: string;
  openedAt: Date;
  closedAt: Date | null;
  openTotalCents: number;
  status: string;
};

/** The signed-in person, if the session is a person (not the shared owner password). */
export async function signedInEmployee(): Promise<{ id: string; name: string } | null> {
  const id = currentEmployeeId();
  if (!id) return null;
  const emp = await db.employee.findUnique({ where: { id }, select: { id: true, name: true, active: true } });
  return emp && emp.active ? { id: emp.id, name: emp.name } : null;
}

/** This person's open drawer. Falls back to a name match for drawers opened before ids were stored. */
export async function openDrawerFor(emp: { id: string; name: string }): Promise<DrawerRow | null> {
  return db.drawerSession.findFirst({
    where: {
      status: "OPEN",
      OR: [{ employeeId: emp.id }, { employeeId: "", employee: emp.name }],
    },
    orderBy: { openedAt: "desc" },
  });
}

export async function openDrawers(): Promise<DrawerRow[]> {
  return db.drawerSession.findMany({ where: { status: "OPEN" }, orderBy: { openedAt: "asc" } });
}

/**
 * The drawer the current request should use.
 *
 * A person → their own drawer. The shared owner password isn't a person, so it
 * only gets a drawer when there is exactly one open and no doubt which is meant;
 * with two open it has to sign in as someone.
 */
export async function drawerForRequest(): Promise<{ drawer: DrawerRow | null; who: { id: string; name: string } | null; ambiguous: boolean }> {
  const who = await signedInEmployee();
  if (who) return { drawer: await openDrawerFor(who), who, ambiguous: false };
  const open = await openDrawers();
  if (open.length === 1) return { drawer: open[0], who: null, ambiguous: false };
  return { drawer: null, who: null, ambiguous: open.length > 1 };
}

/**
 * Cash in, less cash refunded, on one drawer.
 *
 * New drawers count only what's linked to them. A legacy drawer (no
 * employeeId) keeps the old rule — every cash sale and refund in its time
 * window that isn't linked to some other drawer.
 */
export async function drawerCashCents(d: DrawerRow): Promise<number> {
  const legacy = !d.employeeId;
  const until = d.closedAt ?? undefined;
  const window = { gte: d.openedAt, ...(until ? { lte: until } : {}) };

  const saleWhere = legacy
    ? { paymentMethod: "CASH", status: { not: "VOIDED" }, createdAt: window, OR: [{ drawerId: d.id }, { drawerId: "" }] }
    : { paymentMethod: "CASH", status: { not: "VOIDED" }, drawerId: d.id };
  const refundWhere = legacy
    ? { method: "CASH", note: { not: { startsWith: "VOID" } }, createdAt: window, OR: [{ drawerId: d.id }, { drawerId: "" }] }
    : { method: "CASH", note: { not: { startsWith: "VOID" } }, drawerId: d.id };

  const cash = await db.sale.aggregate({ where: saleWhere, _sum: { totalCents: true } });
  const refunds = await db.refund.aggregate({ where: refundWhere, _sum: { amountCents: true, taxCents: true } });
  return (cash._sum.totalCents || 0) - ((refunds._sum.amountCents || 0) + (refunds._sum.taxCents || 0));
}

/**
 * Which drawer a cash refund comes out of: the refunder's own, or the only one
 * open. With several open and the refunder holding none, it isn't guessed —
 * guessing would make someone else's till come up short.
 */
export async function drawerIdForRefund(): Promise<string> {
  const { drawer } = await drawerForRequest();
  return drawer?.id || "";
}

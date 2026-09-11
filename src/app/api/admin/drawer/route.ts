import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { createHash } from "crypto";

export const dynamic = "force-dynamic";

const pinHash = (pin: string) => createHash("sha256").update(`pin:${pin}`).digest("hex");

export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const session = await db.drawerSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
  if (!session) return NextResponse.json({ session: null });
  const cash = await db.sale.aggregate({
    where: { paymentMethod: "CASH", createdAt: { gte: session.openedAt } },
    _sum: { totalCents: true },
  });
  return NextResponse.json({ session: { ...session, cashSalesCents: cash._sum.totalCents || 0 } });
}

export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { employee, pin, counts, totalCents } = await req.json();
  const emp = await db.employee.findUnique({ where: { name: employee || "" } });
  if (!emp || !emp.active || emp.pinHash !== pinHash(pin || "")) {
    return NextResponse.json({ error: "Wrong employee or PIN." }, { status: 401 });
  }
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
}

export async function PATCH(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { counts, countedCents } = await req.json();
  const session = await db.drawerSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
  if (!session) return NextResponse.json({ error: "No open drawer." }, { status: 400 });

  const cash = await db.sale.aggregate({
    where: { paymentMethod: "CASH", createdAt: { gte: session.openedAt } },
    _sum: { totalCents: true },
  });
  const cashSalesCents = cash._sum.totalCents || 0;
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

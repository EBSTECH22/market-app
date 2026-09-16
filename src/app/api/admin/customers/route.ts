import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

export async function GET() {
  { const denied = await denyUnless("market"); if (denied) return denied; }
  const customers = await db.customer.findMany({ orderBy: { createdAt: "desc" }, include: { follows: true } });
  const sales = await db.sale.groupBy({ by: ["customerId"], where: { customerId: { not: "" }, status: { not: "VOIDED" } }, _count: { _all: true }, _sum: { totalCents: true } });
  const map = Object.fromEntries(sales.map((s) => [s.customerId, s]));
  return NextResponse.json({
    customers: customers.map((c) => ({
      id: c.id, email: c.email, phone: c.phone, points: c.points, unsubscribed: c.unsubscribed,
      follows: c.follows.length, createdAt: c.createdAt,
      saleCount: map[c.id]?._count._all || 0, spentCents: map[c.id]?._sum.totalCents || 0,
    })),
  });
}

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { centralDayStart, centralMonthStart } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dayStart = centralDayStart();
  const monthStart = centralMonthStart();

  const [todaySales, monthSales, floor, vendors] = await Promise.all([
    db.sale.findMany({ where: { createdAt: { gte: dayStart } } }),
    db.sale.findMany({ where: { createdAt: { gte: monthStart } } }),
    db.item.findMany({
      where: { active: true },
      include: { vendor: { select: { businessName: true, code: true } } },
      orderBy: [{ vendorId: "asc" }, { name: "asc" }],
    }),
    db.vendor.count({ where: { active: true } }),
  ]);

  const sum = (arr: { totalCents: number }[]) => arr.reduce((n, s) => n + s.totalCents, 0);
  const tax = (arr: { taxCents: number }[]) => arr.reduce((n, s) => n + s.taxCents, 0);

  return NextResponse.json({
    today: { count: todaySales.length, totalCents: sum(todaySales), taxCents: tax(todaySales) },
    month: { count: monthSales.length, totalCents: sum(monthSales), taxCents: tax(monthSales) },
    vendors,
    floor: floor.map((i) => ({
      id: i.id, sku: i.sku, name: i.name, priceCents: i.priceCents, quantity: i.quantity,
      vendorName: i.vendor.businessName, vendorCode: i.vendor.code,
    })),
  });
}

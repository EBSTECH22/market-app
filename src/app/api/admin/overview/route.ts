import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { effectivePriceCents } from "@/lib/pricing";
import { denyUnless, currentRole, can } from "@/lib/perm";
import { centralDayStart, centralMonthStart } from "@/lib/time";
import { cashCents } from "@/lib/cardprice";
import { getMarketFeePercent } from "@/lib/settings";

export const dynamic = "force-dynamic";

/* Floor prices are the customer's CASH price: the vendor's price plus the
   market service fee (lib/cardprice). The till adds the card percentage on
   top for the tag. vendorPriceCents is what the vendor set. */
function floorRow(i: {
  id: string; sku: string; name: string; priceCents: number; salePercent: number; quantity: number; taxClass: string;
  vendor: { businessName: string; code: string; lowStockThreshold: number };
}, fee: number) {
  return {
    id: i.id, sku: i.sku, name: i.name, priceCents: cashCents(effectivePriceCents(i), fee), basePriceCents: cashCents(i.priceCents, fee),
    vendorPriceCents: effectivePriceCents(i),
    salePercent: Math.max(0, Math.min(90, i.salePercent || 0)), quantity: i.quantity,
    taxClass: String(i.taxClass || "STANDARD"),
    vendorName: i.vendor.businessName, vendorCode: i.vendor.code,
    lowStockAt: i.vendor.lowStockThreshold,
  };
}

export async function GET(req: NextRequest) {
  { const denied = await denyUnless("ops"); if (denied) return denied; }

  /* ?only=floor — just the items. The register reloads the floor after every
     sale, and the full overview also pulls every sale and refund of the month
     to add up takings the till never shows — a download that grew all month
     long on the one screen that has to be quick. */
  if (req.nextUrl.searchParams.get("only") === "floor") {
    const floor = await db.item.findMany({
      where: { active: true, vendor: { active: true } },
      include: { vendor: { select: { businessName: true, code: true, lowStockThreshold: true } } },
      orderBy: [{ vendorId: "asc" }, { name: "asc" }],
    });
    const fee = await getMarketFeePercent();
    return NextResponse.json({ floor: floor.map((i) => floorRow(i, fee)) });
  }
  /* Takings are financials, not ops: a cashier and a manager both need the
     floor list, and neither needs to see what the market made today. */
  const admin = can(await currentRole(), "financials");

  const dayStart = centralDayStart();
  const monthStart = centralMonthStart();

  const [todaySales, monthSales, todayRefunds, monthRefunds, floor, vendors] = await Promise.all([
    db.sale.findMany({ where: { createdAt: { gte: dayStart }, status: { not: "VOIDED" } } }),
    db.sale.findMany({ where: { createdAt: { gte: monthStart }, status: { not: "VOIDED" } } }),
    db.refund.findMany({ where: { createdAt: { gte: dayStart }, note: { not: { startsWith: "VOID" } } } }),
    db.refund.findMany({ where: { createdAt: { gte: monthStart }, note: { not: { startsWith: "VOID" } } } }),
    db.item.findMany({
      where: { active: true, vendor: { active: true } },
      include: { vendor: { select: { businessName: true, code: true, lowStockThreshold: true } } },
      orderBy: [{ vendorId: "asc" }, { name: "asc" }],
    }),
    db.vendor.count({ where: { active: true } }),
  ]);

  const fee = await getMarketFeePercent();
  const sum = (arr: { totalCents: number }[]) => arr.reduce((n, s) => n + s.totalCents, 0);
  const tax = (arr: { taxCents: number }[]) => arr.reduce((n, s) => n + s.taxCents, 0);
  const refundBack = (arr: { amountCents: number; taxCents: number }[]) => arr.reduce((n, r) => n + r.amountCents + r.taxCents, 0);
  const refundTax = (arr: { taxCents: number }[]) => arr.reduce((n, r) => n + r.taxCents, 0);

  return NextResponse.json({
    today: { count: todaySales.length, totalCents: sum(todaySales) - refundBack(todayRefunds), taxCents: tax(todaySales) - refundTax(todayRefunds) },
    month: admin ? { count: monthSales.length, totalCents: sum(monthSales) - refundBack(monthRefunds), taxCents: tax(monthSales) - refundTax(monthRefunds) } : { count: 0, totalCents: 0, taxCents: 0 },
    vendors,
    floor: floor.map((i) => floorRow(i, fee)),
  });
}

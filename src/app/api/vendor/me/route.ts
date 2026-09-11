import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { centralMonthStart } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET() {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const [vendor, ledger, items, monthLines] = await Promise.all([
    db.vendor.findUnique({ where: { id: vendorId }, select: { id: true, code: true, businessName: true, contactName: true, email: true, commissionPercent: true, mustChangePassword: true } }),
    db.ledgerEntry.findMany({ where: { vendorId }, orderBy: { createdAt: "desc" }, take: 30 }),
    db.item.findMany({ where: { vendorId, active: true }, orderBy: { createdAt: "asc" } }),
    db.saleLine.findMany({ where: { vendorId, sale: { createdAt: { gte: centralMonthStart() } } } }),
  ]);
  if (!vendor) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const balance = (await db.ledgerEntry.aggregate({ where: { vendorId }, _sum: { amountCents: true } }))._sum.amountCents || 0;
  const monthSales = monthLines.reduce((n, l) => n + l.priceCents * l.quantity, 0);
  const monthNet = monthLines.reduce((n, l) => n + l.vendorNetCents, 0);

  return NextResponse.json({ vendor, items, ledger, balance, monthSales, monthNet });
}

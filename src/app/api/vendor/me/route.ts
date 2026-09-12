import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { centralMonthStart } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET() {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const [vendor, ledger, items, monthLines] = await Promise.all([
    db.vendor.findUnique({ where: { id: vendorId }, select: { id: true, code: true, businessName: true, contactName: true, email: true, commissionPercent: true, mustChangePassword: true, acceptsPreorders: true, acceptsRequests: true, publicBlurb: true, allowSelfCheckout: true, contracts: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, vendorSignedAt: true } } } }),
    db.ledgerEntry.findMany({ where: { vendorId }, orderBy: { createdAt: "desc" }, take: 30 }),
    db.item.findMany({ where: { vendorId }, orderBy: { createdAt: "asc" } }),
    db.ledgerEntry.findMany({ where: { vendorId, createdAt: { gte: centralMonthStart() }, type: { in: ["SALE", "REFUND", "VOID"] } } }),
  ]);
  if (!vendor) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const balance = (await db.ledgerEntry.aggregate({ where: { vendorId }, _sum: { amountCents: true } }))._sum.amountCents || 0;
  // net of commissions, minus refunds and voids; gross backed out from the vendor's rate
  const monthNet = monthLines.reduce((n, l) => n + l.amountCents, 0);
  const pct = vendor.commissionPercent || 0;
  const monthSales = pct > 0 ? Math.round((monthNet * 100) / (100 - pct)) : monthNet;

  return NextResponse.json({ vendor, items, ledger, balance, monthSales, monthNet });
}

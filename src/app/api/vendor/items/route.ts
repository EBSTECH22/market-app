import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const { name, priceDollars, quantity } = await req.json();
  const price = Math.round(Number(priceDollars) * 100);
  const qty = Math.max(0, Math.round(Number(quantity) || 0));
  if (!name?.trim()) return NextResponse.json({ error: "Item name required." }, { status: 400 });
  if (!price || price <= 0) return NextResponse.json({ error: "Enter a valid price." }, { status: 400 });

  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });

  const count = await db.item.count({ where: { vendorId } });
  const sku = `${vendor.code}-${String(count + 1).padStart(4, "0")}`;

  const item = await db.item.create({
    data: { vendorId, sku, name: name.trim(), priceCents: price, quantity: qty },
  });
  return NextResponse.json({ item });
}

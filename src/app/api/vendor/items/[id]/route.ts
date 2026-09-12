import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { notifyVendorRestock } from "@/lib/customers";
import { currentVendorId } from "@/lib/auth";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const item = await db.item.findUnique({ where: { id: params.id } });
  if (!item || item.vendorId !== vendorId) return NextResponse.json({ error: "Item not found." }, { status: 404 });

  const body = await req.json();
  let restock = false;
  const data: { name?: string; priceCents?: number; quantity?: number; active?: boolean; salePercent?: number } = {};
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
  if (body.priceDollars !== undefined) {
    const price = Math.round(Number(body.priceDollars) * 100);
    if (!price || price <= 0) return NextResponse.json({ error: "Enter a valid price." }, { status: 400 });
    data.priceCents = price;
  }
  if (body.addQuantity !== undefined) {
    const n = Math.round(Number(body.addQuantity));
    if (Number.isNaN(n) || n <= 0 || n > 999) return NextResponse.json({ error: "Enter how many you're adding (1–999)." }, { status: 400 });
    const updated = await db.item.update({ where: { id: item.id }, data: { quantity: { increment: n } } });
    notifyVendorRestock(vendorId).catch(() => {});
    return NextResponse.json({ item: updated });
  }
  if (body.quantity !== undefined) {
    const q = Math.round(Number(body.quantity));
    if (Number.isNaN(q) || q < 0) return NextResponse.json({ error: "Invalid quantity." }, { status: 400 });
    data.quantity = q;
    if (q > item.quantity) restock = true;
  }
  if (body.salePercent !== undefined) {
    const pct = Math.round(Number(body.salePercent));
    if (Number.isNaN(pct) || pct < 0 || pct > 90) return NextResponse.json({ error: "Sale must be 0–90%." }, { status: 400 });
    data.salePercent = pct;
  }
  if (typeof body.active === "boolean") data.active = body.active;
  if (!Object.keys(data).length) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const updated = await db.item.update({ where: { id: item.id }, data });
  if (restock) notifyVendorRestock(vendorId).catch(() => {});
  return NextResponse.json({ item: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const item = await db.item.findUnique({ where: { id: params.id } });
  if (!item || item.vendorId !== vendorId) return NextResponse.json({ error: "Item not found." }, { status: 404 });

  const soldLines = await db.saleLine.count({ where: { itemId: item.id } });
  if (soldLines > 0) {
    // sale history references it — retire instead so the books stay whole
    await db.item.update({ where: { id: item.id }, data: { active: false, quantity: 0 } });
    return NextResponse.json({ retired: true, message: `${item.name} has sales history, so it was retired instead of deleted — it's off the floor and can't be scanned.` });
  }
  await db.item.delete({ where: { id: item.id } });
  return NextResponse.json({ deleted: true });
}

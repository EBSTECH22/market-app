import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { notifyVendorRestock } from "@/lib/customers";
import { currentVendorId } from "@/lib/auth";
import { normalizeTaxClass } from "@/lib/tax";
import { effectiveCents } from "@/lib/pricetest";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const item = await db.item.findUnique({ where: { id: params.id } });
  if (!item || item.vendorId !== vendorId) return NextResponse.json({ error: "Item not found." }, { status: 404 });

  const body = await req.json();
  let restock = false;
  const data: {
    name?: string; priceCents?: number; quantity?: number; active?: boolean; salePercent?: number;
    taxClass?: string; category?: string; description?: string; unitLabel?: string; featured?: boolean;
    onlineEnabled?: boolean; onlineQuantity?: number; onlinePickup?: boolean; onlineShip?: boolean; shipCents?: number;
  } = {};
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
  if (body.taxClass !== undefined) data.taxClass = normalizeTaxClass(body.taxClass);
  if (body.category !== undefined) data.category = String(body.category || "").trim().slice(0, 40);
  if (body.description !== undefined) data.description = String(body.description || "").trim().slice(0, 1200);
  if (body.unitLabel !== undefined) data.unitLabel = String(body.unitLabel || "").trim().slice(0, 40);
  if (typeof body.featured === "boolean") data.featured = body.featured;

  /* Selling online, per product. The online count is its own number and is set
     directly rather than adjusted — a vendor deciding "four of these are for
     the website" is stating a total, not a delta. */
  if (typeof body.onlineEnabled === "boolean") data.onlineEnabled = body.onlineEnabled;
  if (body.onlineQuantity !== undefined) {
    const q = Math.round(Number(body.onlineQuantity));
    if (Number.isNaN(q) || q < 0 || q > 9999) {
      return NextResponse.json({ error: "Online quantity has to be 0 or more." }, { status: 400 });
    }
    data.onlineQuantity = q;
  }
  if (typeof body.onlinePickup === "boolean") data.onlinePickup = body.onlinePickup;
  if (typeof body.onlineShip === "boolean") data.onlineShip = body.onlineShip;
  if (body.shipDollars !== undefined) {
    const cents = Math.round(Number(body.shipDollars || 0) * 100);
    if (Number.isNaN(cents) || cents < 0 || cents > 50000) {
      return NextResponse.json({ error: "Shipping charge has to be between $0 and $500." }, { status: 400 });
    }
    data.shipCents = cents;
  }
  /* Neither collection nor post means nobody can receive it, so it can't be
     sold online however the boxes were left. */
  const finalPickup = data.onlinePickup ?? item.onlinePickup;
  const finalShip = data.onlineShip ?? item.onlineShip;
  const finalOnline = data.onlineEnabled ?? item.onlineEnabled;
  if (finalOnline && !finalPickup && !finalShip) {
    return NextResponse.json(
      { error: "Pick collection at the market, posting, or both — an online item needs a way to reach the buyer." },
      { status: 400 }
    );
  }
  if (typeof body.active === "boolean") data.active = body.active;
  if (!Object.keys(data).length) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const updated = await db.item.update({ where: { id: item.id }, data });

  /* Write down what the price WAS, at the moment it changes.
     The item row only ever holds the current price, so without this the day a
     vendor put something on sale is simply gone and "did that discount work"
     can never be answered. Only logged when the price a shopper actually pays
     moved — renaming an item isn't a price experiment. */
  const oldEffective = effectiveCents(item.priceCents, item.salePercent);
  const newEffective = effectiveCents(updated.priceCents, updated.salePercent);
  if (oldEffective !== newEffective) {
    try {
      await db.priceEvent.create({
        data: {
          itemId: item.id, vendorId,
          oldPriceCents: item.priceCents, newPriceCents: updated.priceCents,
          oldSalePercent: item.salePercent || 0, newSalePercent: updated.salePercent || 0,
        },
      });
    } catch { /* never let bookkeeping stop a vendor changing their own price */ }
  }

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

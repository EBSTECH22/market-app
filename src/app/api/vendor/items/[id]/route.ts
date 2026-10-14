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

  /* A BLANK BOX IS NOT A ZERO.
     
     `<input type="number">` hands back an EMPTY STRING whenever its contents
     aren't a valid number — a stray comma, a space, a half-typed value. That
     empty string arrived here, Number("") is 0, and a vendor correcting their
     floor count watched the item silently go out of stock instead. No error,
     because as far as this route was concerned they had asked for zero.
     
     Blank now means "didn't say", which is the only safe reading of it: a
     vendor who means zero can type 0. */
  const given = (v: unknown): boolean => v !== undefined && v !== null && String(v).trim() !== "";

  let restock = false;
  const data: {
    name?: string; priceCents?: number; quantity?: number; active?: boolean; salePercent?: number;
    taxClass?: string; category?: string; description?: string; unitLabel?: string; featured?: boolean;
    onlineEnabled?: boolean; onlineQuantity?: number; onlinePickup?: boolean; onlineShip?: boolean; shipCents?: number;
  } = {};
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
  /* ONLY JUDGE WHAT SHE ACTUALLY CHANGED.

     The edit form posts every field it holds, not the ones that were touched.
     So a rule about the price got applied to a price the vendor was only
     carrying along, and an item that was already outside the rule — priced at
     zero, say — could never be saved again for any reason. Change the floor
     count, get told to enter a valid price, for a box that was already filled
     in and that she hadn't gone near.

     A value identical to the one in the database is therefore not this save's
     business. It gets left exactly as it is: not written, not judged. Anything
     genuinely new is still checked as strictly as before, and the message now
     names the box so it means something wherever it is read. */
  if (given(body.priceDollars)) {
    const price = Math.round(Number(body.priceDollars) * 100);
    const unchanged = price === item.priceCents;
    if (!unchanged) {
      if (!Number.isFinite(price) || price <= 0) {
        return NextResponse.json({ error: "The price has to be more than zero — check the Price box." }, { status: 400 });
      }
      data.priceCents = price;
    }
  }
  if (given(body.addQuantity)) {
    const n = Math.round(Number(body.addQuantity));
    if (Number.isNaN(n) || n <= 0 || n > 999) return NextResponse.json({ error: "Enter how many you're adding (1–999)." }, { status: 400 });
    const updated = await db.item.update({ where: { id: item.id }, data: { quantity: { increment: n } } });
    notifyVendorRestock(vendorId).catch(() => {});
    return NextResponse.json({ item: updated });
  }
  if (given(body.quantity)) {
    const q = Math.round(Number(body.quantity));
    if (Number.isNaN(q) || q < 0) return NextResponse.json({ error: "Invalid quantity." }, { status: 400 });
    data.quantity = q;
    if (q > item.quantity) restock = true;
  }
  if (given(body.salePercent)) {
    const pct = Math.round(Number(body.salePercent));
    if (pct !== (item.salePercent || 0)) {
      if (Number.isNaN(pct) || pct < 0 || pct > 90) {
        return NextResponse.json({ error: "A sale has to be between 0 and 90% — check the Sale box." }, { status: 400 });
      }
      data.salePercent = pct;
    }
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
  if (given(body.onlineQuantity)) {
    const q = Math.round(Number(body.onlineQuantity));
    if (q !== (item.onlineQuantity || 0)) {
      if (Number.isNaN(q) || q < 0 || q > 9999) {
        return NextResponse.json({ error: "The number set aside for online has to be 0 or more." }, { status: 400 });
      }
      data.onlineQuantity = q;
    }
  }
  if (typeof body.onlinePickup === "boolean") data.onlinePickup = body.onlinePickup;
  if (typeof body.onlineShip === "boolean") data.onlineShip = body.onlineShip;
  if (body.shipDollars !== undefined) {
    const cents = Math.round(Number(body.shipDollars || 0) * 100);
    if (cents !== (item.shipCents || 0)) {
      if (Number.isNaN(cents) || cents < 0 || cents > 50000) {
        return NextResponse.json({ error: "The postage charge has to be between $0 and $500." }, { status: 400 });
      }
      data.shipCents = cents;
    }
  }
  /* Neither collection nor post means nobody can receive it, so it can't be
     sold online however the boxes were left.

     This used to reject the WHOLE save, which turned a stale online setting
     into a locked item: a vendor fixing a floor count got a refusal about
     postage, for a section of the form she hadn't opened, and from where she
     was standing the Save button simply did nothing. The rule still holds, but
     it now only applies to a save that is actually CHANGING how the thing
     reaches a buyer. Everything else — stock, price, name — goes through, and
     the online fields are left exactly as they were. */
  const touchedDelivery =
    typeof body.onlineEnabled === "boolean" ||
    typeof body.onlinePickup === "boolean" ||
    typeof body.onlineShip === "boolean";
  const wouldBeOnline = data.onlineEnabled ?? item.onlineEnabled;
  const wouldBePickup = data.onlinePickup ?? item.onlinePickup;
  const wouldBeShip = data.onlineShip ?? item.onlineShip;
  const isNowBroken = item.onlineEnabled && !item.onlinePickup && !item.onlineShip;
  const wouldBeBroken = wouldBeOnline && !wouldBePickup && !wouldBeShip;

  if (wouldBeBroken) {
    /* Changing it INTO that state is still refused — that is the vendor
       standing in the online section, and the message belongs there. */
    if (touchedDelivery && !isNowBroken) {
      return NextResponse.json(
        { error: "Pick collection at the market, posting, or both — an online item needs a way to reach the buyer." },
        { status: 400 }
      );
    }
    /* Already in that state and she is here for something else: don't touch
       the online fields at all, and don't stand in her way. */
    delete data.onlineEnabled;
    delete data.onlinePickup;
    delete data.onlineShip;
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

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { notifyVendorRestock } from "@/lib/customers";
import { currentVendorId } from "@/lib/auth";
import { normalizeTaxClass } from "@/lib/tax";

/**
 * The next item number for this vendor.
 *
 * THIS USED TO COUNT THE ITEMS AND ADD ONE, which is a trap. `sku` is unique
 * across the whole market, and a vendor who DELETES an item makes the count
 * go down — so the next thing they add is handed a number one of their own
 * items already holds. The database refuses it. And because the number is
 * worked out the same way every time, it refuses the next one too, and the
 * one after that, for as long as that vendor owns the item holding the
 * number. From the vendor's side: nothing will add, ever, and no reason
 * given.
 *
 * So the number comes from the HIGHEST one they have used, not from how many
 * they currently have. That is also the honest behaviour: a number already
 * printed on a label in somebody's kitchen should never quietly come to mean
 * a different jar.
 */
async function nextSku(vendorCode: string, vendorId: string, bump = 0): Promise<string> {
  const rows = await db.item.findMany({ where: { vendorId }, select: { sku: true } });
  let highest = 0;
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.sku || "");
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `${vendorCode}-${String(highest + 1 + bump).padStart(4, "0")}`;
}

export async function POST(req: NextRequest) {
  try {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

    const { name, priceDollars, quantity, taxClass, category } = await req.json();
    const price = Math.round(Number(priceDollars) * 100);
    const qty = Math.max(0, Math.round(Number(quantity) || 0));
    if (!name?.trim()) return NextResponse.json({ error: "Item name required." }, { status: 400 });
    if (!price || price <= 0) return NextResponse.json({ error: "Enter a valid price." }, { status: 400 });

    const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });

    const data = {
      vendorId,
      name: name.trim(),
      priceCents: price,
      quantity: qty,
      taxClass: normalizeTaxClass(taxClass),
      category: String(category || "").trim().slice(0, 40),
    };

    /* Two people adding at the same second, or a number left stranded by the
       old counting scheme, can still collide. Step past it rather than fail:
       the vendor wants their item added, not a lecture about numbering. */
    let item: Awaited<ReturnType<typeof db.item.create>> | null = null;
    for (let bump = 0; bump < 25 && !item; bump++) {
      const sku = await nextSku(vendor.code, vendorId, bump);
      try {
        item = await db.item.create({ data: { ...data, sku } });
      } catch (err) {
        if ((err as { code?: string })?.code !== "P2002") throw err;
      }
    }
    if (!item) {
      return NextResponse.json(
        { error: "Couldn't find a free item number. Tell the market office — this one needs looking at." },
        { status: 500 }
      );
    }

    notifyVendorRestock(vendorId).catch(() => {});
    return NextResponse.json({ item });
  } catch (err) {
    /* ALWAYS JSON, whatever happened. A thrown error here used to come back
       as Next's HTML error page; the vendor's browser then tried to read it
       as JSON, that threw too, and she got no message at all — just a button
       that stopped spinning. Silence is the worst possible answer to "why
       won't my item add". */
    console.error("vendor item create failed", err);
    return NextResponse.json(
      { error: "Couldn't add that item. Try once more — if it still won't go, tell the market office." },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { runRoute } from "@/lib/handler";
import { pushToVendor } from "@/lib/push";
import type { CartLine } from "@/lib/selfcheckout";
import { normalizeTaxClass } from "@/lib/tax";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

/**
 * Cash for a ticket a vendor rang up at their own booth.
 *
 * The vendor's phone can't take cash, so it hands the customer a five-character
 * code. They walk it to the register, a cashier looks it up here, takes the
 * money, and this books the sale — attributed to the vendor who rang it, with
 * the cash landing in the market's drawer where it belongs.
 *
 * Deliberately NOT "load it into the register cart and ring it normally": that
 * would re-price against the current item prices and attribute the sale to the
 * cashier, which is the one thing the code exists to prevent.
 */

function lookupCode(raw: string): string {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

// GET ?code=ABCDE — what's on the ticket, before taking any money
export async function GET(req: NextRequest) {
  return runRoute("admin/vendor-ticket GET", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const code = lookupCode(req.nextUrl.searchParams.get("code") || "");
    if (!code) return NextResponse.json({ error: "Enter the code from the vendor's phone." }, { status: 400 });

    const cart = await db.selfCart.findFirst({
      where: { registerCode: code },
      orderBy: { createdAt: "desc" },
    });
    if (!cart) return NextResponse.json({ error: `No ticket with code ${code}. Check it on their phone.` }, { status: 404 });
    if (cart.status === "PAID") {
      return NextResponse.json({ error: "That ticket has already been rung." }, { status: 409 });
    }

    const vendor = cart.soldByVendorId
      ? await db.vendor.findUnique({ where: { id: cart.soldByVendorId }, select: { businessName: true, code: true } })
      : null;

    const lines: CartLine[] = JSON.parse(cart.linesJson);
    return NextResponse.json({
      cartId: cart.id,
      code,
      vendorName: vendor?.businessName || "Unknown vendor",
      vendorCode: vendor?.code || "",
      createdAt: cart.createdAt,
      lines: lines.map((l) => ({ name: l.name, sku: l.sku, quantity: l.quantity, priceCents: l.priceCents })),
      subtotalCents: cart.subtotalCents,
      taxCents: cart.taxCents,
      totalCents: cart.totalCents,
    });
  });
}

// POST { code, cashTenderedCents } — take the cash and book it
export async function POST(req: NextRequest) {
  return runRoute("admin/vendor-ticket POST", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const body = await req.json();
    const code = lookupCode(body.code);
    if (!code) return NextResponse.json({ error: "Enter the code." }, { status: 400 });

    const drawer = await db.drawerSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
    if (!drawer) return NextResponse.json({ error: "Open the drawer before taking cash." }, { status: 400 });

    const cart = await db.selfCart.findFirst({ where: { registerCode: code }, orderBy: { createdAt: "desc" } });
    if (!cart) return NextResponse.json({ error: `No ticket with code ${code}.` }, { status: 404 });
    if (cart.status === "PAID") return NextResponse.json({ error: "That ticket has already been rung." }, { status: 409 });

    const tenderedRaw = Number(body.cashTenderedCents);
    const tendered = Number.isFinite(tenderedRaw) && tenderedRaw > 0 ? Math.round(tenderedRaw) : 0;
    if (tendered > 0 && tendered < cart.totalCents) {
      return NextResponse.json(
        { error: `Cash given (${(tendered / 100).toFixed(2)}) doesn't cover the ${(cart.totalCents / 100).toFixed(2)} total.` },
        { status: 400 }
      );
    }

    const lines: CartLine[] = JSON.parse(cart.linesJson);
    const vendor = await db.vendor.findUnique({ where: { id: cart.soldByVendorId } });
    if (!vendor) return NextResponse.json({ error: "That vendor no longer exists." }, { status: 400 });

    let number = 0;
    let saleId = "";
    let shortOf: string | null = null;

    await db.$transaction(async (tx) => {
      /* Claim the cart first, conditionally. Two cashiers racing the same code
         — or one impatient double-tap — would otherwise both get past the
         status check above and book the ticket twice. */
      const claimed = await tx.selfCart.updateMany({
        where: { id: cart.id, status: { not: "PAID" } },
        data: { status: "PAID", paidAt: new Date() },
      });
      if (claimed.count === 0) return;

      /* Stock, claimed atomically — the same check-then-take race the register
         had. Sorted by id so two tickets sharing an item can't deadlock by
         grabbing rows in opposite orders. */
      const needed = new Map<string, number>();
      for (const l of lines) needed.set(l.itemId, (needed.get(l.itemId) || 0) + l.quantity);
      for (const itemId of [...needed.keys()].sort()) {
        const qty = needed.get(itemId) || 0;
        const got = await tx.item.updateMany({
          where: { id: itemId, quantity: { gte: qty } },
          data: { quantity: { decrement: qty } },
        });
        if (got.count === 0) {
          const item = await tx.item.findUnique({ where: { id: itemId }, select: { name: true, quantity: true } });
          shortOf = `Only ${item?.quantity ?? 0} of ${item?.name ?? "an item"} left — it sold while this ticket was waiting.`;
          throw new Error("OUT_OF_STOCK");
        }
      }

      const last = await tx.sale.aggregate({ _max: { number: true } });
      number = Math.max(1000, (last._max.number || 999) + 1);

      const saleLines = lines.map((l) => {
        const commissionCents = Math.round((l.priceCents * l.quantity * (vendor.commissionPercent || 0)) / 100);
        return {
          itemId: l.itemId, vendorId: l.vendorId, name: l.name,
          priceCents: l.priceCents, quantity: l.quantity,
          commissionCents, vendorNetCents: l.priceCents * l.quantity - commissionCents,
          taxClass: normalizeTaxClass(l.taxClass),
        };
      });

      const sale = await tx.sale.create({
        data: {
          number,
          employee: `VENDOR: ${vendor.businessName}`,
          soldByVendorId: vendor.id,
          cardName: "",
          subtotalCents: cart.subtotalCents,
          taxCents: cart.taxCents,
          foodTaxCents: cart.foodTaxCents,
          standardTaxCents: cart.standardTaxCents,
          totalCents: cart.totalCents,
          paymentMethod: "CASH",
          cashTenderedCents: tendered,
          changeCents: tendered > 0 ? Math.max(0, tendered - cart.totalCents) : 0,
          lines: { create: saleLines },
        },
      });
      saleId = sale.id;

      for (const sl of saleLines) {
        await tx.ledgerEntry.create({
          data: {
            vendorId: sl.vendorId,
            type: "SALE",
            amountCents: sl.vendorNetCents,
            note: `${sl.quantity}× ${sl.name} (their booth, cash at register #${number})`,
          },
        });
      }

      await tx.selfCart.update({ where: { id: cart.id }, data: { saleId: sale.id, registerCode: "" } });
    }).catch((err: unknown) => {
      if (err instanceof Error && err.message === "OUT_OF_STOCK") return;
      throw err;
    });

    if (shortOf) return NextResponse.json({ error: shortOf }, { status: 409 });
    if (number === 0) return NextResponse.json({ error: "That ticket has already been rung." }, { status: 409 });

    try {
      await pushToVendor(vendor.id, "Your booth sale went through", `#${number} — ${(cart.totalCents / 100).toFixed(2)} cash at the register`);
    } catch { /* the sale stands whether or not the alert lands */ }

    return NextResponse.json({
      ok: true,
      sale: {
        id: saleId, number,
        totalCents: cart.totalCents,
        cashTenderedCents: tendered,
        changeCents: tendered > 0 ? Math.max(0, tendered - cart.totalCents) : 0,
        vendorName: vendor.businessName,
      },
    });
  });
}

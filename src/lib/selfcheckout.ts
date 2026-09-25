import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { pushToVendor, pushToAdmin } from "@/lib/push";
import { sendSelfCheckoutReceiptEmail } from "@/lib/email";
import { findOrCreateCustomer, pointsFor } from "@/lib/customers";
import { normalizeTaxClass, taxFor } from "@/lib/tax";
import { tagCents, cardUpliftCents, lineShares } from "@/lib/cardprice";
import { getCardAdjustPercent } from "@/lib/settings";

/**
 * A booth or self-checkout cart paid by CARD: the customer pays the tag prices.
 * The lines keep the vendor's own prices (so commission and the vendor's share
 * are worked out on them when the sale is booked); the card percentage rides
 * on top as the difference, taxed like the register taxes it.
 */
export function priceCardCart(
  lines: CartLine[],
  rates: { standardPercent: number; foodPercent: number },
  cardPercent: number
) {
  const subtotalCents = lines.reduce((n, l) => n + l.priceCents * l.quantity, 0);
  const cardAdjustCents = cardUpliftCents(lines, cardPercent);
  const split = taxFor(
    lines.map((l) => ({ amountCents: l.priceCents * l.quantity, taxClass: normalizeTaxClass(l.taxClass) })),
    rates,
    cardAdjustCents
  );
  return {
    subtotalCents,
    cardAdjustCents,
    split,
    totalCents: subtotalCents + cardAdjustCents + split.taxCents,
    /** Stripe line items at the tag price. */
    stripeLines: lines.map((l) => ({
      price_data: { currency: "usd", product_data: { name: `${l.name} — ${l.vendorName}`.slice(0, 120) }, unit_amount: tagCents(l.priceCents, cardPercent) },
      quantity: l.quantity,
    })),
  };
}

export type CartLine = {
  itemId: string; sku: string; name: string; priceCents: number; quantity: number;
  vendorId: string; vendorName: string;
  /** STANDARD or FOOD, snapshotted when the cart was built. Older carts have none. */
  taxClass?: string;
  /** The vendor's own price for one. `priceCents` is the customer's cash price
      (vendor price + market service fee). Older carts have none — then the two
      are the same. */
  vendorCents?: number;
};

// Books the sale exactly like a register sale once Stripe confirms payment. Idempotent.
export async function finalizeSelfCartIfPaid(cartId: string): Promise<boolean> {
  const cart = await db.selfCart.findUnique({ where: { id: cartId } });
  if (!cart) return false;
  if (cart.status === "PAID") return true;
  if (!cart.stripeSessionId || !stripe) return false;

  let paid = false;
  try {
    const session = await stripe.checkout.sessions.retrieve(cart.stripeSessionId);
    paid = session.payment_status === "paid";
  } catch { return false; }
  if (!paid) return false;

  const lines: CartLine[] = JSON.parse(cart.linesJson);
  const vendors = await db.vendor.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.vendorId))] } } });
  const vmap = new Map(vendors.map((v) => [v.id, v]));

  let number = 0;
  await db.$transaction(async (tx) => {
    const fresh = await tx.selfCart.findUnique({ where: { id: cart.id } });
    if (!fresh || fresh.status === "PAID") return;
    const last = await tx.sale.aggregate({ _max: { number: true } });
    number = Math.max(1000, (last._max.number || 999) + 1);
    const saleLines = lines.map((l) => {
      const v = vmap.get(l.vendorId);
      /* The vendor is paid on their own price; the service fee is the market's. */
      const shares = lineShares(l.vendorCents ?? l.priceCents, l.priceCents, l.quantity, v?.commissionPercent || 0);
      return {
        itemId: l.itemId, vendorId: l.vendorId, name: l.name, priceCents: l.priceCents,
        quantity: l.quantity, commissionCents: shares.commissionCents, vendorNetCents: shares.vendorNetCents,
        taxClass: normalizeTaxClass(l.taxClass),
      };
    });
    /* A vendor-rung cart goes through this same finalizer — the only difference
       is whose name ends up on the ticket. Keeping one path means a vendor sale
       decrements stock, credits the ledger and emails a receipt exactly like
       every other sale, with no second implementation to keep in step. */
    const soldBy = cart.soldByVendorId ? vmap.get(cart.soldByVendorId) : null;
    const sale = await tx.sale.create({
      data: {
        number, cardName: cart.email.split("@")[0] || "Self-checkout",
        employee: soldBy ? `VENDOR: ${soldBy.businessName}` : "SELF-CHECKOUT",
        soldByVendorId: cart.soldByVendorId || "",
        subtotalCents: cart.subtotalCents, taxCents: cart.taxCents, totalCents: cart.totalCents,
        /* What the card paid over the vendors' prices: the tag difference. */
        cardAdjustCents: Math.max(0, cart.totalCents - cart.subtotalCents - cart.taxCents),
        foodTaxCents: cart.foodTaxCents, standardTaxCents: cart.standardTaxCents,
        paymentMethod: "CARD", lines: { create: saleLines },
      },
    });
    for (const sl of saleLines) {
      await tx.item.update({ where: { id: sl.itemId }, data: { quantity: { decrement: sl.quantity } } }).catch(() => {});
      await tx.ledgerEntry.create({
        data: { vendorId: sl.vendorId, type: "SALE", amountCents: sl.vendorNetCents, note: `${sl.quantity}× ${sl.name} (self-checkout #${number})` },
      });
    }
    await tx.item.updateMany({ where: { quantity: { lt: 0 } }, data: { quantity: 0 } });
    await tx.selfCart.update({ where: { id: cart.id }, data: { status: "PAID", paidAt: new Date(), saleId: sale.id } });
  });
  if (number === 0) return true; // another request finalized it

  // notify each vendor their items sold (their normal sale-alert channel)
  const byVendor = new Map<string, CartLine[]>();
  for (const l of lines) {
    byVendor.set(l.vendorId, [...(byVendor.get(l.vendorId) || []), l]);
  }
  for (const [vendorId, vls] of byVendor) {
    const total = vls.reduce((n, l) => n + l.priceCents * l.quantity, 0);
    try { await pushToVendor(vendorId, "Sale! 🛒 (self-checkout)", `${vls.map((l) => `${l.quantity}× ${l.name}`).join(", ")} — $${(total / 100).toFixed(2)}`); } catch {}
  }
  try { await pushToAdmin("Self-checkout sale 💳", `#${number} — $${(cart.totalCents / 100).toFixed(2)}, ${lines.length} line${lines.length === 1 ? "" : "s"}`); } catch {}
  if (cart.email) {
    try {
      const customer = await findOrCreateCustomer(cart.email);
      if (customer) {
        const earned = pointsFor(cart.totalCents);
        if (earned > 0) {
          await db.customer.update({ where: { id: customer.id }, data: { points: { increment: earned } } });
          await db.loyaltyEvent.create({ data: { customerId: customer.id, saleId: cart.saleId, delta: earned, note: `Self-checkout #${number}` } });
        }
        await db.sale.updateMany({ where: { id: cart.saleId }, data: { customerId: customer.id } });
      }
    } catch {}
    const pct = await getCardAdjustPercent().catch(() => 0);
    const upl = Math.max(0, cart.totalCents - cart.subtotalCents - cart.taxCents);
    try { await sendSelfCheckoutReceiptEmail(cart.email, number, lines.map((l) => ({ name: l.name, quantity: l.quantity, priceCents: upl > 0 ? tagCents(l.priceCents, pct) : l.priceCents })), cart.subtotalCents + upl, cart.taxCents, cart.totalCents); } catch {}
  }
  return true;
}

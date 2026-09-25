import { db } from "@/lib/db";
import { getTaxRates, getCardAdjustPercent, getMarketFeePercent } from "@/lib/settings";
import { tagCents, cashCents } from "@/lib/cardprice";
import { taxFor, normalizeTaxClass } from "@/lib/tax";
import { effectivePriceCents } from "@/lib/pricing";

/**
 * Online orders.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: the market's floor stock is never sold
 * online. A product carries two counts — `quantity`, which the register draws
 * down, and `onlineQuantity`, which only orders draw down. They never touch.
 * A shopper at the booth holding the last jar cannot lose it to an order placed
 * from a sofa, and a vendor who sets aside four of something online still has
 * their shelf stock intact. Everything below goes through `onlineQuantity` and
 * nothing in here so much as reads `quantity`.
 *
 * STOCK IS CLAIMED WHEN CHECKOUT STARTS, not when payment lands. Claiming at
 * payment means two people can both reach Stripe for the last item and one of
 * them pays for something that isn't there — and by then you are refunding a
 * customer rather than telling them politely that it just went. The cost is
 * that an abandoned checkout holds stock, which is what the expiry release
 * below is for: Stripe sessions expire after 24 hours and the webhook puts the
 * items back.
 *
 * MONEY: the customer pays the market, exactly like every other sale here. The
 * vendor is credited on their ledger when the order is paid, which puts it into
 * the same balance the payout runs pay out. Commission comes off the goods and
 * NOT off the shipping — postage is the vendor's cost and their money.
 */

export type CartRequest = { itemId: string; quantity: number }[];

export type PricedLine = {
  itemId: string;
  name: string;
  unitLabel: string;
  priceCents: number;
  quantity: number;
  taxClass: string;
  shipCents: number;
  /** The vendor's own price for one — what commission and their share are
      worked out on. `priceCents` is the tag price the customer pays. */
  vendorCents: number;
};

export type PricedCart = {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  lines: PricedLine[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  foodTaxCents: number;
  standardTaxCents: number;
  totalCents: number;
  commissionCents: number;
  vendorNetCents: number;
};

export type PriceResult = { ok: true; cart: PricedCart } | { ok: false; error: string };

/** Per-order line cap — a sanity bound, not a business rule. */
const MAX_LINES = 20;
const MAX_QTY_PER_LINE = 20;

/**
 * Price a cart against what is actually for sale online right now.
 *
 * Nothing here trusts the browser: prices, shipping, tax and availability are
 * all read from the database. The cart only says which items and how many.
 */
export async function priceCart(
  vendorCode: string,
  request: CartRequest,
  fulfillment: "PICKUP" | "SHIP"
): Promise<PriceResult> {
  const vendor = await db.vendor.findFirst({
    where: { code: vendorCode.toUpperCase(), active: true, portalLocked: false },
    select: { id: true, code: true, businessName: true, commissionPercent: true },
  });
  if (!vendor) return { ok: false, error: "That vendor isn't taking orders." };

  const wanted = request.filter((l) => l && l.itemId).slice(0, MAX_LINES);
  if (!wanted.length) return { ok: false, error: "Your basket is empty." };

  const items = await db.item.findMany({
    where: { id: { in: wanted.map((l) => l.itemId) }, vendorId: vendor.id, active: true, onlineEnabled: true },
  });

  const lines: PricedLine[] = [];
  /* Online is always card, so the customer pays the TAG price (vendor's price
     plus the card percentage, per item) — the same number as the shelf label.
     The vendor is still paid on their own price. */
  const cardPercent = await getCardAdjustPercent();
  /* ...on top of the cash price, which is the vendor's price plus the market
     service fee. */
  const feePercent = await getMarketFeePercent();
  for (const w of wanted) {
    const item = items.find((i) => i.id === w.itemId);
    if (!item) return { ok: false, error: "Something in your basket isn't available online any more." };

    const qty = Math.max(1, Math.min(MAX_QTY_PER_LINE, Math.round(Number(w.quantity) || 1)));
    if (item.onlineQuantity < qty) {
      return {
        ok: false,
        error: item.onlineQuantity <= 0
          ? `${item.name} has just sold out online.`
          : `Only ${item.onlineQuantity} of ${item.name} left online.`,
      };
    }
    if (fulfillment === "SHIP" && !item.onlineShip) {
      return { ok: false, error: `${item.name} isn't available to post — it's pickup at the market only.` };
    }
    if (fulfillment === "PICKUP" && !item.onlinePickup) {
      return { ok: false, error: `${item.name} is posted rather than collected.` };
    }

    lines.push({
      itemId: item.id,
      name: item.name,
      unitLabel: item.unitLabel,
      priceCents: tagCents(cashCents(effectivePriceCents(item), feePercent), cardPercent),
      vendorCents: effectivePriceCents(item),
      quantity: qty,
      taxClass: normalizeTaxClass(item.taxClass),
      shipCents: Math.max(0, item.shipCents || 0),
    });
  }

  const subtotalCents = lines.reduce((n, l) => n + l.priceCents * l.quantity, 0);

  /* Shipping is charged once per ITEM, not per unit. Three jars of the same jam
     go in one box; charging postage three times would be a lie the vendor has
     to explain. */
  const shippingCents = fulfillment === "SHIP" ? lines.reduce((n, l) => n + l.shipCents, 0) : 0;

  /* Tax on the goods only. Oklahoma doesn't tax a separately-stated delivery
     charge, and this one is separately stated — on the checkout page, on the
     receipt and in the books. */
  const rates = await getTaxRates();
  const split = taxFor(
    lines.map((l) => ({ amountCents: l.priceCents * l.quantity, taxClass: normalizeTaxClass(l.taxClass) })),
    rates
  );

  /* Commission and the vendor's share come off the VENDOR'S price. The card
     percentage on top stays with the market to cover the card fees. */
  const vendorSubtotalCents = lines.reduce((n, l) => n + l.vendorCents * l.quantity, 0);
  const commissionCents = Math.round((vendorSubtotalCents * (vendor.commissionPercent || 0)) / 100);

  return {
    ok: true,
    cart: {
      vendorId: vendor.id,
      vendorCode: vendor.code,
      vendorName: vendor.businessName,
      lines,
      subtotalCents,
      shippingCents,
      taxCents: split.taxCents,
      foodTaxCents: split.foodTaxCents,
      standardTaxCents: split.standardTaxCents,
      totalCents: subtotalCents + shippingCents + split.taxCents,
      commissionCents,
      // Postage passes through untouched; commission comes off the goods only.
      vendorNetCents: vendorSubtotalCents - commissionCents + shippingCents,
    },
  };
}

/**
 * Take the online stock for an order, or say why it can't.
 *
 * Each item is claimed with a conditional UPDATE whose WHERE carries the
 * quantity test, so the database decides who wins when two carts race for the
 * last one. A read-then-write would let both through.
 */
export async function claimOnlineStock(lines: PricedLine[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const claimed: PricedLine[] = [];
  // A stable order so two orders sharing items can't deadlock.
  for (const l of [...lines].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
    const res = await db.item.updateMany({
      where: { id: l.itemId, onlineQuantity: { gte: l.quantity } },
      data: { onlineQuantity: { decrement: l.quantity } },
    });
    if (res.count === 0) {
      // Put back whatever this attempt already took.
      await releaseOnlineStock(claimed);
      return { ok: false, error: `${l.name} just sold out online — somebody got there first.` };
    }
    claimed.push(l);
  }
  return { ok: true };
}

/** Give stock back — an expired checkout, or a cancelled order. */
export async function releaseOnlineStock(lines: { itemId: string; quantity: number }[]): Promise<void> {
  for (const l of lines) {
    await db.item
      .update({ where: { id: l.itemId }, data: { onlineQuantity: { increment: l.quantity } } })
      .catch(() => { /* item deleted since: nothing to give back to */ });
  }
}

/** Sequential, human-quotable order numbers, in their own series from tickets. */
export async function nextOrderNumber(): Promise<number> {
  const last = await db.order.aggregate({ _max: { number: true } });
  return Math.max(5000, (last._max.number || 4999) + 1);
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING: "Waiting for payment",
  PAID: "Paid — needs packing",
  PACKED: "Packed",
  READY: "Ready for collection",
  COLLECTED: "Collected",
  SHIPPED: "Posted",
  EXPIRED: "Checkout abandoned",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
};

/** What the vendor can do next, given where an order is. */
export function nextStatuses(status: string, fulfillment: string): string[] {
  if (status === "PAID") return ["PACKED", "CANCELLED"];
  if (status === "PACKED") return fulfillment === "SHIP" ? ["SHIPPED", "CANCELLED"] : ["READY", "CANCELLED"];
  if (status === "READY") return ["COLLECTED", "CANCELLED"];
  return [];
}

/** Orders that still need somebody to do something. */
export const OPEN_STATUSES = ["PAID", "PACKED", "READY"];

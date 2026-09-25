import { db } from "@/lib/db";
import { getTaxRates, getCardAdjustPercent } from "@/lib/settings";
import { taxFor, normalizeTaxClass } from "@/lib/tax";
import { effectivePriceCents } from "@/lib/pricing";

/**
 * What a ticket costs, worked out once and written down.
 *
 * This exists because of the order a card sale has to happen in. The money is
 * taken BEFORE the sale is booked — the other way round would leave a ticket
 * in the books for a card that was declined — which means the total is needed
 * at the reader, minutes before the sale row is written.
 *
 * Pricing it twice would be the obvious thing and the wrong thing: a vendor
 * editing a price, a sale starting at noon, or a tax rate being corrected
 * between the tap and the booking would produce a receipt that disagrees with
 * the card slip. So the priced ticket is worked out here, kept, and the sale
 * is written FROM it. The customer is charged what the paper says, always.
 */

export type TicketLineIn = { itemId: string; quantity: number };

export type PricedLine = {
  itemId: string;
  vendorId: string;
  name: string;
  basePriceCents: number;
  priceCents: number;
  quantity: number;
  commissionCents: number;
  vendorNetCents: number;
  taxClass: string;
};

export type PricedTicket = {
  lines: PricedLine[];
  subtotalCents: number;
  saleSavingsCents: number;
  cardAdjustCents: number;
  /** A reward spent on this ticket, already taken off the total. */
  discountCents: number;
  taxCents: number;
  foodTaxCents: number;
  standardTaxCents: number;
  totalCents: number;
  /** The rate the ticket was priced at, kept for the receipt. */
  taxRatePercent: number;
};

export class TicketError extends Error {}

/**
 * Price a ticket the way the sale route prices one.
 *
 * Kept deliberately in step with api/admin/sale: same price function, same
 * commission arithmetic, same tax split, same rounding, in the same order.
 * Where the two must agree, they agree by doing the same thing rather than by
 * being checked against each other afterwards.
 */
export async function priceTicket(
  lines: TicketLineIn[],
  opts: { card: boolean; discountCents?: number }
): Promise<PricedTicket> {
  if (!Array.isArray(lines) || lines.length === 0) throw new TicketError("Nothing on the ticket.");

  const items = await db.item.findMany({
    where: { id: { in: lines.map((l) => l.itemId) } },
    include: { vendor: true },
  });

  const rates = await getTaxRates();
  const priced: PricedLine[] = [];
  let subtotalCents = 0;
  let saleSavingsCents = 0;

  for (const l of lines) {
    const item = items.find((i) => i.id === l.itemId);
    if (!item) throw new TicketError("An item on the ticket no longer exists.");
    const quantity = Math.max(1, Math.round(l.quantity));
    const unit = effectivePriceCents(item);
    saleSavingsCents += Math.max(0, item.priceCents - unit) * quantity;
    const gross = unit * quantity;
    const commissionCents = Math.round((gross * item.vendor.commissionPercent) / 100);
    subtotalCents += gross;
    priced.push({
      itemId: item.id,
      vendorId: item.vendorId,
      name: item.name,
      basePriceCents: item.priceCents,
      priceCents: unit,
      quantity,
      commissionCents,
      vendorNetCents: gross - commissionCents,
      taxClass: normalizeTaxClass(item.taxClass),
    });
  }

  const adjustPercent = await getCardAdjustPercent();
  const cardAdjustCents = opts.card && adjustPercent > 0 ? Math.round((subtotalCents * adjustPercent) / 100) : 0;

  const split = taxFor(
    priced.map((p) => ({ amountCents: p.priceCents * p.quantity, taxClass: normalizeTaxClass(p.taxClass) })),
    rates,
    cardAdjustCents
  );

  /* A reward can never turn a ticket into money owed back — it comes off what
     is due and stops at zero. */
  const gross = subtotalCents + cardAdjustCents + split.taxCents;
  const discountCents = Math.max(0, Math.min(Math.round(opts.discountCents || 0), gross));

  return {
    lines: priced,
    subtotalCents,
    saleSavingsCents,
    cardAdjustCents,
    discountCents,
    taxCents: split.taxCents,
    foodTaxCents: split.foodTaxCents,
    standardTaxCents: split.standardTaxCents,
    totalCents: gross - discountCents,
    taxRatePercent: rates.standardPercent,
  };
}

/** The priced ticket, as it goes into and comes out of the database. */
export function packTicket(t: PricedTicket): string {
  return JSON.stringify(t);
}

export function unpackTicket(s: string): PricedTicket | null {
  try {
    const t = JSON.parse(s) as PricedTicket;
    if (!t || !Array.isArray(t.lines) || typeof t.totalCents !== "number") return null;
    return t;
  } catch {
    return null;
  }
}

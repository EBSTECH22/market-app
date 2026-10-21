import { db } from "@/lib/db";
import { getTaxRates, getCardAdjustPercent, getMarketFeePercent } from "@/lib/settings";
import { marketFeeFor } from "@/lib/marketfee";
import { taxFor, normalizeTaxClass } from "@/lib/tax";
import { effectivePriceCents } from "@/lib/pricing";
import { cardUpliftCents, cashCents, lineShares } from "@/lib/cardprice";
import { validateSelection, resolveSelection, unitVendorCents, type OptionGroup, type Selection } from "@/lib/itemoptions";

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

/** `options` is group id → chosen option ids, exactly as the till sends them. */
export type TicketLineIn = { itemId: string; quantity: number; options?: Record<string, string[]> };

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
  /** The choices, in words, frozen onto the line. "" for an item without any. */
  optionsText: string;
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
    include: {
      vendor: true,
      optionGroups: { include: { options: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] },
    },
  });

  const rates = await getTaxRates();
  const priced: PricedLine[] = [];
  let subtotalCents = 0;
  let saleSavingsCents = 0;
  /* Customer cash price = vendor price + market service fee; see lib/cardprice.
     The rate is the vendor's own where they have one, so a ticket holding two
     vendors' goods charges each at the rate on their label. */
  const marketRate = await getMarketFeePercent();

  for (const l of lines) {
    const item = items.find((i) => i.id === l.itemId);
    if (!item) throw new TicketError("An item on the ticket no longer exists.");
    const quantity = Math.max(1, Math.round(l.quantity));

    /* Choices move the VENDOR'S price; the fee goes on top afterwards. Same
       arithmetic, same order, as api/admin/sale — the two have to agree to the
       cent or a card slip and a cash ticket for the same drink differ. */
    const groups = item.optionGroups as unknown as OptionGroup[];
    const picked = (l.options || {}) as Selection;
    if (groups.length) {
      const problem = validateSelection(groups, picked);
      if (problem) throw new TicketError(`${item.name}: ${problem}`);
    }
    const resolved = resolveSelection(groups, picked);

    const vendorUnit = unitVendorCents(effectivePriceCents(item), resolved.deltaCents);
    const fee = marketFeeFor(item.vendor, marketRate);
    const unit = cashCents(vendorUnit, fee);
    const cashBase = cashCents(unitVendorCents(item.priceCents, resolved.deltaCents), fee);
    saleSavingsCents += Math.max(0, cashBase - unit) * quantity;
    const gross = unit * quantity;
    const shares = lineShares(vendorUnit, unit, quantity, item.vendor.commissionPercent);
    subtotalCents += gross;
    priced.push({
      itemId: item.id,
      vendorId: item.vendorId,
      name: item.name,
      basePriceCents: cashBase,
      priceCents: unit,
      quantity,
      commissionCents: shares.commissionCents,
      vendorNetCents: shares.vendorNetCents,
      taxClass: normalizeTaxClass(item.taxClass),
      optionsText: resolved.text,
    });
  }

  const adjustPercent = await getCardAdjustPercent();
  /* Card pays the tag prices: each item's price plus the card percentage,
     rounded per item (lib/cardprice), so the charge equals the tags. */
  const cardAdjustCents = opts.card ? cardUpliftCents(priced, adjustPercent) : 0;

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

/**
 * A vendor's own discount — military, first responder, whatever they honour.
 *
 * WHOSE MONEY. Theirs. The customer pays less and the vendor receives less by
 * exactly the same amount; the market's fee on the sale does not move. That is
 * the whole design, and it is what lets a vendor switch this on without
 * anybody negotiating:
 *
 *     customer pays   = cash price − D
 *     vendor receives = vendor price − D
 *     market keeps    = cash price − vendor price   (unchanged)
 *
 * The alternative — the market absorbing it, the way the loyalty reward works
 * — does not survive contact with a standing percentage. A $5.00 drink at a
 * 10% market fee rings at $5.50 and earns the market $0.50; ten percent off
 * that ticket is $0.55. The market would pay five cents for the privilege of
 * making the sale, on every qualifying ticket, forever.
 *
 * APPLIED AT THE REGISTER AND NOWHERE ELSE — not because anything is checked,
 * but because a discount anybody can tick for themselves on a public ordering
 * page is not a discount, it is a price cut. At the counter it is a person's
 * decision. Nothing here asks for proof and nothing records whether any was
 * offered: a market that makes a veteran produce paperwork for a dollar off a
 * lemonade has lost more than it saved.
 *
 * Pure: no database, no next/headers. The till and the server both import it
 * and have to agree to the cent.
 */

export type VendorDiscount = {
  discountEnabled: boolean;
  discountLabel: string;
  discountMode: string;
  discountPercent: number;
  discountCents: number;
};

export type DiscountLine = {
  /** Which vendor's goods, so a flat amount is taken once per vendor. */
  vendorId: string;
  /** The vendor's own price for ONE, after options and any sale percentage. */
  vendorUnitCents: number;
  quantity: number;
};

/** Is this vendor offering anything at all? */
export function offersDiscount(v: VendorDiscount | null | undefined): boolean {
  if (!v?.discountEnabled) return false;
  return mode(v) === "PERCENT" ? pct(v) > 0 : Math.round(v.discountCents || 0) > 0;
}

function mode(v: VendorDiscount): "PERCENT" | "AMOUNT" {
  return String(v.discountMode || "PERCENT").toUpperCase() === "AMOUNT" ? "AMOUNT" : "PERCENT";
}

function pct(v: VendorDiscount): number {
  const n = Number(v.discountPercent);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(50, n);
}

/** "10% off" / "$1.00 off", for a button and a receipt. */
export function discountLabel(v: VendorDiscount): string {
  if (mode(v) === "AMOUNT") return `$${(Math.round(v.discountCents || 0) / 100).toFixed(2)} off`;
  return `${pct(v)}% off`;
}

/**
 * How much comes off each line.
 *
 * Returns cents off PER UNIT, keyed by the line's index, so the caller can
 * reduce the vendor's unit price and let every downstream figure — the cash
 * price, the commission, the tax, the vendor's net — fall out of the usual
 * arithmetic rather than being adjusted afterwards. Adjusting afterwards is
 * how a discounted ticket ends up taxed on the undiscounted amount.
 *
 * A FLAT AMOUNT IS TAKEN ONCE PER VENDOR, not once per line and not once per
 * unit: six drinks on one ticket is one visit by one person, and "$1 off"
 * meaning "$6 off" would be a surprise nobody intended. It is spread across
 * that vendor's units so the per-unit arithmetic still works, and any rounding
 * remainder lands on the first line rather than being lost.
 */
export function perUnitDiscounts(lines: DiscountLine[], byVendor: Map<string, VendorDiscount>): number[] {
  const out = new Array(lines.length).fill(0);

  const vendorTotals = new Map<string, { units: number; gross: number; idx: number[] }>();
  lines.forEach((l, i) => {
    const cur = vendorTotals.get(l.vendorId) || { units: 0, gross: 0, idx: [] };
    cur.units += Math.max(0, l.quantity);
    cur.gross += Math.max(0, l.vendorUnitCents) * Math.max(0, l.quantity);
    cur.idx.push(i);
    vendorTotals.set(l.vendorId, cur);
  });

  for (const [vendorId, totals] of vendorTotals) {
    const v = byVendor.get(vendorId);
    if (!offersDiscount(v) || !v || totals.units === 0 || totals.gross === 0) continue;

    if (mode(v) === "PERCENT") {
      const p = pct(v);
      for (const i of totals.idx) {
        /* Per unit, rounded per unit, so the line total is the unit price
           times the quantity and a receipt adds up. */
        out[i] = Math.min(lines[i].vendorUnitCents, Math.round((lines[i].vendorUnitCents * p) / 100));
      }
      continue;
    }

    /* A flat amount, once for this vendor, and never more than they are owed
       — a $5 discount on a $3 ticket must not pay the customer to turn up. */
    const total = Math.min(Math.round(v.discountCents || 0), totals.gross);
    let spread = 0;
    for (const i of totals.idx) {
      const units = Math.max(0, lines[i].quantity);
      if (units === 0) continue;
      const share = Math.round((total * (lines[i].vendorUnitCents * units)) / totals.gross);
      const per = Math.min(lines[i].vendorUnitCents, Math.floor(share / units));
      out[i] = per;
      spread += per * units;
    }
    /* Rounding leaves a few cents unspent. Give them to the first line that
       can take them, so "$1.00 off" really is a dollar. */
    let left = total - spread;
    for (const i of totals.idx) {
      if (left <= 0) break;
      const units = Math.max(0, lines[i].quantity);
      const room = lines[i].vendorUnitCents - out[i];
      if (units !== 1 || room <= 0) continue;
      const take = Math.min(left, room);
      out[i] += take;
      left -= take;
    }
  }

  return out;
}

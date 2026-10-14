/**
 * The market service fee, per vendor.
 *
 * The fee is the market's income: it sits on top of the vendor's price to make
 * the customer's cash price, and the difference is booked as the market's
 * share of the line. One rate in Settings covers everybody — until it
 * shouldn't. A vendor already paying a sales commission is being charged twice
 * for the same thing, and a vendor brought in on special terms needs the fee
 * gone without it going for the whole market.
 *
 * So the rate is the market's unless the vendor carries their own. Null on the
 * vendor means "whatever the market charges", including after the market rate
 * changes; a number means that number, and 0 means no fee at all.
 *
 * EVERY PLACE THAT PRICES SOMETHING FOR A CUSTOMER GOES THROUGH HERE — the
 * register, the vendor's own sell screen, the public shop, the market page, a
 * vendor's storefront, online orders, barcode labels and the item lookup. They
 * have to agree to the cent, because a label printed at one rate and a till
 * ringing at another is a customer watching a price change at the counter.
 */

/** What this vendor's fee is, given the market's rate. */
export function marketFeeFor(
  vendor: { marketFeePercent?: number | null } | null | undefined,
  marketRate: number
): number {
  const own = vendor?.marketFeePercent;
  if (own === null || own === undefined) return clamp(marketRate);
  return clamp(own);
}

/** Rates are a percentage, and a negative one would pay the customer. */
function clamp(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(25, n);
}

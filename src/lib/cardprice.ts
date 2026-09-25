/**
 * Tag prices (cash discount pricing).
 *
 * The price a VENDOR sets is what they're paid on — commission comes off it and
 * nothing else touches it. The price on the TAG (the label, the register, the
 * online shop) is that price plus the card percentage, rounded to the cent.
 * Card pays the tag. Cash gets the percentage back, i.e. pays the vendor's
 * price.
 *
 * Worked out PER ITEM, not on the ticket total, so a ticket always costs
 * exactly what its tags add up to. $5.00 at 3% is a $5.15 tag; three of them
 * are $15.45 on card and $15.00 cash, never a cent either way.
 *
 * Pure and dependency-free: the register, the labels page and the server all
 * import this, and must agree to the cent.
 */

/**
 * The customer's CASH price for one unit: the vendor's price plus the market
 * service fee. The fee is the market's income — it replaces charging vendors a
 * commission — and is built into the price rather than added at the end.
 */
export function cashCents(vendorCents: number, feePercent: number): number {
  const v = Math.max(0, Math.round(vendorCents || 0));
  if (!(feePercent > 0)) return v;
  return Math.round((v * (100 + feePercent)) / 100);
}

/**
 * Who gets what from one ticket line. The vendor is paid on THEIR price (less
 * any commission still set on them); everything the customer paid above that
 * — the service fee — is the market's, and is recorded as the line's
 * commission so every report of the market's share already counts it.
 */
export function lineShares(vendorUnitCents: number, cashUnitCents: number, quantity: number, commissionPercent: number) {
  const q = Math.max(0, Math.round(quantity));
  const vendorGross = Math.round(vendorUnitCents) * q;
  const commission = Math.round((vendorGross * (commissionPercent || 0)) / 100);
  return {
    commissionCents: (Math.round(cashUnitCents) - Math.round(vendorUnitCents)) * q + commission,
    vendorNetCents: vendorGross - commission,
  };
}

/** The tag price for one unit, from the customer's cash price. */
export function tagCents(cashCents: number, percent: number): number {
  const c = Math.max(0, Math.round(cashCents || 0));
  if (!(percent > 0)) return c;
  return Math.round((c * (100 + percent)) / 100);
}

/** What card adds over cash for a set of lines: the sum of each tag's difference. */
export function cardUpliftCents(lines: { priceCents: number; quantity: number }[], percent: number): number {
  if (!(percent > 0)) return 0;
  return lines.reduce((n, l) => n + (tagCents(l.priceCents, percent) - Math.round(l.priceCents)) * Math.max(0, Math.round(l.quantity)), 0);
}

/**
 * A line's sales at the VENDOR'S OWN price, for anything a vendor reads.
 *
 * Ticket lines are stored at the customer's price, which includes the market
 * service fee, and the fee is booked as the market's share. A vendor must see
 * neither: their sales are their prices, and their "commission" is only what
 * their own rate takes. Worked back from what they were credited (vendorNet)
 * and their rate, so it's exact whatever the fee was on the day.
 */
export function vendorGrossCents(vendorNetCents: number, commissionPercent: number): number {
  const pct = commissionPercent || 0;
  return pct > 0 && pct < 100 ? Math.round((vendorNetCents * 100) / (100 - pct)) : vendorNetCents;
}

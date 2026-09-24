/**
 * What the market is letting, and whether it's open or waiting-list.
 *
 * Shared by the public application page and the office, so a price or a
 * "full" only ever exists in one place. The rule that decides the waiting
 * list lives here too: an offer is waiting-list when it's been marked that
 * way OR when nothing is left, and an application against a waiting-list
 * offer is still accepted — it just joins the queue in the order it arrived.
 */

export type SpaceOfferRow = {
  key: string;
  name: string;
  blurb: string;
  priceCents: number;
  priceMaxCents: number;
  commissionPercent: number;
  available: number;
  waitlistOnly: boolean;
  active: boolean;
  sortOrder: number;
};

/** -1 is "no limit" — shelf space, not a numbered booth. */
export const UNLIMITED = -1;

export function isUnlimited(o: { available: number }): boolean {
  return o.available < 0;
}

export function spotsLeft(o: { available: number }): number | null {
  return isUnlimited(o) ? null : Math.max(0, o.available);
}

/** Does applying for this put you on the waiting list rather than in the queue to be called? */
export function waitlisted(o: { waitlistOnly: boolean; available: number }): boolean {
  return o.waitlistOnly || (!isUnlimited(o) && o.available <= 0);
}

const money = (cents: number) =>
  `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;

/** "$25/mo", "$35–$50/mo", or "Price on the call" when nothing is set. */
export function priceLabel(o: { priceCents: number; priceMaxCents: number }): string {
  if (o.priceCents <= 0 && o.priceMaxCents <= 0) return "Price on the call";
  if (o.priceMaxCents > o.priceCents) return `${money(o.priceCents)}–${money(o.priceMaxCents)}/mo`;
  return `${money(o.priceCents)}/mo`;
}

/** The whole cost in one line, commission included where there is one. */
export function termsLabel(o: { priceCents: number; priceMaxCents: number; commissionPercent: number }): string {
  const base = priceLabel(o);
  return o.commissionPercent > 0 ? `${base} + ${o.commissionPercent}% commission` : base;
}

/** What the apply page says under the option, and what the office reads on the row. */
export function availabilityLabel(o: { available: number; waitlistOnly: boolean }): string {
  if (o.waitlistOnly) return "Waiting list only";
  if (isUnlimited(o)) return "Space available";
  const left = spotsLeft(o) ?? 0;
  if (left === 0) return "All taken — waiting list";
  return left === 1 ? "1 available" : `${left} available`;
}

/** The three the market opened with. Used to seed, never to override the table. */
export const DEFAULT_OFFERS: SpaceOfferRow[] = [
  {
    key: "BOOTH_5X5",
    name: "5×5 booth",
    blurb: "Your own booth space, 5 ft by 5 ft. Set it up how you like; we run the register.",
    priceCents: 15000,
    priceMaxCents: 0,
    commissionPercent: 0,
    available: 0,
    waitlistOnly: false,
    active: true,
    sortOrder: 1,
  },
  {
    key: "SMALL_DISPLAY",
    name: "Small display",
    blurb: "A smaller display than a full booth — a rack, a stand, a shelf unit of your own.",
    priceCents: 3500,
    priceMaxCents: 5000,
    commissionPercent: 0,
    available: 0,
    waitlistOnly: false,
    active: true,
    sortOrder: 2,
  },
  {
    key: "MARKET_SPACE",
    name: "Market space",
    blurb: "No booth of your own — your items go on our shelves and sell through our register.",
    priceCents: 2500,
    priceMaxCents: 0,
    commissionPercent: 20,
    available: UNLIMITED,
    waitlistOnly: false,
    active: true,
    sortOrder: 3,
  },
];

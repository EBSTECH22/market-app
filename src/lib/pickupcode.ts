/**
 * The code a customer shows at the counter to collect an online pre-order.
 *
 * Derived, not stored. An order already has a 48-hex token that only the person
 * who placed it has ever seen, so the code is the order number plus the first
 * six characters of that token:
 *
 *     CH-5001-9F2A1C
 *
 * The number makes it findable by a human, and the six characters make it
 * unguessable enough that somebody can't collect a stranger's bag by walking in
 * and reciting the next number up. Nothing new is written to the database, so
 * there is no column to migrate, no uniqueness to police, and every order ever
 * placed already has a valid code.
 *
 * Six hex characters is 16.7 million per order number — not a secret worth
 * protecting with a secret, but far past what anybody guesses at a counter with
 * a cashier watching. The cashier still sees the customer's name before they
 * confirm, which is the check that actually matters.
 *
 * Deliberately pure: the till, the order page, the email builder and the lookup
 * route all need this, and two of those are client components.
 */

export const PICKUP_PREFIX = "CH";

/** The scannable, sayable code for an order. */
export function pickupCode(number: number, token: string): string {
  return `${PICKUP_PREFIX}-${number}-${String(token || "").slice(0, 6).toUpperCase()}`;
}

/**
 * Read a scanned or typed code back.
 *
 * Tolerant on input because it arrives three ways — a camera read, a wedge
 * scanner typing into a box, and a cashier typing what the customer is reading
 * off a phone. Hyphens optional, case ignored, whitespace stripped.
 */
export function parsePickupCode(raw: string): { number: number; check: string } | null {
  const s = String(raw || "").toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^CH-?(\d{1,9})-?([A-F0-9]{6})$/);
  if (!m) return null;
  const number = Number(m[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { number, check: m[2] };
}

/** Does this look like a collection code rather than a product barcode? */
export function isPickupCode(raw: string): boolean {
  return parsePickupCode(raw) !== null;
}

/** Does this code match this order? Compared case-insensitively, never by `===` on raw input. */
export function pickupCodeMatches(raw: string, order: { number: number; token: string }): boolean {
  const parsed = parsePickupCode(raw);
  if (!parsed) return false;
  return parsed.number === order.number && parsed.check === String(order.token || "").slice(0, 6).toUpperCase();
}

/**
 * Every Vendor column that is safe to hand to a client.
 *
 * passwordHash, stripeCustomerId, stripePmId and lastRestockAlertAt are
 * deliberately absent. Never return a bare `db.vendor.create/update/findX`
 * result — it carries all of them. Use this as the `select` instead.
 */
export const VENDOR_PUBLIC_SELECT = {
  id: true,
  code: true,
  businessName: true,
  contactName: true,
  email: true,
  phone: true,
  commissionPercent: true,
  mustChangePassword: true,
  acceptsPreorders: true,
  acceptsRequests: true,
  allowSelfCheckout: true,
  portalLocked: true,
  cardLast4: true,
  publicBlurb: true,
  active: true,
  createdAt: true,
} as const;

/** Bytes of entropy for a generated temporary password (96 bits, was 32). */
export const TEMP_PASSWORD_BYTES = 12;

/**
 * Which vendors the public is allowed to see.
 *
 * `active` alone is NOT enough. A vendor accepted from an application is
 * created with `active: true` and `portalLocked: true` — they exist, but they
 * haven't signed their agreement or paid their first month. Filtering on
 * `active` alone published those vendors on the market page, their own public
 * page, the feed and self-checkout the moment they were accepted.
 *
 * `portalLocked` is the onboarding flag. It is cleared by `unlockIfRentPaid`
 * only once the agreement is fully signed AND the balance is settled, which is
 * the same gate that opens their vendor portal — so public visibility and
 * portal access turn on together.
 *
 * Use this for every public-facing vendor query. Admin queries should NOT use
 * it; the office needs to see vendors who are still onboarding.
 */
export const PUBLIC_VENDOR_WHERE = {
  active: true,
  portalLocked: false,
} as const;

/** The same gate, expressed for a nested `vendor: { ... }` relation filter. */
export const PUBLIC_VENDOR_RELATION = { ...PUBLIC_VENDOR_WHERE } as const;

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

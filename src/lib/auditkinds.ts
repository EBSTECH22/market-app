/**
 * Audit action names and their labels — the pure half.
 *
 * Deliberately free of `next/headers`, Prisma and anything else server-only,
 * because the admin screen is a client component and renders these labels. The
 * writer lives in @/lib/audit and imports from here. (This split is the same
 * one @/lib/roles and @/lib/perm use, and for the same reason: a "use client"
 * file importing one constant drags the whole module graph into the browser
 * bundle.)
 */

export type AuditAction =
  | "SALE_VOID"
  | "SALE_REFUND"
  | "ITEM_PRICE"
  | "VENDOR_LEDGER"
  | "VENDOR_EDIT"
  | "VENDOR_PASSWORD_RESET"
  | "CONTRACT_EDIT"
  | "SETTING_CHANGE"
  | "EMPLOYEE_CHANGE"
  | "PAYOUT_RUN"
  | "PAYOUT_PAID"
  | "ORDER_COLLECTED"
  | "REVIEW_DELETE"
  | "DRAWER_CLOSE"
  | "NONPAYMENT_NOTICE"
  | "NONPAYMENT_TEXT"
  | "SPACE_RELEASED"
  | "SPACE_REHELD";

export const AUDIT_LABEL: Record<AuditAction, string> = {
  SALE_VOID: "Ticket voided",
  SALE_REFUND: "Refund given",
  ITEM_PRICE: "Price changed",
  VENDOR_LEDGER: "Balance adjusted",
  VENDOR_EDIT: "Vendor record changed",
  VENDOR_PASSWORD_RESET: "Vendor password reset",
  CONTRACT_EDIT: "Agreement changed",
  SETTING_CHANGE: "Setting changed",
  EMPLOYEE_CHANGE: "Staff account changed",
  PAYOUT_RUN: "Payout run created",
  PAYOUT_PAID: "Vendor paid",
  ORDER_COLLECTED: "Online order handed over",
  REVIEW_DELETE: "Review removed",
  DRAWER_CLOSE: "Drawer closed",
  NONPAYMENT_NOTICE: "Non-payment notice emailed",
  NONPAYMENT_TEXT: "Non-payment text opened",
  SPACE_RELEASED: "Booth opened back up",
  SPACE_REHELD: "Booth held again",
};

/** Actions where money left the market, for the "money out" filter. */
export const MONEY_OUT_ACTIONS: AuditAction[] = ["SALE_VOID", "SALE_REFUND", "VENDOR_LEDGER", "PAYOUT_PAID"];

export function auditLabel(action: string): string {
  return AUDIT_LABEL[action as AuditAction] || action;
}

/**
 * Who the shared admin password counts as.
 *
 * It predates individual accounts and still works, so a row can legitimately
 * say "somebody holding the owner password" rather than naming a person. Saying
 * that plainly is better than attributing it to an owner who may not have done
 * it.
 */
export const OWNER_KEY_LABEL = "Owner password (shared login)";

export function actorLabel(e: { actorType: string; actorName: string }): string {
  if (e.actorType === "OWNER_KEY") return OWNER_KEY_LABEL;
  if (e.actorType === "SYSTEM") return "System";
  return e.actorName || "Unknown";
}

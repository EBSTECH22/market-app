/**
 * What the market owes each vendor on the 15th.
 *
 * THE QUESTION THIS FILE EXISTS TO ANSWER, and the reason it is written as one
 * number per vendor rather than a screenful of figures: at the end of a month
 * the market has to write a cheque, and nothing in the app would say how big.
 * The payout screen showed a period's SALES next to a lifetime BALANCE, which
 * are two different things in the same row, and reading one as the other is
 * either paying a vendor twice or not paying them at all.
 *
 * So a statement reads top to bottom, the way somebody would write it out by
 * hand:
 *
 *     what their goods sold for          (gross, what the customer paid)
 *   − the market's share                 (fee and commission, already on the line)
 *   = their sales
 *   − rent charged for the month
 *   + credit for days the market shut
 *   ± anything else adjusted by hand
 *   + what was already owed from before
 *   = what to pay them on the 15th
 *
 * Every figure is from the ledger except the sales split, which comes from the
 * sale lines where it was decided at the moment of sale. Nothing is recomputed
 * from today's prices or today's fee.
 */

export type MonthKey = string; // "YYYY-MM"

/** Days in a calendar month, from its key. Leap years included. */
export function daysInMonth(month: MonthKey): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Every day of the month as YYYY-MM-DD. */
export function daysOf(month: MonthKey): string[] {
  const n = daysInMonth(month);
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/**
 * The rent credit for a month's closed days.
 *
 * A day's rent is the month's rent divided by the days in THAT month, so
 * February's days are worth more than March's — which is what a tenant would
 * expect and what makes the figures add up when somebody checks.
 *
 * Rounded once, at the end, on the total rather than per day: crediting three
 * days at $4.8387 each and rounding each one loses a cent and leaves a vendor
 * holding a statement that is a penny out.
 */
export function closureCreditCents(monthlyRentCents: number, month: MonthKey, closedDays: number): number {
  const rent = Math.max(0, Math.round(monthlyRentCents || 0));
  const total = daysInMonth(month);
  const closed = Math.max(0, Math.min(total, Math.round(closedDays || 0)));
  if (rent === 0 || closed === 0) return 0;
  /* Closing every day of a month means the whole month's rent back, not more. */
  return Math.min(rent, Math.round((rent * closed) / total));
}

export type StatementRow = {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  /** What customers paid for their goods this month. */
  salesGrossCents: number;
  /** The market's cut of that — service fee plus any commission. */
  marketShareCents: number;
  /** What the sales put on their ledger. */
  salesNetCents: number;
  /** Refunds and voids given back this month, as a positive number. */
  refundsCents: number;
  /** Rent charged this month. Positive = charged. */
  rentChargedCents: number;
  /** Credit for days the market didn't open. Positive = given back. */
  closureCreditCents: number;
  /** Rent they paid in this month. */
  rentPaidCents: number;
  /** Anything adjusted by hand this month. Signed. */
  adjustmentsCents: number;
  /** Payouts already made this month, as a positive number. */
  paidOutCents: number;
  /** Ledger activity the breakdown above doesn't name. Normally zero. Signed. */
  otherCents: number;
  /** Their balance at the START of the month. Signed. */
  openingBalanceCents: number;
  /** Their balance now, after everything above. Signed. */
  closingBalanceCents: number;
  /** What to actually hand over. Never negative. */
  dueCents: number;
};

/** What to pay: the balance, floored at zero. Owing the market is not a payout. */
export function dueFromBalance(closingBalanceCents: number): number {
  return closingBalanceCents > 0 ? closingBalanceCents : 0;
}

/**
 * The marker that stops a month's closure credit being posted twice.
 *
 * Written into the ledger note, because the alternative — a separate table
 * recording that it happened — can get out of step with the entries it is
 * describing. The note IS the record.
 */
export function closureCreditMarker(month: MonthKey): string {
  return `[closed ${month}]`;
}

/** The line a vendor reads on their statement. */
export function closureCreditNote(month: MonthKey, closedDays: number, totalDays: number): string {
  const d = `${closedDays} ${closedDays === 1 ? "day" : "days"}`;
  return `Rent credit — market closed ${d} of ${totalDays} in ${month} ${closureCreditMarker(month)}`;
}

/**
 * One paycheck, worked out.
 *
 * Pure arithmetic — no database, no dates beyond what it is handed — so it can
 * be tested against the IRS's own worked examples rather than against what the
 * screen happens to show.
 *
 * THE METHOD IS IRS PUBLICATION 15-T, WORKSHEET 1A, step for step, because the
 * shortcut is where the money goes wrong. The temptation is to build a weekly
 * bracket table and apply it to a weekly wage; the Lightfoot calculator did
 * exactly that and over-withheld every low-wage weekly paycheck, because the
 * standard-deduction subtraction (line 1g) and the 0% band only exist on the
 * ANNUAL schedule. The real sequence is:
 *
 *     annualise the period's wage          (1a x periods)
 *   + Step 4(a) other income               (annual figure, as entered)
 *   − Step 4(b) deductions                 (annual figure, as entered)
 *   − $8,600, or $12,900 married jointly   (1g; zero if Step 2 is checked)
 *   = adjusted annual wage                 (1i)
 *   → annual schedule → annual tentative   (2g)
 *   ÷ periods per year                     (2h)
 *   − Step 3 dependant credits ÷ periods   (3b)
 *   + Step 4(c) extra per period           (4a, NOT divided)
 *   = withhold this period
 *
 * Every amount in and out is integer CENTS. Rounding happens where the
 * worksheet says and nowhere else.
 */

import {
  ADDL_MEDICARE_RATE, ADDL_MEDICARE_THRESHOLD_CENTS, FED_ANNUAL, LINE_1G_CENTS,
  MEDICARE_RATE, OK_ALLOWANCE_CENTS, OK_ANNUAL, OK_STD_DEDUCTION_CENTS,
  SS_RATE, SS_WAGE_BASE_CENTS,
  type Bracket, type FilingStatus, type OkStatus,
} from "@/lib/taxtables";

/** What the employee's W-4 and OK-W-4 say. Annual figures except Step 4(c). */
export type W4 = {
  fedFilingStatus: FilingStatus;
  fedStep2: boolean;
  /** Step 3 — the annual dependant credit, in cents. */
  fedDependentsCents: number;
  /** Step 4(a) — other annual income, in cents. */
  fedOtherIncomeCents: number;
  /** Step 4(b) — annual deductions beyond the standard, in cents. */
  fedDeductionsCents: number;
  /** Step 4(c) — extra to withhold EACH PAY PERIOD, in cents. */
  fedExtraCents: number;
  okFilingStatus: OkStatus;
  okAllowances: number;
  /** Extra Oklahoma withholding each pay period, in cents. */
  okExtraCents: number;
};

/** Defaults for somebody who has handed in no paperwork: single, nothing else. */
export const DEFAULT_W4: W4 = {
  fedFilingStatus: "SINGLE",
  fedStep2: false,
  fedDependentsCents: 0,
  fedOtherIncomeCents: 0,
  fedDeductionsCents: 0,
  fedExtraCents: 0,
  okFilingStatus: "SINGLE",
  okAllowances: 0,
  okExtraCents: 0,
};

/** Walk an annual schedule. Rows are ascending; the last one passed wins. */
export function applySchedule(annualCents: number, brackets: Bracket[]): number {
  let tax = 0;
  for (let i = brackets.length - 1; i >= 0; i--) {
    if (annualCents >= brackets[i].over) {
      tax = brackets[i].base + (annualCents - brackets[i].over) * brackets[i].rate;
      break;
    }
  }
  return Math.max(0, Math.round(tax));
}

/**
 * Federal income tax for one pay period, or null when there is no table for
 * this person's filing status.
 *
 * Null is a real answer, not a failure to compute: it means "nobody has
 * entered the schedule for this status yet, so type the figure in". Returning
 * 0 instead would quietly withhold nothing, which looks identical on screen to
 * a correctly computed zero.
 */
export function federalWithholdingCents(
  grossCents: number,
  periodsPerYear: number,
  w4: W4
): number | null {
  const table = FED_ANNUAL[w4.fedFilingStatus];
  const brackets = w4.fedStep2 ? table.step2 : table.standard;
  if (!brackets) return null;

  const periods = Math.max(1, Math.round(periodsPerYear));

  const line1c = grossCents * periods;
  const line1e = line1c + w4.fedOtherIncomeCents;
  const line1g = w4.fedStep2 ? 0 : (w4.fedFilingStatus === "MFJ" ? LINE_1G_CENTS.MFJ : LINE_1G_CENTS.OTHER);
  const line1h = w4.fedDeductionsCents + line1g;
  const line1i = Math.max(0, line1e - line1h);

  const line2g = applySchedule(line1i, brackets);
  const line2h = Math.round(line2g / periods);

  const line3b = Math.round(w4.fedDependentsCents / periods);
  const line3c = Math.max(0, line2h - line3b);

  return line3c + w4.fedExtraCents;
}

/**
 * Oklahoma income tax for one pay period, or null when the tables are not in.
 *
 * Deliberately separate from the federal calculation rather than folded into
 * it: the two are published by different authorities on different schedules,
 * and one of them being unknown must not stop the other being right.
 */
export function oklahomaWithholdingCents(
  grossCents: number,
  periodsPerYear: number,
  w4: W4
): number | null {
  const brackets = OK_ANNUAL[w4.okFilingStatus];
  const std = OK_STD_DEDUCTION_CENTS[w4.okFilingStatus];
  if (!brackets || OK_ALLOWANCE_CENTS === null || std === null) return null;

  const periods = Math.max(1, Math.round(periodsPerYear));
  const annual = grossCents * periods;
  const allowances = Math.max(0, Math.round(w4.okAllowances)) * OK_ALLOWANCE_CENTS;
  const taxable = Math.max(0, annual - std - allowances);
  const annualTax = applySchedule(taxable, brackets);
  return Math.round(annualTax / periods) + w4.okExtraCents;
}

/**
 * Social Security for one pay period, respecting the annual wage base.
 *
 * `ytdSsWagesCents` is wages ALREADY subjected to Social Security this year,
 * not gross pay. They differ the moment anything untaxed for OASDI goes
 * through payroll, and measuring the cap against gross would stop withholding
 * early.
 */
export function socialSecurityCents(grossCents: number, ytdSsWagesCents: number): number {
  const remaining = Math.max(0, SS_WAGE_BASE_CENTS - Math.max(0, ytdSsWagesCents));
  const taxable = Math.min(Math.max(0, grossCents), remaining);
  return Math.round(taxable * SS_RATE);
}

/**
 * Medicare for one pay period, including the Additional Medicare Tax.
 *
 * The extra 0.9% starts once year-to-date wages pass the threshold, and only
 * on the part above it — so the paycheck that straddles the threshold is
 * split rather than charged the higher rate on the whole of it.
 */
export function medicareCents(grossCents: number, ytdWagesCents: number): number {
  const gross = Math.max(0, grossCents);
  const base = Math.round(gross * MEDICARE_RATE);

  const ytd = Math.max(0, ytdWagesCents);
  const after = ytd + gross;
  if (after <= ADDL_MEDICARE_THRESHOLD_CENTS) return base;
  const overPortion = after - Math.max(ytd, ADDL_MEDICARE_THRESHOLD_CENTS);
  return base + Math.round(Math.max(0, overPortion) * ADDL_MEDICARE_RATE);
}

/** Hours x rate, rounded to the cent. Hours are in hundredths of an hour. */
export function grossFromHours(hourHundredths: number, rateCents: number): number {
  return Math.round((Math.max(0, hourHundredths) * Math.max(0, rateCents)) / 100);
}

export type StubInput = {
  /** Hundredths of an hour — 8.25 hours is 825. */
  hourHundredths: number;
  rateCents: number;
  /** Set to override hours x rate — a bonus, a correction, a salaried week. */
  grossOverrideCents?: number | null;
  periodsPerYear: number;
  w4: W4;
  /** Recurring named deductions, after tax. */
  otherDeductionsCents: number;
  ytdGrossCents: number;
  ytdSsWagesCents: number;
  /** Any figure the office typed in itself. Overrides the computed one. */
  overrides?: {
    ssCents?: number | null;
    medicareCents?: number | null;
    federalCents?: number | null;
    stateCents?: number | null;
  };
};

export type Stub = {
  hourHundredths: number;
  rateCents: number;
  grossCents: number;
  ssCents: number;
  medicareCents: number;
  federalCents: number;
  stateCents: number;
  otherDeductionsCents: number;
  totalWithheldCents: number;
  netCents: number;
  /** Which figures the office typed rather than the engine working out. */
  manual: ("gross" | "ss" | "medicare" | "federal" | "state")[];
  /**
   * Figures with no table behind them and no hand-entered value either. A stub
   * with anything in here is NOT finished — see `isComplete`.
   */
  missing: ("federal" | "state")[];
};

/**
 * Work out one paycheck.
 *
 * Never throws and never substitutes a zero for a figure it doesn't know. A
 * withholding it cannot compute comes back as 0 WITH its name in `missing`, so
 * the screen can mark the row and refuse to pay it rather than handing over a
 * net that is quietly too big.
 */
export function buildStub(input: StubInput): Stub {
  const manual: Stub["manual"] = [];
  const missing: Stub["missing"] = [];
  const ov = input.overrides || {};

  const grossCents =
    typeof input.grossOverrideCents === "number"
      ? (manual.push("gross"), Math.max(0, Math.round(input.grossOverrideCents)))
      : grossFromHours(input.hourHundredths, input.rateCents);

  let ssCents: number;
  if (typeof ov.ssCents === "number") { ssCents = Math.max(0, Math.round(ov.ssCents)); manual.push("ss"); }
  else ssCents = socialSecurityCents(grossCents, input.ytdSsWagesCents);

  let medCents: number;
  if (typeof ov.medicareCents === "number") { medCents = Math.max(0, Math.round(ov.medicareCents)); manual.push("medicare"); }
  else medCents = medicareCents(grossCents, input.ytdGrossCents);

  let fedCents: number;
  if (typeof ov.federalCents === "number") { fedCents = Math.max(0, Math.round(ov.federalCents)); manual.push("federal"); }
  else {
    const computed = federalWithholdingCents(grossCents, input.periodsPerYear, input.w4);
    if (computed === null) { fedCents = 0; missing.push("federal"); }
    else fedCents = computed;
  }

  let stateCents: number;
  if (typeof ov.stateCents === "number") { stateCents = Math.max(0, Math.round(ov.stateCents)); manual.push("state"); }
  else {
    const computed = oklahomaWithholdingCents(grossCents, input.periodsPerYear, input.w4);
    if (computed === null) { stateCents = 0; missing.push("state"); }
    else stateCents = computed;
  }

  const other = Math.max(0, Math.round(input.otherDeductionsCents));
  const totalWithheldCents = ssCents + medCents + fedCents + stateCents + other;

  return {
    hourHundredths: input.hourHundredths,
    rateCents: input.rateCents,
    grossCents,
    ssCents,
    medicareCents: medCents,
    federalCents: fedCents,
    stateCents,
    otherDeductionsCents: other,
    totalWithheldCents,
    /* Net can't go below zero: a deduction bigger than the cheque is a thing
       to fix, not a negative paycheck to hand somebody. */
    netCents: Math.max(0, grossCents - totalWithheldCents),
    manual,
    missing,
  };
}

/** A stub is finished when nothing is missing a figure. */
export function isComplete(stub: Stub): boolean {
  return stub.missing.length === 0;
}

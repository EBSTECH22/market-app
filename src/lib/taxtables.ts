/**
 * The tax figures, in one file, with the year on them.
 *
 * EVERY NUMBER IN HERE EXPIRES. The federal schedules, the Social Security
 * wage base and Oklahoma's brackets are all re-published each year, so this
 * file is the one thing that has to be replaced every January — which is
 * exactly why it is a file of its own and not scattered through the payroll
 * code. `YEAR` below is what the engine checks against; if it doesn't match
 * the year being paid, the engine refuses rather than withholding last year's
 * rates.
 *
 * WHERE EACH FIGURE CAME FROM is recorded beside it, and anything NOT read
 * from the source document is left `null` on purpose. A null table makes the
 * engine stop and ask for a figure; a guessed table withholds the wrong amount
 * from somebody's wages and nobody finds out until they file. Null is the
 * safer failure.
 */

export const YEAR = 2026;

/* ------------------------------------------------------------------ FICA -- */

/* Source: SSA, announced 24 Oct 2025 — the 2026 OASDI wage base is $184,500,
   up from $176,100 in 2025. Medicare stays at 1.45% each side with no cap. */
export const SS_RATE = 0.062;
export const SS_WAGE_BASE_CENTS = 184_500_00;
export const MEDICARE_RATE = 0.0145;
/* Additional Medicare: 0.9% on earned income over $200,000 (single), unchanged.
   Applied on top of the 1.45% once year-to-date wages pass the threshold. */
export const ADDL_MEDICARE_RATE = 0.009;
export const ADDL_MEDICARE_THRESHOLD_CENTS = 200_000_00;

/* -------------------------------------------------------------- federal -- */

/**
 * One row of an IRS Percentage Method schedule, in cents.
 *
 * `over` is column A ("at least"), `base` is column C ("the tentative amount
 * to withhold"), `rate` is column D. Read as: once the adjusted ANNUAL wage
 * passes `over`, withhold `base` plus `rate` of everything above `over`.
 */
export type Bracket = { over: number; base: number; rate: number };

export type FilingStatus = "SINGLE" | "MFJ" | "HOH";

/**
 * Pub 15-T Worksheet 1A line 1g — the amount subtracted from the annualised
 * wage BEFORE the schedule is applied. Zero when the Step 2 box is checked.
 *
 * This is the step the Lightfoot calculator was missing, and the reason it
 * over-withheld: without it a $160-a-week cashier was taxed from the first
 * dollar instead of owing nothing at all.
 */
export const LINE_1G_CENTS = { MFJ: 12_900_00, OTHER: 8_600_00 } as const;

/**
 * Annual Percentage Method schedules for 2026.
 *
 * MFJ (both schedules) read verbatim from Publication 15-T (2026),
 * irs.gov/pub/irs-pdf/p15t.pdf. Each was checked for internal consistency —
 * every row's `base` equals the tax accumulated by the row below it — and both
 * reconcile exactly, which is the strongest evidence available that they were
 * transcribed correctly.
 *
 * SINGLE and HOH are null: the PDF's text extraction truncates mid-table at
 * precisely those schedules, across five attempts, so they have NOT been read.
 * They are not derived and not guessed.
 *
 * A NOTE FOR WHOEVER FILLS THEM IN: the MFJ figures imply the structure. Line
 * 1g ($12,900) plus the standard schedule's 0% band ($19,300) comes to
 * $32,200, the 2026 married standard deduction — and the Step 2 schedule's 0%
 * band ($16,100) is exactly half of that. By the same relationship the single
 * standard schedule's 0% band should be about $7,500 (so that $8,600 + $7,500
 * = $16,100, the single standard deduction) and the single Step 2 band about
 * $8,050. If the figures you read are near those, they are probably right; if
 * they are not, stop, because the blocks have been mis-read.
 */
export const FED_ANNUAL: Record<FilingStatus, { standard: Bracket[] | null; step2: Bracket[] | null }> = {
  MFJ: {
    standard: [
      { over: 0, base: 0, rate: 0 },
      { over: 19_300_00, base: 0, rate: 0.10 },
      { over: 44_100_00, base: 2_480_00, rate: 0.12 },
      { over: 120_100_00, base: 11_600_00, rate: 0.22 },
      { over: 230_700_00, base: 35_932_00, rate: 0.24 },
      { over: 422_850_00, base: 82_048_00, rate: 0.32 },
      { over: 531_750_00, base: 116_896_00, rate: 0.35 },
      { over: 788_000_00, base: 206_583_50, rate: 0.37 },
    ],
    step2: [
      { over: 0, base: 0, rate: 0 },
      { over: 16_100_00, base: 0, rate: 0.10 },
      { over: 28_500_00, base: 1_240_00, rate: 0.12 },
      { over: 66_500_00, base: 5_800_00, rate: 0.22 },
      { over: 121_800_00, base: 17_966_00, rate: 0.24 },
      { over: 217_875_00, base: 41_024_00, rate: 0.32 },
      { over: 272_325_00, base: 58_448_00, rate: 0.35 },
      { over: 400_450_00, base: 103_291_75, rate: 0.37 },
    ],
  },
  SINGLE: { standard: null, step2: null },
  HOH: { standard: null, step2: null },
};

/* ------------------------------------------------------------- Oklahoma -- */

export type OkStatus = "SINGLE" | "MARRIED";

/**
 * Oklahoma withholding, 2026 — NOT YET FILLED IN.
 *
 * oklahoma.gov refused every request, so none of this has been read from the
 * Tax Commission's own tables (Packet OW-2): not the brackets, not the value
 * of an allowance, not whether a standard deduction is subtracted separately
 * from allowances or already built into the thresholds. That last question
 * matters most — the Lightfoot calculator subtracts BOTH, which double-counts
 * if Oklahoma bakes the deduction into its brackets.
 *
 * Until it is filled in, Oklahoma withholding is entered by hand on the run.
 */
export const OK_ANNUAL: Record<OkStatus, Bracket[] | null> = {
  SINGLE: null,
  MARRIED: null,
};
/** Annual value of one Oklahoma withholding allowance. Null = unknown. */
export const OK_ALLOWANCE_CENTS: number | null = null;
/**
 * Annual Oklahoma standard deduction to subtract, or null if Oklahoma's
 * brackets already include it. UNKNOWN — see above. `0` would be a claim;
 * null is the truth.
 */
export const OK_STD_DEDUCTION_CENTS: Record<OkStatus, number | null> = {
  SINGLE: null,
  MARRIED: null,
};

/** Is there enough in here to work out federal withholding for this person? */
export function hasFederalTable(status: FilingStatus, step2: boolean): boolean {
  const t = FED_ANNUAL[status];
  return !!(step2 ? t.step2 : t.standard);
}

/** Is there enough in here to work out Oklahoma withholding? */
export function hasOklahomaTable(status: OkStatus): boolean {
  return !!OK_ANNUAL[status] && OK_ALLOWANCE_CENTS !== null && OK_STD_DEDUCTION_CENTS[status] !== null;
}

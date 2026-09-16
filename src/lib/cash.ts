/**
 * Cash tendering: what they handed over, what goes back.
 *
 * Pure functions, no React, no database — so the register tab and the kiosk
 * page can share one implementation and can't drift into disagreeing about
 * somebody's change. Every amount is in cents; nothing here ever sees a float.
 */

/** The bills a customer actually hands over at a market stall. */
export const QUICK_BILLS_CENTS = [500, 1000, 2000, 5000, 10000] as const;

/** US denominations, largest first — the order you'd count change out in. */
const DENOMINATIONS: { cents: number; label: string; plural: string; coin: boolean }[] = [
  { cents: 10000, label: "$100", plural: "$100 bills", coin: false },
  { cents: 5000, label: "$50", plural: "$50 bills", coin: false },
  { cents: 2000, label: "$20", plural: "$20 bills", coin: false },
  { cents: 1000, label: "$10", plural: "$10 bills", coin: false },
  { cents: 500, label: "$5", plural: "$5 bills", coin: false },
  { cents: 100, label: "$1", plural: "$1 bills", coin: false },
  { cents: 25, label: "quarter", plural: "quarters", coin: true },
  { cents: 10, label: "dime", plural: "dimes", coin: true },
  { cents: 5, label: "nickel", plural: "nickels", coin: true },
  { cents: 1, label: "penny", plural: "pennies", coin: true },
];

export type TenderState = {
  /** Enough to cover the sale. */
  sufficient: boolean;
  /** What goes back to the customer. 0 when they paid exactly. */
  changeCents: number;
  /** How much more is needed. 0 once they've covered it. */
  shortCents: number;
};

/**
 * Work out the change.
 *
 * Note the deliberate asymmetry: `changeCents` is only ever positive, and
 * `shortCents` is only ever positive. A single signed number reads fine in code
 * and badly on a screen at speed — "-$3.50" next to "CHANGE" is exactly the
 * kind of thing that gets handed to a customer at a busy market.
 */
export function tenderState(totalCents: number, tenderedCents: number): TenderState {
  const total = Math.max(0, Math.round(totalCents));
  const given = Math.max(0, Math.round(tenderedCents));
  const diff = given - total;
  return {
    sufficient: diff >= 0,
    changeCents: diff > 0 ? diff : 0,
    shortCents: diff < 0 ? -diff : 0,
  };
}

export type ChangePart = { cents: number; count: number; label: string; plural: string; coin: boolean };

/**
 * The change broken into bills and coins, largest first.
 *
 * This exists because counting change back is where a tired cashier loses money,
 * in both directions. "Give $13.37" is a puzzle; "1 × $10, 3 × $1, 1 quarter,
 * 1 dime, 2 pennies" is an instruction.
 */
export function changeBreakdown(changeCents: number): ChangePart[] {
  let left = Math.max(0, Math.round(changeCents));
  const parts: ChangePart[] = [];
  for (const d of DENOMINATIONS) {
    if (left < d.cents) continue;
    const count = Math.floor(left / d.cents);
    left -= count * d.cents;
    parts.push({ cents: d.cents, count, label: d.label, plural: d.plural, coin: d.coin });
  }
  return parts;
}

/**
 * "1 × $10 · 3 × $1 · 1 quarter" — for a receipt line or a one-line hint.
 *
 * Bills and coins read differently on purpose. "3 × $1 bills" is clumsy where
 * "3 × $1" is instant, but "2 × quarter" is worse than "2 quarters". The
 * cashier is reading this at speed with someone waiting.
 */
export function changeBreakdownText(changeCents: number): string {
  return changeBreakdown(changeCents)
    .map((p) => (p.coin ? `${p.count} ${p.count === 1 ? p.label : p.plural}` : `${p.count} × ${p.label}`))
    .join(" · ");
}

/**
 * Sensible one-tap amounts for this exact total, beyond the fixed bill buttons.
 *
 * Covers what people actually hand over: the exact amount, the next whole
 * dollar (for a $12.40 total, a $13 handful of notes), and the next $5 and $10
 * up. Anything already equal to the total, or duplicated, is dropped — a row of
 * buttons where two do the same thing is a row that gets misread.
 */
export function suggestedTenders(totalCents: number): number[] {
  const total = Math.max(0, Math.round(totalCents));
  if (total <= 0) return [];
  const roundUpTo = (step: number) => Math.ceil(total / step) * step;
  const candidates = [total, roundUpTo(100), roundUpTo(500), roundUpTo(1000), roundUpTo(2000)];
  const seen = new Set<number>();
  return candidates.filter((c) => {
    if (c < total || seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}

/**
 * Parse what someone typed into a cash field.
 *
 * Accepts "20", "20.00", "$20", " 20.5 ". Returns null for anything it can't
 * read, so the caller can leave the field alone rather than silently turning a
 * typo into a number. Deliberately does NOT accept negatives: there is no such
 * thing as negative cash in a drawer, and a stray minus sign would otherwise
 * sail through into the change calculation.
 */
export function parseCashInput(raw: string): number | null {
  const cleaned = String(raw).replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  if (!/^\d*\.?\d{0,2}$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

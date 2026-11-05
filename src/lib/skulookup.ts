import { db } from "@/lib/db";

/**
 * Working out which item a scanned code means.
 *
 * WHY THIS EXISTS. A SKU is `V01-0023`, and the separator is the one character
 * in it that a scan can get wrong without the barcode looking wrong. A camera
 * read on a thermal label came back as `V01,0023` — comma for hyphen, one
 * value out in the Code 128 table — and the till said no such item while the
 * label in the shopper's hand plainly read V01-0023. Nothing on either side
 * looked broken, which is the worst kind of broken.
 *
 * So: match on the letters and digits, and treat the punctuation as noise.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is relax anything else. Letters and digits
 * must match exactly — a misread that turns 0023 into 0024 is a different jar
 * and must still fail. And a loose match only counts when exactly ONE item
 * matches: two candidates means the till asks rather than guesses, because
 * ringing up somebody else's goods is worse than a code that didn't scan.
 */

/** The comparable core of a code: letters and digits, uppercased. */
export function skuKey(raw: string): string {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type SkuMatch =
  | { sku: string; exact: boolean }
  | null;

/**
 * The canonical SKU a scanned or typed code refers to, or null.
 *
 * Exact match first — that is every normal scan, and it costs one indexed
 * lookup. The separator-insensitive pass only runs on a miss, which is when
 * reading the whole SKU list is affordable; a market has hundreds of items,
 * not millions.
 */
export async function resolveSku(raw: string): Promise<SkuMatch> {
  const typed = String(raw || "").trim().toUpperCase();
  if (!typed) return null;

  const exact = await db.item.findUnique({ where: { sku: typed }, select: { sku: true } });
  if (exact) return { sku: exact.sku, exact: true };

  const key = skuKey(typed);
  /* Too short to be a SKU — don't go fishing through the catalogue for "A". */
  if (key.length < 4) return null;

  const all = await db.item.findMany({ select: { sku: true } });
  const hits = all.filter((i) => skuKey(i.sku) === key);
  return hits.length === 1 ? { sku: hits[0].sku, exact: false } : null;
}

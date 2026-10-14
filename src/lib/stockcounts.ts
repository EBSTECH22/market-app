import { db } from "@/lib/db";

/**
 * Setting floor counts in bulk.
 *
 * WHY THIS EXISTS. Counting stock one item at a time was the only way to do
 * it, and it was fine for a vendor with four jars. A baker has two dozen lines
 * and brings a fresh batch of every one of them to every market — so putting
 * the morning's counts in meant two dozen trips through a dialog, and the
 * honest outcome of asking somebody to do that is that they stop doing it. One
 * vendor's whole catalogue sat at zero for weeks for exactly this reason: her
 * items were entered with the count box left empty, and nothing about fixing
 * two dozen of them afterwards was worth her time.
 *
 * So: one screen, one number per item, one save. Both the vendor's portal and
 * the market office post to the same function, because a count is a count and
 * there is no version of this where the two should drift apart.
 *
 * THE COUNT IS A TOTAL, NOT A DELTA. "What's on the floor right now" is the
 * question a person answers when they look at a shelf, and answering it with
 * a number that then gets added to something else is how counts go wrong. The
 * Restock button is still the way to say "I brought six more" — this is the
 * way to say "there are six".
 */

export type CountEntry = { id: string; quantity: number };

export type CountOutcome = {
  id: string;
  sku: string;
  name: string;
  from: number;
  to: number;
};

export type CountResult = {
  changed: CountOutcome[];
  /** Sent, valid, and already that number. Not an error, and not a write. */
  unchanged: number;
  /** Sent but refused, with the reason — a bad number, or not theirs. */
  rejected: { id: string; reason: string }[];
};

/** Read a posted body into entries, keeping only what could be a count. */
export function parseEntries(raw: unknown): CountEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CountEntry[] = [];
  for (const row of raw.slice(0, 500)) {
    if (!row || typeof row !== "object") continue;
    const id = String((row as { id?: unknown }).id || "").trim();
    if (!id) continue;
    /* A blank box means "leave this one alone" and never zero — the same rule
       the single-item save had to learn the hard way. The screen simply does
       not send those, and anything that arrives blank anyway is dropped here
       rather than rounded to nothing. */
    const rawQty = (row as { quantity?: unknown }).quantity;
    if (rawQty === undefined || rawQty === null || String(rawQty).trim() === "") continue;
    out.push({ id, quantity: Math.round(Number(rawQty)) });
  }
  return out;
}

/**
 * Write the counts.
 *
 * `vendorId` scopes it: a vendor may only ever set counts on their own items,
 * and passing null means the market office, which may set anybody's. Items
 * that don't belong to the caller are reported back rather than silently
 * skipped, because a count that didn't happen needs to be visible.
 *
 * Only genuine changes are written. Saving a screen where two numbers moved
 * should touch two rows, not two dozen — that keeps the audit trail readable
 * and means an accidental save of an untouched screen does nothing at all.
 */
export async function setFloorCounts(vendorId: string | null, entries: CountEntry[]): Promise<CountResult> {
  const result: CountResult = { changed: [], unchanged: 0, rejected: [] };
  if (entries.length === 0) return result;

  const items = await db.item.findMany({
    where: { id: { in: entries.map((e) => e.id) } },
    select: { id: true, sku: true, name: true, quantity: true, vendorId: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  for (const e of entries) {
    const item = byId.get(e.id);
    if (!item) {
      result.rejected.push({ id: e.id, reason: "That item no longer exists." });
      continue;
    }
    if (vendorId && item.vendorId !== vendorId) {
      result.rejected.push({ id: e.id, reason: "That item belongs to another vendor." });
      continue;
    }
    if (!Number.isFinite(e.quantity) || e.quantity < 0) {
      result.rejected.push({ id: e.id, reason: `${item.name}: a count can't be less than zero.` });
      continue;
    }
    if (e.quantity > 99999) {
      result.rejected.push({ id: e.id, reason: `${item.name}: that count looks like a slip — 99,999 is the most.` });
      continue;
    }
    if (e.quantity === item.quantity) {
      result.unchanged++;
      continue;
    }
    await db.item.update({ where: { id: item.id }, data: { quantity: e.quantity } });
    result.changed.push({ id: item.id, sku: item.sku, name: item.name, from: item.quantity, to: e.quantity });
  }

  return result;
}

/** "3 counts updated", or what went wrong — one line, for a toast or a note. */
export function countSummary(r: CountResult): string {
  const bits: string[] = [];
  if (r.changed.length) bits.push(`${r.changed.length} ${r.changed.length === 1 ? "count" : "counts"} updated`);
  if (r.unchanged) bits.push(`${r.unchanged} already right`);
  if (r.rejected.length) bits.push(`${r.rejected.length} couldn't be saved`);
  return bits.join(" · ") || "Nothing to change.";
}

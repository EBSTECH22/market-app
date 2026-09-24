import { db } from "@/lib/db";
import { recordSystemAudit } from "@/lib/audit";

/**
 * Spaces promised to people by hand.
 *
 * A hold is the software version of "I'll keep a 5×5 for you until Friday".
 * It takes one off what the apply page is offering — because it isn't
 * available, it's spoken for — and it either gets taken up, let go, or runs
 * out. Nothing else in the app has to know about holds: they work by moving
 * the same count everything else already reads.
 *
 * Expiry is lazy. Rather than a nightly job that can fail quietly, any page
 * that reads the counts sweeps first, so a hold that ran out at midnight is
 * gone by the time anybody looks. The sweep is idempotent — a hold releases
 * once, and the count moves once.
 */

/** Put expired holds back on the market. Returns how many were swept. */
export async function expireHolds(now = new Date()): Promise<number> {
  const due = await db.spaceHold.findMany({
    where: { releasedAt: null, holdUntil: { not: null, lte: now } },
    select: { id: true, spaceKey: true, heldFor: true, holdUntil: true },
  });
  if (due.length === 0) return 0;

  for (const h of due) {
    /* Released FIRST. If the count update fails, a hold that has run out is
       still released — the opposite order could leave a space held forever by
       a promise that expired last month. */
    await db.spaceHold.update({
      where: { id: h.id },
      data: { releasedAt: now, releasedWhy: "Hold ran out" },
    });
    await giveBack(h.spaceKey);
    await recordSystemAudit({
      action: "SETTING_CHANGE",
      targetType: "SPACE_HOLD",
      targetId: h.id,
      targetLabel: h.heldFor,
      detail: `Hold for ${h.heldFor} ran out — the space is back on the apply page.`,
    });
  }
  return due.length;
}

/** One back onto the offer, unless it has no limit. */
async function giveBack(spaceKey: string): Promise<void> {
  const offer = await db.spaceOffer.findUnique({ where: { key: spaceKey } });
  if (!offer || offer.available < 0) return;
  await db.spaceOffer.update({ where: { id: offer.id }, data: { available: offer.available + 1 } });
}

/** One off the offer. Returns what's left, or null when the offer has no limit. */
export async function takeOne(spaceKey: string): Promise<number | null> {
  const offer = await db.spaceOffer.findUnique({ where: { key: spaceKey } });
  if (!offer || offer.available < 0) return null;
  const left = Math.max(0, offer.available - 1);
  await db.spaceOffer.update({ where: { id: offer.id }, data: { available: left } });
  return left;
}

export async function releaseHold(id: string, why: string): Promise<boolean> {
  const hold = await db.spaceHold.findUnique({ where: { id } });
  if (!hold || hold.releasedAt) return false;
  await db.spaceHold.update({
    where: { id },
    data: { releasedAt: new Date(), releasedWhy: why.slice(0, 200) },
  });
  /* A hold that was TAKEN UP doesn't give the space back — the vendor has it.
     Any other ending does. */
  if (!/taken up/i.test(why)) await giveBack(hold.spaceKey);
  return true;
}

/**
 * Holds still standing, newest first, with the offer's name attached.
 *
 * Sweeps expired ones first so the list can never show a hold that ran out
 * this morning as though it were live.
 */
export async function activeHolds() {
  await expireHolds();
  const holds = await db.spaceHold.findMany({
    where: { releasedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (holds.length === 0) return [];
  const offers = await db.spaceOffer.findMany({
    where: { key: { in: [...new Set(holds.map((h) => h.spaceKey))] } },
    select: { key: true, name: true },
  });
  const names = new Map<string, string>(offers.map((o) => [o.key, o.name] as [string, string]));
  return holds.map((h) => ({ ...h, spaceName: names.get(h.spaceKey) || h.spaceKey }));
}

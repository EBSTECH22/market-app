import { db } from "@/lib/db";
import { recordSystemAudit } from "@/lib/audit";

/**
 * A booth whose hold has been let go, and what that does to the invoice.
 *
 * THE RULE, in the market's words: they signed, they didn't pay, so we stop
 * holding their booth and offer it to the waiting list. They can still pay
 * while one of that kind of space is left — paying takes one back. Once the
 * last one is let to somebody else, there is nothing to sell them, and the
 * invoice has to stop taking money rather than charging for a space that is
 * gone.
 *
 * That last part is the whole reason this file exists. A payment link that
 * takes $150 for a booth someone else is standing in is worse than a link that
 * refuses.
 */

export type PayBlock = { blocked: true; reason: string } | { blocked: false };

/** Is this agreement's space released AND its kind sold out? */
export async function payBlockFor(contract: {
  spaceKey: string;
  spaceReleasedAt: Date | null;
  boothLabel: string;
}): Promise<PayBlock> {
  if (!contract.spaceReleasedAt) return { blocked: false };
  if (!contract.spaceKey) return { blocked: false };

  const offer = await db.spaceOffer.findUnique({ where: { key: contract.spaceKey } });
  /* No offer row, or an unlimited one (shelf space), can never be "full", so
     there is nothing to block. */
  if (!offer || offer.available < 0) return { blocked: false };
  if (offer.available > 0) return { blocked: false };

  return {
    blocked: true,
    reason:
      `Booth ${contract.boothLabel} was released when this invoice went unpaid, and the last ` +
      `${offer.name.toLowerCase()} has now been let. There's nothing to pay for — please contact the market.`,
  };
}

/**
 * They paid while a space was still going, so they get one back.
 *
 * Takes one off what the apply page is offering (it has just been re-taken)
 * and lifts the release. Never pushes an offer below zero, and never touches
 * an unlimited one, where the count is not a count.
 */
export async function reholdOnPayment(vendorId: string): Promise<number> {
  if (!vendorId) return 0;

  const released = await db.contract.findMany({
    where: { vendorId, spaceReleasedAt: { not: null } },
    select: { id: true, boothLabel: true, spaceKey: true },
  });
  if (released.length === 0) return 0;

  /* The same figure the invoice shows — the whole account, not rent alone. */
  const balance = await db.ledgerEntry.aggregate({ where: { vendorId }, _sum: { amountCents: true } });
  if (Math.max(0, -(balance._sum.amountCents || 0)) > 0) return 0;

  for (const c of released) {
    if (c.spaceKey) {
      const offer = await db.spaceOffer.findUnique({ where: { key: c.spaceKey } });
      if (offer && offer.available > 0) {
        await db.spaceOffer.update({ where: { id: offer.id }, data: { available: offer.available - 1 } });
      }
    }
    await db.contract.update({ where: { id: c.id }, data: { spaceReleasedAt: null } });
    await recordSystemAudit({
      action: "SPACE_REHELD",
      targetType: "CONTRACT",
      targetId: c.id,
      targetLabel: `Booth ${c.boothLabel}`,
      detail: `Paid in full — booth ${c.boothLabel} is held again and taken back off the available list.`,
    });
  }
  return released.length;
}


/**
 * Somebody has been given one of these spaces, so take it off the count.
 *
 * Once per application, ever — accepting, then raising their agreement, then
 * accepting again after a re-open would otherwise take three booths off a
 * market that only let one. The stamp on the application is what makes it
 * once, not the caller remembering.
 *
 * Unlimited offers (shelf space) have no count to take from, and a count never
 * goes below zero: the apply page saying "-1 available" would be worse than
 * saying nothing.
 */
export async function claimSpaceForApplication(applicationId: string): Promise<{ claimed: boolean; offerName: string; left: number | null }> {
  const app = await db.vendorApplication.findUnique({
    where: { id: applicationId },
    select: { id: true, spaceKey: true, spaceClaimedAt: true },
  });
  if (!app || !app.spaceKey || app.spaceClaimedAt) return { claimed: false, offerName: "", left: null };

  const offer = await db.spaceOffer.findUnique({ where: { key: app.spaceKey } });
  if (!offer) return { claimed: false, offerName: "", left: null };

  /* Stamped even for an unlimited offer: they HAVE been given a space, and a
     later change from "no limit" to a real count mustn't reopen the question. */
  await db.vendorApplication.update({ where: { id: app.id }, data: { spaceClaimedAt: new Date() } });

  if (offer.available < 0) return { claimed: true, offerName: offer.name, left: null };

  const left = Math.max(0, offer.available - 1);
  await db.spaceOffer.update({ where: { id: offer.id }, data: { available: left } });

  await recordSystemAudit({
    action: "SETTING_CHANGE",
    targetType: "SPACE_OFFER",
    targetId: offer.id,
    targetLabel: offer.name,
    detail: `${offer.name}: one taken — ${left} left on the apply page.`,
    before: { available: offer.available },
    after: { available: left },
  });

  return { claimed: true, offerName: offer.name, left };
}

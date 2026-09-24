import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";
import { sendSpaceReleasedEmail, noticeSigner } from "@/lib/email";
import { firstName } from "@/lib/nonpayment";

export const dynamic = "force-dynamic";

/**
 * Open a signed-but-unpaid vendor's booth back up — or put the hold back on.
 *
 * POST { contractId, offerKey? }  — release it
 * POST { contractId, rehold: true } — hold it for them again
 *
 * WHAT THIS IS NOT: ending the agreement. The agreement stands, the balance is
 * still owed, and the vendor can still pay. What changes is that the space
 * stops being held for them: it goes back to Available on the site map, it can
 * be added back to what the apply page is offering, and the vendor is told
 * plainly that somebody else can take it until they pay. Ending an agreement
 * is a separate, heavier decision and has its own action.
 */
export async function POST(req: NextRequest) {
  return runRoute("admin/release-space POST", async () => {
    { const denied = await denyUnless("collections"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));

    const contractId = String(body.contractId || "");
    const contract = await db.contract.findUnique({
      where: { id: contractId },
      include: { vendor: { select: { id: true, businessName: true, contactName: true, email: true } } },
    });
    if (!contract) return NextResponse.json({ error: "That agreement is gone." }, { status: 404 });

    /* Which kind of space this is. Agreements written before the offers
       existed carry none, so the office names it at the moment it matters —
       and it sticks, because the invoice needs it later to know whether there
       is still a space to sell them. */
    const offerKeyIn = String(body.offerKey || "").trim().toUpperCase();
    const spaceKey = offerKeyIn || contract.spaceKey;

    /* ------------------------------------------------------------ re-hold */
    if (body.rehold) {
      if (!contract.spaceReleasedAt) {
        return NextResponse.json({ error: "That space isn't released." }, { status: 400 });
      }
      if (spaceKey) {
        /* Taking it back off the market. Never below zero, and never touching
           an unlimited offer, where -1 means "no limit" rather than a count. */
        const offer = await db.spaceOffer.findUnique({ where: { key: spaceKey } });
        if (offer && offer.available > 0) {
          await db.spaceOffer.update({ where: { id: offer.id }, data: { available: offer.available - 1 } });
        }
      }
      await db.contract.update({ where: { id: contract.id }, data: { spaceReleasedAt: null } });
      await recordAudit(
        {
          action: "SPACE_REHELD",
          targetType: "CONTRACT",
          targetId: contract.id,
          targetLabel: `${contract.vendor.businessName} · booth ${contract.boothLabel}`,
          detail: `Booth ${contract.boothLabel} is being held for ${contract.vendor.businessName} again.`,
        },
        req
      );
      return NextResponse.json({ ok: true, released: false });
    }

    /* ------------------------------------------------------------ release */
    const balance = await db.ledgerEntry.aggregate({
      where: { vendorId: contract.vendorId },
      _sum: { amountCents: true },
    });
    const owed = Math.max(0, -(balance._sum.amountCents || 0));
    if (owed === 0) {
      return NextResponse.json(
        { error: "They don't owe anything — nothing to release the space over." },
        { status: 400 }
      );
    }

    if (!spaceKey) {
      return NextResponse.json(
        { error: "Say which kind of space this is first — the invoice needs it to know when it's gone.", needsSpace: true },
        { status: 400 }
      );
    }
    const offer = await db.spaceOffer.findUnique({ where: { key: spaceKey } });
    if (!offer) return NextResponse.json({ error: "That kind of space isn't set up." }, { status: 400 });

    /* Offered to the waiting list: one goes back on what the apply page has.
       An unlimited offer has no count to add to. */
    if (offer.available >= 0) {
      await db.spaceOffer.update({ where: { id: offer.id }, data: { available: offer.available + 1 } });
    }

    /* If they were placed on the site map, that booth goes back to Available
       too. Most of these aren't placed yet, in which case this does nothing. */
    const freed = await db.floorSpace.updateMany({
      where: { contractId: contract.id },
      data: { status: "AVAILABLE", vendorId: "", contractId: "" },
    });

    await db.contract.update({
      where: { id: contract.id },
      data: { spaceReleasedAt: new Date(), spaceKey },
    });

    let emailed = false;
    if (contract.vendor.email && contract.signToken) {
      emailed = await sendSpaceReleasedEmail({
        to: contract.vendor.email,
        greetName: firstName(contract.vendor.contactName, contract.vendor.businessName),
        booth: contract.boothLabel,
        spaceName: offer.name,
        amountCents: owed,
        token: contract.signToken,
        signer: noticeSigner(),
      });
    }

    await recordAudit(
      {
        action: "SPACE_RELEASED",
        targetType: "CONTRACT",
        targetId: contract.id,
        targetLabel: `${contract.vendor.businessName} · booth ${contract.boothLabel}`,
        detail:
          `Hold released on ${contract.boothLabel} over $${(owed / 100).toFixed(2)} unpaid — offered to the ${offer.name} waiting list` +
          `${freed.count ? ", freed on the site map" : ""}${emailed ? ", vendor emailed" : ", vendor NOT emailed"}.`,
        after: { owedCents: owed, freedSpaces: freed.count, spaceKey, emailed },
      },
      req
    );

    return NextResponse.json({
      ok: true,
      released: true,
      owedCents: owed,
      freedSpaces: freed.count,
      offerName: offer.name,
      spaceLeft: offer.available < 0 ? null : offer.available + 1,
      emailed,
    });
  });
}

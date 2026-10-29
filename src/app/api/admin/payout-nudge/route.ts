import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { denyUnless } from "@/lib/perm";
import { runRoute } from "@/lib/handler";
import { recordAudit } from "@/lib/audit";
import { sendPayoutSetupEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

/**
 * "Please connect your bank."
 *
 * POST { vendorId }  → ask one vendor
 * POST { all: true } → ask everyone who still hasn't
 *
 * WHY THERE IS NO LINK IN THE EMAIL: Stripe's onboarding links are single-use,
 * expire within minutes, and are minted against the vendor's own logged-in
 * session. One generated here and posted into an email would be dead before
 * anybody opened it — and it would be a link that drops its holder into
 * somebody else's bank setup. The email points at their portal, where the
 * button mints a fresh one for whoever is actually signed in.
 *
 * "financials" rather than "market": this is chasing money owed out.
 */
export async function POST(req: NextRequest) {
  return runRoute("admin/payout-nudge POST", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }

    const body = await req.json().catch(() => ({}));
    const all = body.all === true;
    const vendorId = String(body.vendorId || "").trim();
    if (!all && !vendorId) return NextResponse.json({ error: "Which vendor?" }, { status: 400 });

    const vendors = await db.vendor.findMany({
      where: all ? { active: true, payoutsEnabled: false } : { id: vendorId },
      select: { id: true, code: true, businessName: true, email: true, payoutsEnabled: true, stripeAccountId: true },
    });
    if (vendors.length === 0) {
      return NextResponse.json(
        { error: all ? "Everybody's bank details are already in." : "Vendor not found." },
        { status: 400 }
      );
    }

    /* Asking a vendor who is already connected is a mistake, not a choice — it
       reads to them as "we can't pay you" when the market can. */
    const already = vendors.filter((v) => v.payoutsEnabled);
    const targets = vendors.filter((v) => !v.payoutsEnabled);
    if (targets.length === 0) {
      return NextResponse.json({ error: "They're already set up for direct deposit." }, { status: 400 });
    }

    /* What each one is owed, so the email can say so. One query for the lot. */
    const balances = await db.ledgerEntry.groupBy({
      by: ["vendorId"],
      where: { vendorId: { in: targets.map((v) => v.id) } },
      _sum: { amountCents: true },
    });
    const owedOf = new Map(balances.map((b) => [b.vendorId, Math.max(0, b._sum.amountCents || 0)]));

    const sent: string[] = [];
    const failed: string[] = [];
    for (const v of targets) {
      if (!v.email) { failed.push(v.code || v.businessName); continue; }
      try {
        await sendPayoutSetupEmail(
          v.email,
          v.businessName,
          owedOf.get(v.id) || 0,
          /* They have a Stripe account but it isn't live yet, so the email says
             "finish it" rather than "start it" — telling somebody to begin
             something they are halfway through is how a nudge gets ignored. */
          !!v.stripeAccountId
        );
        sent.push(v.id);
      } catch {
        failed.push(v.code || v.businessName);
      }
    }

    /* Stamped only on the ones that actually went. A chase list that says
       "asked" about an email that bounced is worse than one saying nothing. */
    if (sent.length > 0) {
      await db.vendor.updateMany({ where: { id: { in: sent } }, data: { payoutNudgeAt: new Date() } });
      await recordAudit(
        {
          action: "VENDOR_EDIT",
          targetType: "VENDOR",
          targetId: all ? "ALL" : sent[0],
          targetLabel: all ? `${sent.length} vendors` : targets[0].businessName,
          detail: `Asked ${sent.length} ${sent.length === 1 ? "vendor" : "vendors"} to set up direct deposit${failed.length ? ` — ${failed.length} couldn't be emailed` : ""}`,
        },
        req
      );
    }

    return NextResponse.json({ sent: sent.length, failed, skipped: already.length, at: new Date().toISOString() });
  });
}

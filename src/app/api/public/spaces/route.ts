import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { waitlisted, spotsLeft, availabilityLabel, termsLabel } from "@/lib/spaces";
import { expireHolds } from "@/lib/spaceholds";

export const dynamic = "force-dynamic";

/**
 * What's available to apply for, for the public application page.
 *
 * Counts and prices come from the same rows the office edits, so the page can
 * never quote a price that isn't the price, or offer a booth that's gone.
 * Nothing private is here — it's the same thing a sign on the door would say.
 */
export async function GET() {
  return runRoute("public/spaces GET", async () => {
    /* Put back anything whose hold ran out, before anyone is told what's
       available — a promise that expired at midnight shouldn't keep a booth
       off the page all day. */
    await expireHolds();

    const offers = await db.spaceOffer.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });

    return NextResponse.json({
      offers: offers.map((o) => ({
        key: o.key,
        name: o.name,
        blurb: o.blurb,
        priceCents: o.priceCents,
        priceMaxCents: o.priceMaxCents,
        commissionPercent: o.commissionPercent,
        /* The number, for "3 left"; null when there's no limit. */
        left: spotsLeft(o),
        waitlist: waitlisted(o),
        availability: availabilityLabel(o),
        terms: termsLabel(o),
      })),
    });
  });
}

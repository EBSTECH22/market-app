import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { PUBLIC_VENDOR_WHERE } from "@/lib/vendor";
import { testPriceChange, verdictLine, type Sale, type PriceChange } from "@/lib/pricetest";

export const dynamic = "force-dynamic";

/**
 * Two things a vendor genuinely cannot work out alone.
 *
 * 1. How their prices and pace compare with other people selling the same kind
 *    of thing in this building. No single-vendor tool can offer this — it's the
 *    one advantage a market has over Shopify.
 * 2. Whether the discounts they ran actually made them money.
 *
 * PRIVACY, and it is the whole design constraint: nothing here ever identifies
 * another vendor. Only medians, only across a minimum number of DIFFERENT
 * vendors, and never a count small enough to work backwards from. A category
 * with two vendors in it is two vendors looking straight at each other, so it
 * simply isn't shown. Getting this wrong turns a useful feature into a reason
 * vendors distrust the market, which is not a trade worth making.
 */

/** Below this many other vendors in a category, show nothing. */
const MIN_OTHER_VENDORS = 2;
/** How far back "pace" is measured. */
const WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

const median = (ns: number[]): number => {
  if (ns.length === 0) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export async function GET() {
  return runRoute("vendor/benchmarks GET", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

    const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS);

    /* ------------------------------------------------ price experiments -- */

    const changes = await db.priceEvent.findMany({
      where: { vendorId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const experimentItemIds = [...new Set(changes.map((c) => c.itemId))];
    const expItems = experimentItemIds.length
      ? await db.item.findMany({ where: { id: { in: experimentItemIds } }, select: { id: true, name: true } })
      : [];
    /* Explicit generics: `new Map(arr.map(...))` infers the value as `{}`,
       which typechecks at the call site and then fails the production build on
       the first property access. This has bitten this codebase before. */
    const nameOf = new Map<string, string>(
      expItems.map((i) => [i.id, i.name] as [string, string])
    );

    const expLines = experimentItemIds.length
      ? await db.saleLine.findMany({
          where: { itemId: { in: experimentItemIds }, vendorId, sale: { status: { not: "VOIDED" } } },
          select: { itemId: true, quantity: true, priceCents: true, sale: { select: { createdAt: true } } },
        })
      : [];

    const salesByItem = new Map<string, Sale[]>();
    for (const l of expLines) {
      if (!l.sale) continue;
      const arr = salesByItem.get(l.itemId) ?? [];
      arr.push({ at: l.sale.createdAt, units: l.quantity, revenueCents: l.priceCents * l.quantity });
      salesByItem.set(l.itemId, arr);
    }

    /* Only the most recent change per item. Two changes a week apart make each
       other's "before" and "after" meaningless, and reporting both would be
       two contradictory verdicts on the same item. */
    const seen = new Set<string>();
    const experiments = [];
    for (const c of changes) {
      if (seen.has(c.itemId)) continue;
      seen.add(c.itemId);
      const change: PriceChange = {
        itemId: c.itemId, at: c.createdAt,
        oldPriceCents: c.oldPriceCents, newPriceCents: c.newPriceCents,
        oldSalePercent: c.oldSalePercent, newSalePercent: c.newSalePercent,
      };
      const t = testPriceChange(change, salesByItem.get(c.itemId) ?? []);
      const name = nameOf.get(c.itemId) || "An item";
      experiments.push({ ...t, itemName: name, line: verdictLine(t, name) });
    }

    /* ------------------------------------------------------- benchmarks -- */

    const mine = await db.item.findMany({
      where: { vendorId, active: true, category: { not: "" } },
      select: { id: true, category: true, priceCents: true },
    });

    const myCategories = [...new Set(mine.map((i) => i.category))];
    if (myCategories.length === 0) {
      return NextResponse.json({ experiments, benchmarks: [], categorised: false });
    }

    /* Everyone's items in those categories — but only vendors whose goods are
       actually on the public floor. An onboarding vendor's draft prices aren't
       a market rate. */
    const peers = await db.item.findMany({
      where: { category: { in: myCategories }, active: true, vendor: PUBLIC_VENDOR_WHERE },
      select: { id: true, vendorId: true, category: true, priceCents: true },
    });

    const peerIds = peers.map((p) => p.id);
    const peerLines = peerIds.length
      ? await db.saleLine.findMany({
          where: { itemId: { in: peerIds }, sale: { status: { not: "VOIDED" }, createdAt: { gte: since } } },
          select: { itemId: true, quantity: true },
        })
      : [];
    const unitsByItem = new Map<string, number>();
    for (const l of peerLines) unitsByItem.set(l.itemId, (unitsByItem.get(l.itemId) || 0) + l.quantity);

    const weeks = WINDOW_DAYS / 7;
    const benchmarks = myCategories
      .map((category) => {
        const inCat = peers.filter((p) => p.category === category);
        const otherVendors = new Set(inCat.filter((p) => p.vendorId !== vendorId).map((p) => p.vendorId));
        if (otherVendors.size < MIN_OTHER_VENDORS) {
          return { category, enough: false, otherVendorCount: otherVendors.size };
        }

        const others = inCat.filter((p) => p.vendorId !== vendorId);
        const ours = inCat.filter((p) => p.vendorId === vendorId);
        const rate = (i: { id: string }) => Math.round(((unitsByItem.get(i.id) || 0) / weeks) * 100) / 100;

        return {
          category,
          enough: true,
          /* Rounded to a band, never exact. "4 other vendors" in a category
             with five is close enough to naming them. */
          otherVendorCount: otherVendors.size >= 5 ? 5 : otherVendors.size,
          otherVendorLabel: otherVendors.size >= 5 ? "5 or more other vendors" : `${otherVendors.size} other vendors`,
          marketMedianPriceCents: median(others.map((o) => o.priceCents)),
          myMedianPriceCents: median(ours.map((o) => o.priceCents)),
          marketMedianUnitsPerWeek: median(others.map(rate)),
          myMedianUnitsPerWeek: median(ours.map(rate)),
          myItemCount: ours.length,
        };
      })
      .filter((b) => b.enough);

    return NextResponse.json({ experiments, benchmarks, categorised: true, windowDays: WINDOW_DAYS });
  });
}

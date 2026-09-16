import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { TZ } from "@/lib/time";
import {
  statFor, summarize, runningOut, deadStock, bestSellers, busiestWindow, windowLabel,
  type ItemStat, type DayHourPoint,
} from "@/lib/vendorstats";

export const dynamic = "force-dynamic";

/**
 * What a vendor's own numbers actually say.
 *
 * The portal already shows them what sold. This is the part they can't work out
 * for themselves: which items are worth making more of, which are occupying a
 * shelf for nothing, and what's about to run out while they're not in the
 * building. A vendor standing at their own booth can see an empty shelf; one
 * who drops stock off on a Tuesday cannot.
 *
 * Voided sales are excluded throughout. A refunded item that still counted as
 * "sold" would tell someone to make more of something that came back.
 */
export async function GET() {
  return runRoute("vendor/stats GET", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

    const items = await db.item.findMany({
      where: { vendorId, active: true },
      select: { id: true, sku: true, name: true, priceCents: true, quantity: true, createdAt: true },
    });

    if (items.length === 0) {
      return NextResponse.json({
        items: [], summary: summarize([]), runningOut: [], deadStock: [], bestSellers: [],
        busiest: null, busiestLabel: null,
      });
    }

    /* Lines joined to their sale so voided tickets can be excluded, and so the
       timestamp is the sale's rather than the line's. */
    const lines = await db.saleLine.findMany({
      where: { vendorId, sale: { status: { not: "VOIDED" } } },
      select: {
        id: true, saleId: true, itemId: true, quantity: true, priceCents: true,
        sale: { select: { createdAt: true } },
      },
    });

    /* Refunded units come off the counts. A partial refund doesn't void the
       ticket, so without this a thing bought and returned three times reads as
       a bestseller and they go and make more of it.
       Scoped to this vendor's own sales rather than every refund in the
       market. */
    const saleIds = [...new Set(lines.map((l) => l.saleId))];
    const refunds = saleIds.length
      ? await db.refund.findMany({
          where: { saleId: { in: saleIds }, note: { not: { startsWith: "VOID" } } },
          select: { linesJson: true },
        })
      : [];
    const refundedByLine = new Map<string, number>();
    for (const r of refunds) {
      try {
        for (const pl of JSON.parse(r.linesJson || "[]") as { lineId: string; quantity: number }[]) {
          refundedByLine.set(pl.lineId, (refundedByLine.get(pl.lineId) || 0) + pl.quantity);
        }
      } catch { /* a malformed refund record shouldn't break someone's dashboard */ }
    }

    type Agg = { units: number; revenue: number; last: Date | null };
    const byItem = new Map<string, Agg>();
    const dayHour = new Map<string, DayHourPoint>();

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, weekday: "short", hour: "numeric", hour12: false,
    });
    const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

    for (const l of lines) {
      const when = l.sale?.createdAt ?? null;
      // Net of anything that came back on this exact line.
      const units = Math.max(0, l.quantity - (refundedByLine.get(l.id) || 0));
      if (units === 0) continue;
      const revenue = l.priceCents * units;

      const agg = byItem.get(l.itemId) ?? { units: 0, revenue: 0, last: null };
      agg.units += units;
      agg.revenue += revenue;
      if (when && (!agg.last || when > agg.last)) agg.last = when;
      byItem.set(l.itemId, agg);

      if (when) {
        /* Central time, not the server's. A sale at 11pm UTC is a 6pm sale to
           somebody standing in Noble, and telling them their best hour is 11pm
           would be worse than saying nothing. */
        const bits = parts.formatToParts(when);
        const wd = WEEKDAY_INDEX[bits.find((b) => b.type === "weekday")?.value || ""] ?? 0;
        const hr = Number(bits.find((b) => b.type === "hour")?.value ?? 0) % 24;
        const key = `${wd}-${hr}`;
        const point = dayHour.get(key) ?? { weekday: wd, hour: hr, units: 0, revenueCents: 0 };
        point.units += units;
        point.revenueCents += revenue;
        dayHour.set(key, point);
      }
    }

    const now = new Date();
    const stats: ItemStat[] = items.map((i) => {
      const agg = byItem.get(i.id) ?? { units: 0, revenue: 0, last: null };
      return statFor(
        {
          itemId: i.id, sku: i.sku, name: i.name,
          priceCents: i.priceCents, quantity: i.quantity, createdAt: i.createdAt,
          unitsSold: agg.units, revenueCents: agg.revenue, lastSoldAt: agg.last,
        },
        now
      );
    });

    const busiest = busiestWindow([...dayHour.values()]);

    return NextResponse.json({
      items: stats.sort((a, b) => b.revenueCents - a.revenueCents),
      summary: summarize(stats),
      runningOut: runningOut(stats),
      deadStock: deadStock(stats),
      bestSellers: bestSellers(stats),
      busiest,
      busiestLabel: busiest ? windowLabel(busiest) : null,
    });
  });
}

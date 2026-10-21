import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { effectivePriceCents } from "@/lib/pricing";
import { cashCents } from "@/lib/cardprice";
import { getMarketFeePercent } from "@/lib/settings";
import { marketFeeFor } from "@/lib/marketfee";
import { denyUnless } from "@/lib/perm";
import { validateSelection, resolveSelection, unitVendorCents, type Selection } from "@/lib/itemoptions";
import { groupsForItem } from "@/lib/optiongroups";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  { const denied = await denyUnless("ops"); if (denied) return denied; }
  const sku = req.nextUrl.searchParams.get("sku")?.trim().toUpperCase();
  if (!sku) return NextResponse.json({ error: "No code." }, { status: 400 });

  const item = await db.item.findUnique({
    where: { sku },
    include: {
      vendor: { select: { businessName: true, code: true, active: true, marketFeePercent: true } },
      /* So the till can ask the questions before the line goes on the ticket. */
      
    },
  });
  if (!item || !item.active) return NextResponse.json({ error: `No item found for ${sku}.` }, { status: 404 });
  if (!item.vendor.active) {
    return NextResponse.json({ error: `${item.vendor.businessName} is deactivated — their items can't be sold. Pull it from the floor.` }, { status: 400 });
  }
  /* The customer's cash price: vendor's price + the market service fee. */
  const fee = marketFeeFor(item.vendor, await getMarketFeePercent());
  const unit = cashCents(effectivePriceCents(item), fee);
  /* Its own questions AND the vendor's menu-wide ones — the till has to ask
     everything the ordering page would. */
  const optionGroups = await groupsForItem(item);
  return NextResponse.json({ item: { ...item, optionGroups, priceCents: unit, taxClass: String(item.taxClass || "STANDARD"), basePriceCents: cashCents(item.priceCents, fee), salePercent: item.salePercent } });
}

/**
 * Price one line with its choices, exactly as the sale will.
 *
 * POST { sku, options } → { priceCents, basePriceCents, optionsText }
 *
 * The till could add the deltas up itself, but it would have to know the
 * vendor's fee and repeat the rounding — and the first time the two disagreed,
 * the screen would promise one price and the drawer would take another. One
 * round trip buys an exact match with the server that books the money.
 */
export async function POST(req: NextRequest) {
  { const denied = await denyUnless("ops"); if (denied) return denied; }

  const body = await req.json().catch(() => ({}));
  const sku = String(body.sku || "").trim().toUpperCase();
  if (!sku) return NextResponse.json({ error: "No code given." }, { status: 400 });

  const item = await db.item.findUnique({
    where: { sku },
    include: {
      vendor: { select: { businessName: true, active: true, marketFeePercent: true } },
      
    },
  });
  if (!item || !item.active) return NextResponse.json({ error: `No item found for ${sku}.` }, { status: 404 });

  const groups = await groupsForItem(item);
  const picked = (body.options || {}) as Selection;
  const problem = groups.length ? validateSelection(groups, picked) : null;
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const resolved = resolveSelection(groups, picked);
  const fee = marketFeeFor(item.vendor, await getMarketFeePercent());
  return NextResponse.json({
    priceCents: cashCents(unitVendorCents(effectivePriceCents(item), resolved.deltaCents), fee),
    basePriceCents: cashCents(unitVendorCents(item.priceCents, resolved.deltaCents), fee),
    optionsText: resolved.text,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { effectivePriceCents } from "@/lib/pricing";
import { tagCents, cashCents } from "@/lib/cardprice";
import { getCardAdjustPercent, getMarketFeePercent } from "@/lib/settings";
import { PUBLIC_VENDOR_WHERE } from "@/lib/vendor";

export const dynamic = "force-dynamic";

/**
 * Everything a vendor's public page needs, in one request.
 *
 * One call rather than several because this page is opened from a phone, in a
 * car park, off a link somebody shared — the cost that matters is round trips,
 * not payload. Photos are ids, not data; the browser fetches those separately
 * and caches them.
 *
 * NOTHING INTERNAL LEAKS. The vendor's own id, email, balance, commission and
 * Stripe ids are all deliberately absent — this response is public, and the one
 * before it shipped the vendor id for no reason.
 */
export async function GET(_req: NextRequest, { params }: { params: { code: string } }) {
  const vendor = await db.vendor.findFirst({
    where: { code: params.code.toUpperCase(), ...PUBLIC_VENDOR_WHERE },
    select: {
      id: true, code: true, businessName: true, publicBlurb: true,
      tagline: true, story: true, instagramUrl: true, facebookUrl: true, websiteUrl: true,
      acceptsPreorders: true, acceptsRequests: true,
    },
  });
  if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });

  const items = await db.item.findMany({
    where: { vendorId: vendor.id, active: true },
    select: {
      id: true, name: true, priceCents: true, salePercent: true, quantity: true,
      description: true, unitLabel: true, featured: true, category: true,
      onlineEnabled: true, onlineQuantity: true, onlinePickup: true, onlineShip: true, shipCents: true,
    },
    /* Featured first, then whatever is actually in stock, then by name. A
       storefront that opens on six sold-out items reads as a closed shop. */
    orderBy: [{ featured: "desc" }, { name: "asc" }],
  });

  const photos = await db.vendorPhoto.findMany({
    where: { vendorId: vendor.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, kind: true, itemId: true },
  });

  const gallery = photos.filter((p) => p.kind === "PRODUCT").map((p) => p.id);
  const logo = photos.find((p) => p.kind === "LOGO")?.id || null;
  const cover = photos.find((p) => p.kind === "COVER")?.id || null;
  const itemPhotos = new Map<string, string[]>();
  for (const p of photos) {
    if (p.kind !== "ITEM" || !p.itemId) continue;
    itemPhotos.set(p.itemId, [...(itemPhotos.get(p.itemId) || []), p.id]);
  }

  const reviews = await db.review.findMany({ where: { vendorId: vendor.id }, orderBy: { createdAt: "desc" }, take: 100 });
  const comments = await db.reviewComment.findMany({
    where: { reviewId: { in: reviews.map((r) => r.id) } },
    orderBy: { createdAt: "asc" },
  });

  const ratingCount = reviews.length;
  const ratingAvg = ratingCount
    ? Math.round((reviews.reduce((n, r) => n + r.rating, 0) / ratingCount) * 10) / 10
    : 0;

  /* Where to find them in the building. Read from their live agreement rather
     than stored on the vendor, so it can't disagree with the booth they're
     actually paying for. */
  const contract = await db.contract.findFirst({
    where: { vendorId: vendor.id, status: { in: ["ACTIVE", "TERMINATING"] } },
    orderBy: { createdAt: "desc" },
    select: { boothLabel: true },
  });

  /* Which of the empty ones have EVER sold. Quantity 0 means two different
     things: "sold through" and "never brought in yet". A vendor who enters
     their range before dropping stock off had every product filed under
     Sold out — and only the first twelve of those shown — so their page looked
     empty. Never-sold empties are "Coming soon" instead. */
  const emptyIds = items.filter((i) => i.quantity <= 0).map((i) => i.id);
  const everSold = emptyIds.length
    ? new Set<string>(
        (await db.saleLine.groupBy({ by: ["itemId"], where: { itemId: { in: emptyIds } } })).map((r) => r.itemId)
      )
    : new Set<string>();

  const pct = await getCardAdjustPercent();
  const fee = await getMarketFeePercent();
  const shaped = items.map((i) => ({
    id: i.id,
    /* Two different things, kept apart on purpose:
         `inStock`  — sitting on the shelf in the building. Display only.
         `online`   — set aside for online orders. The only thing buyable here.
       A product can be one, the other, or both, and they never share a count. */
    online: i.onlineEnabled && i.onlineQuantity > 0,
    onlineQuantity: i.onlineQuantity,
    onlinePickup: i.onlinePickup,
    onlineShip: i.onlineShip,
    shipCents: i.shipCents,
    name: i.name,
    description: i.description,
    unitLabel: i.unitLabel,
    featured: i.featured,
    category: i.category,
    quantity: i.quantity,
    inStock: i.quantity > 0,
    /* The tag price — what the shelf label says and what the online shop charges. */
    priceCents: tagCents(cashCents(effectivePriceCents(i), fee), pct),
    basePriceCents: tagCents(cashCents(i.priceCents, fee), pct),
    salePercent: Math.max(0, Math.min(90, i.salePercent || 0)),
    photoIds: itemPhotos.get(i.id) || [],
  }));

  return NextResponse.json({
    vendor: {
      code: vendor.code,
      businessName: vendor.businessName,
      publicBlurb: vendor.publicBlurb,
      tagline: vendor.tagline,
      story: vendor.story,
      instagramUrl: vendor.instagramUrl,
      facebookUrl: vendor.facebookUrl,
      websiteUrl: vendor.websiteUrl,
      acceptsPreorders: vendor.acceptsPreorders,
      acceptsRequests: vendor.acceptsRequests,
      boothLabel: contract?.boothLabel || "",
    },
    logoId: logo,
    coverId: cover,
    photos: gallery,
    /* What they can buy right now, and what's simply in the booth today. The
       page shows both, clearly labelled, because a shopper deciding whether to
       drive over wants to know what's on the shelf even when they can't order
       it from here. */
    online: shaped.filter((i) => i.online),
    items: shaped.filter((i) => i.inStock),
    soldOut: shaped.filter((i) => !i.inStock && !i.online && everSold.has(i.id)),
    comingSoon: shaped.filter((i) => !i.inStock && !i.online && !everSold.has(i.id)),
    categories: [...new Set(shaped.filter((i) => i.inStock && i.category).map((i) => i.category))].sort(),
    acceptsOnlineOrders: shaped.some((i) => i.online),
    rating: { avg: ratingAvg, count: ratingCount },
    reviews: reviews.map((r) => ({
      ...r,
      comments: comments.filter((c) => c.reviewId === r.id),
    })),
  });
}

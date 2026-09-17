import type { Metadata } from "next";
import { db } from "@/lib/db";
import { PUBLIC_VENDOR_WHERE } from "@/lib/vendor";
import Storefront from "./Storefront";

export const dynamic = "force-dynamic";

/**
 * A vendor's storefront, wrapped in a server component for ONE reason: link
 * previews.
 *
 * The page itself is interactive and stays a client component. But a vendor's
 * page is shared far more often than it is found — pasted into a Facebook
 * group, texted to a friend, put in an Instagram bio — and what those places
 * show comes from tags that only exist if a SERVER rendered them. A client
 * component can't produce them at all, so every booth link previewed as a bare
 * URL with no name, no picture and no description. That is the difference
 * between a link that gets clicked and one that doesn't, and it costs one file.
 */

type Props = { params: { code: string } };

async function vendorFor(code: string) {
  return db.vendor.findFirst({
    where: { code: code.toUpperCase(), ...PUBLIC_VENDOR_WHERE },
    select: { id: true, code: true, businessName: true, publicBlurb: true, tagline: true, story: true },
  });
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const vendor = await vendorFor(params.code);
  if (!vendor) {
    return { title: "Vendor not found — Community Harvest" };
  }

  /* The picture the preview uses, in the order that flatters the booth most:
     their own cover, then their best product shot, then their logo. A logo on
     a white square is a weak preview; a photo of the goods is not. */
  const photo = await db.vendorPhoto.findFirst({
    where: { vendorId: vendor.id, kind: { in: ["COVER", "ITEM", "PRODUCT", "LOGO"] } },
    orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });

  const description =
    vendor.tagline ||
    vendor.publicBlurb ||
    (vendor.story ? vendor.story.slice(0, 180) : "") ||
    `Shop ${vendor.businessName} at Community Harvest — Food and Craft Market in Noble, Oklahoma.`;

  const title = `${vendor.businessName} — Community Harvest`;
  const url = `/v/${vendor.code}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      type: "website",
      siteName: "Community Harvest",
      images: photo ? [{ url: `/api/public/photo/${photo.id}`, alt: vendor.businessName }] : undefined,
    },
    twitter: {
      card: photo ? "summary_large_image" : "summary",
      title,
      description,
      images: photo ? [`/api/public/photo/${photo.id}`] : undefined,
    },
  };
}

export default function VendorPublicPage({ params }: Props) {
  return <Storefront params={params} />;
}

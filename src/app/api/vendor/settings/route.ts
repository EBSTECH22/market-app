import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const body = await req.json();
  const { acceptsPreorders, acceptsRequests, publicBlurb, allowSelfCheckout } = body;
  const data: {
    acceptsPreorders?: boolean; acceptsRequests?: boolean; publicBlurb?: string; allowSelfCheckout?: boolean;
    tagline?: string; story?: string; instagramUrl?: string; facebookUrl?: string; websiteUrl?: string;
    lowStockThreshold?: number;
    discountEnabled?: boolean; discountLabel?: string; discountMode?: string;
    discountPercent?: number; discountCents?: number;
  } = {};

  /* THE VENDOR'S OWN DISCOUNT. Theirs to switch on, theirs to set, and theirs
     to pay for — the customer saves exactly what the vendor gives up. Nothing
     here needs the office's permission because nothing here spends the
     market's money. */
  if (body.discountEnabled !== undefined) data.discountEnabled = !!body.discountEnabled;
  if (body.discountLabel !== undefined) {
    const label = String(body.discountLabel || "").trim().slice(0, 40);
    data.discountLabel = label || "Military / first responder";
  }
  if (body.discountMode !== undefined) {
    data.discountMode = String(body.discountMode).toUpperCase() === "AMOUNT" ? "AMOUNT" : "PERCENT";
  }
  if (body.discountPercent !== undefined) {
    const n = Number(body.discountPercent);
    if (!Number.isFinite(n) || n < 0 || n > 50) {
      return NextResponse.json({ error: "A discount can be 0 to 50%." }, { status: 400 });
    }
    data.discountPercent = n;
  }
  if (body.discountCents !== undefined) {
    const n = Math.round(Number(body.discountCents));
    if (!Number.isFinite(n) || n < 0 || n > 100_00) {
      return NextResponse.json({ error: "A flat discount can be $0 to $100." }, { status: 400 });
    }
    data.discountCents = n;
  }

  /* 0 means "never warn me". Clamped rather than rejected: a vendor typing
     "500" wants the warning off, and arguing with them about it helps nobody. */
  if (body.lowStockThreshold !== undefined) {
    const n = Math.round(Number(body.lowStockThreshold));
    data.lowStockThreshold = Number.isFinite(n) ? Math.max(0, Math.min(99, n)) : 3;
  }
  if (acceptsPreorders !== undefined) data.acceptsPreorders = !!acceptsPreorders;
  if (acceptsRequests !== undefined) data.acceptsRequests = !!acceptsRequests;
  if (allowSelfCheckout !== undefined) data.allowSelfCheckout = !!allowSelfCheckout;
  if (publicBlurb !== undefined) data.publicBlurb = String(publicBlurb).slice(0, 300);
  if (body.tagline !== undefined) data.tagline = String(body.tagline).slice(0, 90);
  if (body.story !== undefined) data.story = String(body.story).slice(0, 2000);

  /* Links are normalised and sanity-checked rather than taken as typed.
     A vendor types "instagram.com/dailybread" or "@dailybread"; both have to
     become something a browser will follow, and NOTHING here may become a
     javascript: URL on a public page. */
  const link = (raw: unknown, host: string): string => {
    let v = String(raw || "").trim();
    if (!v) return "";
    if (v.startsWith("@")) v = `https://${host}/${v.slice(1)}`;
    if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.toString().slice(0, 200);
    } catch {
      return "";
    }
  };
  if (body.instagramUrl !== undefined) data.instagramUrl = link(body.instagramUrl, "instagram.com");
  if (body.facebookUrl !== undefined) data.facebookUrl = link(body.facebookUrl, "facebook.com");
  if (body.websiteUrl !== undefined) data.websiteUrl = link(body.websiteUrl, "");

  const vendor = await db.vendor.update({ where: { id: vendorId }, data });
  return NextResponse.json({
    ok: true,
    vendor: {
      acceptsPreorders: vendor.acceptsPreorders,
      acceptsRequests: vendor.acceptsRequests,
      lowStockThreshold: vendor.lowStockThreshold,
      publicBlurb: vendor.publicBlurb,
      tagline: vendor.tagline,
      story: vendor.story,
      instagramUrl: vendor.instagramUrl,
      facebookUrl: vendor.facebookUrl,
      websiteUrl: vendor.websiteUrl,
    },
  });
}

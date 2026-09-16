import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { effectivePriceCents } from "@/lib/pricing";
import { stripe } from "@/lib/stripe";
import { randomBytes } from "crypto";
import type { CartLine } from "@/lib/selfcheckout";
import { PUBLIC_VENDOR_WHERE } from "@/lib/vendor";

export const dynamic = "force-dynamic";

const sellable = { active: true, quantity: { gt: 0 }, vendor: { ...PUBLIC_VENDOR_WHERE, allowSelfCheckout: true } };

async function selfCheckoutPaused(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: "selfCheckoutPaused" } });
  return row?.value === "1";
}

// GET: everything on the floor that's open to self-checkout + the tax rate
export async function GET() {
  if (await selfCheckoutPaused()) return NextResponse.json({ paused: true, taxRatePercent: 0, items: [] });
  const itemPhotos = await db.vendorPhoto.findMany({ where: { kind: "ITEM" }, select: { id: true, itemId: true } });
  const photoMap = new Map(itemPhotos.map((x) => [x.itemId, x.id]));
  const items = await db.item.findMany({
    where: sellable,
    select: { id: true, sku: true, name: true, priceCents: true, salePercent: true, quantity: true, vendor: { select: { businessName: true } } },
    orderBy: { name: "asc" },
  });
  const setting = await db.setting.findUnique({ where: { key: "taxRatePercent" } });
  return NextResponse.json({
    taxRatePercent: setting ? Number(setting.value) : 0,
    items: items.map((i) => ({ id: i.id, sku: i.sku, name: i.name, priceCents: effectivePriceCents(i), basePriceCents: i.priceCents, salePercent: Math.max(0, Math.min(90, i.salePercent || 0)), quantity: i.quantity, vendorName: i.vendor.businessName, photoId: photoMap.get(i.id) || null })),
  });
}

// POST { action: "lookup", sku } | { action: "checkout", lines: [{sku, qty}], email? }
export async function POST(req: NextRequest) {
  if (await selfCheckoutPaused()) return NextResponse.json({ error: "Self-checkout is paused right now — please pay at the register. 😊" }, { status: 503 });
  const b = await req.json();

  if (b.action === "lookup") {
    const sku = String(b.sku || "").trim().toUpperCase();
    if (!sku) return NextResponse.json({ error: "No code." }, { status: 400 });
    const item = await db.item.findUnique({ where: { sku }, include: { vendor: { select: { businessName: true, active: true, portalLocked: true, allowSelfCheckout: true } } } });
    // portalLocked: the vendor is still onboarding — their goods aren't on the
    // floor yet, so a scanned code shouldn't resolve.
    if (!item || !item.active || !item.vendor.active || item.vendor.portalLocked) {
      return NextResponse.json({ error: `Nothing found for ${sku} — check the code under the barcode.` }, { status: 404 });
    }
    if (!item.vendor.allowSelfCheckout) return NextResponse.json({ error: `${item.vendor.businessName} items go through the register — take this one up front. 😊` }, { status: 400 });
    if (item.quantity <= 0) return NextResponse.json({ error: `${item.name} shows sold out — grab a staff member if you're holding one.` }, { status: 400 });
    return NextResponse.json({ item: { id: item.id, sku: item.sku, name: item.name, priceCents: effectivePriceCents(item), basePriceCents: item.priceCents, salePercent: Math.max(0, Math.min(90, item.salePercent || 0)), quantity: item.quantity, vendorName: item.vendor.businessName } });
  }

  if (b.action === "checkout") {
    if (!stripe) return NextResponse.json({ error: "Card payment isn't available — please pay at the register." }, { status: 500 });
    const reqLines: { sku: string; qty: number }[] = (b.lines || []).slice(0, 40);
    if (reqLines.length === 0) return NextResponse.json({ error: "Your cart is empty." }, { status: 400 });
    const email = String(b.email || "").trim().slice(0, 120);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "That email doesn't look right — fix it or leave it blank." }, { status: 400 });

    const lines: CartLine[] = [];
    for (const rl of reqLines) {
      const sku = String(rl.sku || "").trim().toUpperCase();
      const qty = Math.max(1, Math.min(99, Math.round(Number(rl.qty) || 1)));
      const item = await db.item.findUnique({ where: { sku }, include: { vendor: true } });
      if (!item || !item.active || !item.vendor.active || !item.vendor.allowSelfCheckout) {
        return NextResponse.json({ error: `${sku} isn't available for self-checkout — remove it or pay at the register.` }, { status: 400 });
      }
      if (item.quantity < qty) return NextResponse.json({ error: `Only ${item.quantity} of ${item.name} left in the system — adjust your quantity.` }, { status: 400 });
      lines.push({ itemId: item.id, sku: item.sku, name: item.name, priceCents: effectivePriceCents(item), quantity: qty, vendorId: item.vendorId, vendorName: item.vendor.businessName });
    }

    const setting = await db.setting.findUnique({ where: { key: "taxRatePercent" } });
    const taxRate = setting ? Number(setting.value) : 0;
    const subtotalCents = lines.reduce((n, l) => n + l.priceCents * l.quantity, 0);
    const taxCents = Math.round((subtotalCents * taxRate) / 100);
    const totalCents = subtotalCents + taxCents;

    const token = randomBytes(16).toString("hex");
    const cart = await db.selfCart.create({
      data: { token, linesJson: JSON.stringify(lines), subtotalCents, taxCents, totalCents, email },
    });

    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        ...lines.map((l) => ({
          price_data: { currency: "usd", product_data: { name: `${l.name} — ${l.vendorName}`.slice(0, 120) }, unit_amount: l.priceCents },
          quantity: l.quantity,
        })),
        { price_data: { currency: "usd", product_data: { name: "Sales tax" }, unit_amount: taxCents }, quantity: 1 },
      ],
      metadata: { app: "community-harvest-market", selfCartId: cart.id },
      customer_email: email || undefined,
      success_url: `${base}/shop/paid/${token}`,
      cancel_url: `${base}/shop`,
    });
    await db.selfCart.update({ where: { id: cart.id }, data: { stripeSessionId: session.id } });
    return NextResponse.json({ url: session.url });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

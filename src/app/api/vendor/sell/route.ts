import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { effectivePriceCents } from "@/lib/pricing";
import { runRoute } from "@/lib/handler";
import { randomBytes, randomInt } from "crypto";
import type { CartLine } from "@/lib/selfcheckout";
import { getTaxRates } from "@/lib/settings";
import { taxFor, normalizeTaxClass } from "@/lib/tax";

export const dynamic = "force-dynamic";

/**
 * A vendor ringing up their OWN goods at their OWN booth, from their phone.
 *
 * Two ways to pay, both landing in the same place:
 *  - CARD: a Stripe Checkout session. The vendor's screen shows a QR of it and
 *    the customer scans it with their own phone. Money goes to the market's
 *    Stripe and the vendor is credited price-minus-commission, exactly like
 *    self-checkout. (Tap to Pay isn't an option — Stripe ships it only in
 *    native iOS/Android SDKs, and this is a website.)
 *  - CASH: no money moves here. The customer gets a short code, walks to the
 *    register, and a cashier rings it as cash. The market ends up holding the
 *    cash, which is what keeps the commission honest — a vendor pocketing notes
 *    at their own booth is a debt nobody would ever reconcile.
 *
 * A vendor can only ever ring their OWN items. Not a policy choice so much as
 * an accounting one: another vendor's commission, stock and ledger are not
 * theirs to move.
 */

/** No I/O/1/0 — these get read aloud and copied off a phone screen. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode(): string {
  let out = "";
  for (let i = 0; i < 5; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** A code is only live while it's unrung, so collisions only matter among those. */
async function uniqueCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = makeCode();
    const clash = await db.selfCart.findFirst({ where: { registerCode: code, status: "PENDING" }, select: { id: true } });
    if (!clash) return code;
  }
  // 32^5 is ~33 million; eight collisions means something is very wrong, and a
  // long code nobody can read is better than handing back a duplicate.
  return `${makeCode()}${makeCode()}`;
}

export async function GET(req: NextRequest) {
  return runRoute("vendor/sell GET", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

    /* ?cartId= — has the customer actually paid yet?
       Without this the vendor stares at a QR code with no idea whether to hand
       the goods over, which is the one moment in the whole flow where being
       unsure costs them money. Scoped to their own carts so one vendor can't
       poll another's. */
    const cartId = req.nextUrl.searchParams.get("cartId");
    if (cartId) {
      const cart = await db.selfCart.findFirst({
        where: { id: cartId, soldByVendorId: vendorId },
        select: { status: true, paidAt: true, totalCents: true },
      });
      if (!cart) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
      return NextResponse.json({ paid: cart.status === "PAID", paidAt: cart.paidAt, totalCents: cart.totalCents });
    }

    const vendor = await db.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, businessName: true, code: true, portalLocked: true, active: true },
    });
    if (!vendor || !vendor.active) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    if (vendor.portalLocked) {
      return NextResponse.json({ error: "Your booth isn't open yet — finish signing and paying first." }, { status: 403 });
    }

    const items = await db.item.findMany({
      where: { vendorId, active: true },
      select: { id: true, sku: true, name: true, priceCents: true, salePercent: true, quantity: true, taxClass: true },
      orderBy: { name: "asc" },
    });
    const rates = await getTaxRates();

    return NextResponse.json({
      vendor: { businessName: vendor.businessName, code: vendor.code },
      taxRatePercent: rates.standardPercent,
      foodTaxRatePercent: rates.foodPercent,
      cardReady: !!stripe,
      items: items.map((i) => ({
        id: i.id, sku: i.sku, name: i.name,
        priceCents: effectivePriceCents(i),
        basePriceCents: i.priceCents,
        salePercent: Math.max(0, Math.min(90, i.salePercent || 0)),
        quantity: i.quantity,
        taxClass: normalizeTaxClass(i.taxClass),
      })),
    });
  });
}

// POST { mode: "CARD" | "CASH", lines: [{ itemId, qty }], email? }
export async function POST(req: NextRequest) {
  return runRoute("vendor/sell POST", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

    const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor || !vendor.active) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    if (vendor.portalLocked) {
      return NextResponse.json({ error: "Your booth isn't open yet." }, { status: 403 });
    }

    const body = await req.json();
    const mode = body.mode === "CASH" ? "CASH" : "CARD";
    const reqLines: { itemId: string; qty: number }[] = Array.isArray(body.lines) ? body.lines.slice(0, 40) : [];
    if (reqLines.length === 0) return NextResponse.json({ error: "Nothing on the ticket." }, { status: 400 });

    const email = String(body.email || "").trim().slice(0, 120);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: "That email doesn't look right — fix it or leave it blank." }, { status: 400 });
    }

    const lines: CartLine[] = [];
    for (const rl of reqLines) {
      const qty = Math.max(1, Math.min(99, Math.round(Number(rl.qty) || 1)));
      const item = await db.item.findUnique({ where: { id: String(rl.itemId || "") } });
      if (!item || !item.active) return NextResponse.json({ error: "One of those items is no longer available." }, { status: 400 });
      /* The ownership check. Prices, stock and the ledger entry all key off the
         item's own vendor, so ringing someone else's goods here would move
         their inventory and their money. */
      if (item.vendorId !== vendorId) {
        return NextResponse.json({ error: "You can only ring up your own items." }, { status: 403 });
      }
      if (item.quantity < qty) {
        return NextResponse.json({ error: `Only ${item.quantity} of ${item.name} left in the system.` }, { status: 400 });
      }
      lines.push({
        itemId: item.id, sku: item.sku, name: item.name,
        priceCents: effectivePriceCents(item), quantity: qty,
        vendorId: item.vendorId, vendorName: vendor.businessName,
        taxClass: normalizeTaxClass(item.taxClass),
      });
    }

    const rates = await getTaxRates();
    const subtotalCents = lines.reduce((n, l) => n + l.priceCents * l.quantity, 0);
    const split = taxFor(
      lines.map((l) => ({ amountCents: l.priceCents * l.quantity, taxClass: normalizeTaxClass(l.taxClass) })),
      rates
    );
    const taxCents = split.taxCents;
    const totalCents = subtotalCents + taxCents;

    if (mode === "CASH") {
      const registerCode = await uniqueCode();
      const cart = await db.selfCart.create({
        data: {
          token: randomBytes(16).toString("hex"),
          linesJson: JSON.stringify(lines),
          subtotalCents, taxCents, totalCents, email,
          soldByVendorId: vendorId,
          registerCode,
          foodTaxCents: split.foodTaxCents, standardTaxCents: split.standardTaxCents,
        },
      });
      /* Stock is NOT decremented yet. The sale doesn't exist until cash is
         actually taken at the register, and holding stock against a customer
         who wanders off would quietly make items unsellable. */
      return NextResponse.json({ mode: "CASH", registerCode, cartId: cart.id, totalCents, taxCents, subtotalCents });
    }

    if (!stripe) {
      return NextResponse.json({ error: "Card payments aren't set up — take cash at the register instead." }, { status: 500 });
    }

    const token = randomBytes(16).toString("hex");
    const cart = await db.selfCart.create({
      data: {
        token, linesJson: JSON.stringify(lines), subtotalCents, taxCents, totalCents, email,
        soldByVendorId: vendorId,
        foodTaxCents: split.foodTaxCents, standardTaxCents: split.standardTaxCents,
      },
    });

    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        ...lines.map((l) => ({
          price_data: { currency: "usd", product_data: { name: `${l.name} — ${l.vendorName}`.slice(0, 120) }, unit_amount: l.priceCents },
          quantity: l.quantity,
        })),
        ...(taxCents > 0
          ? [{ price_data: { currency: "usd", product_data: { name: "Sales tax" }, unit_amount: taxCents }, quantity: 1 }]
          : []),
      ],
      // Same metadata key self-checkout uses, so the existing Stripe webhook
      // finalizes this with no new branch.
      metadata: { app: "community-harvest-market", selfCartId: cart.id },
      customer_email: email || undefined,
      success_url: `${base}/shop/paid/${token}`,
      cancel_url: `${base}/vendor/sell`,
    });
    await db.selfCart.update({ where: { id: cart.id }, data: { stripeSessionId: session.id } });

    return NextResponse.json({ mode: "CARD", url: session.url, cartId: cart.id, totalCents, taxCents, subtotalCents });
  });
}

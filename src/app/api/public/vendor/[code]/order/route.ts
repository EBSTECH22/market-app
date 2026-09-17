import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { runRoute } from "@/lib/handler";
import { randomBytes } from "crypto";
import { priceCart, claimOnlineStock, nextOrderNumber, type CartRequest } from "@/lib/orders";
import { enforceRateLimit, clientIp } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/**
 * Buying from one vendor, online.
 *
 * POST { action: "quote", lines, fulfillment } — what it comes to, no commitment
 * POST { action: "checkout", lines, fulfillment, email, name, phone, note } — pay
 *
 * The quote exists so the basket on the storefront shows the same arithmetic the
 * checkout will charge, computed by the same function on the same data. A cart
 * that totals one number on the page and another at Stripe is the fastest way
 * to lose a sale and the trust behind it.
 */
export async function POST(req: NextRequest, { params }: { params: { code: string } }) {
  return runRoute("public/vendor/order POST", async () => {
    const body = await req.json();
    const fulfillment = body.fulfillment === "SHIP" ? "SHIP" : "PICKUP";
    const lines = (Array.isArray(body.lines) ? body.lines : []) as CartRequest;

    const priced = await priceCart(params.code, lines, fulfillment);
    if (!priced.ok) return NextResponse.json({ error: priced.error }, { status: 400 });
    const cart = priced.cart;

    if (body.action === "quote") {
      return NextResponse.json({
        vendorName: cart.vendorName,
        lines: cart.lines,
        subtotalCents: cart.subtotalCents,
        shippingCents: cart.shippingCents,
        taxCents: cart.taxCents,
        totalCents: cart.totalCents,
      });
    }

    if (body.action !== "checkout") {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }

    if (!stripe) return NextResponse.json({ error: "Card payment isn't set up yet." }, { status: 500 });

    /* Checkout is rate limited by IP. Each attempt CLAIMS STOCK, so without a
       limit a script could empty a vendor's online shelf without paying a
       cent just by starting checkouts. */
    const limited = await enforceRateLimit(req, "public-order", clientIp(req), { limit: 10, windowMs: 10 * 60 * 1000 }, "Too many checkout attempts — give it a few minutes.");
    if (limited) return limited;

    const email = String(body.email || "").trim().toLowerCase().slice(0, 160);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: "We need an email to send your order confirmation to." }, { status: 400 });
    }
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name) return NextResponse.json({ error: "Please give a name for the order." }, { status: 400 });
    const phone = String(body.phone || "").trim().slice(0, 40);
    const note = String(body.note || "").trim().slice(0, 500);

    // Stock first: if it can't be claimed, nobody should reach a payment page.
    const claim = await claimOnlineStock(cart.lines);
    if (!claim.ok) return NextResponse.json({ error: claim.error }, { status: 409 });

    const token = randomBytes(24).toString("hex");
    let order;
    try {
      order = await db.order.create({
        data: {
          number: await nextOrderNumber(),
          vendorId: cart.vendorId,
          customerName: name,
          customerEmail: email,
          customerPhone: phone,
          note,
          fulfillment,
          subtotalCents: cart.subtotalCents,
          shippingCents: cart.shippingCents,
          taxCents: cart.taxCents,
          foodTaxCents: cart.foodTaxCents,
          standardTaxCents: cart.standardTaxCents,
          totalCents: cart.totalCents,
          commissionCents: cart.commissionCents,
          vendorNetCents: cart.vendorNetCents,
          status: "PENDING",
          token,
          lines: {
            create: cart.lines.map((l) => ({
              itemId: l.itemId,
              name: l.name,
              unitLabel: l.unitLabel,
              priceCents: l.priceCents,
              quantity: l.quantity,
              taxClass: l.taxClass,
              shipCents: l.shipCents,
            })),
          },
        },
      });
    } catch (err) {
      // The order row failed, so the stock it took has to go back.
      const { releaseOnlineStock } = await import("@/lib/orders");
      await releaseOnlineStock(cart.lines);
      throw err;
    }

    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: email,
        line_items: [
          ...cart.lines.map((l) => ({
            price_data: {
              currency: "usd",
              product_data: { name: `${l.name}${l.unitLabel ? ` (${l.unitLabel})` : ""} — ${cart.vendorName}`.slice(0, 120) },
              unit_amount: l.priceCents,
            },
            quantity: l.quantity,
          })),
          ...(cart.shippingCents > 0
            ? [{ price_data: { currency: "usd", product_data: { name: "Shipping" }, unit_amount: cart.shippingCents }, quantity: 1 }]
            : []),
          ...(cart.taxCents > 0
            ? [{ price_data: { currency: "usd", product_data: { name: "Sales tax" }, unit_amount: cart.taxCents }, quantity: 1 }]
            : []),
        ],
        /* Stripe collects the delivery address rather than this app asking for
           it: their form validates it, remembers it for returning customers,
           and means no address is typed into a page the market wrote. */
        ...(fulfillment === "SHIP" ? { shipping_address_collection: { allowed_countries: ["US" as const] } } : {}),
        metadata: { app: "community-harvest-market", orderId: order.id },
        success_url: `${base}/order/${token}`,
        cancel_url: `${base}/v/${cart.vendorCode}?cancelled=1`,
      });

      await db.order.update({ where: { id: order.id }, data: { stripeSessionId: session.id } });
      return NextResponse.json({ url: session.url, token });
    } catch (err) {
      console.error("[public/order] stripe session failed", err);
      const { releaseOnlineStock } = await import("@/lib/orders");
      await releaseOnlineStock(cart.lines);
      await db.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } }).catch(() => {});
      return NextResponse.json({ error: "Couldn't start the payment. Nothing has been charged — try again." }, { status: 502 });
    }
  });
}

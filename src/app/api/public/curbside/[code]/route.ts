import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { runRoute } from "@/lib/handler";
import { randomBytes } from "crypto";
import { priceCart, nextOrderNumber, type CartRequest } from "@/lib/orders";
import { enforceRateLimit, clientIp } from "@/lib/ratelimit";
import { getCardAdjustPercent, getMarketFeePercent } from "@/lib/settings";
import { marketFeeFor } from "@/lib/marketfee";
import { tagCents, cashCents } from "@/lib/cardprice";
import { effectivePriceCents } from "@/lib/pricing";
import { normalizeTaxClass } from "@/lib/tax";
import { openState, minuteOfDay } from "@/lib/curbside";
import { TZ } from "@/lib/time";
import { pushToVendor } from "@/lib/push";

export const dynamic = "force-dynamic";

/** How many unpaid orders one phone number may have waiting at once. */
const MAX_OPEN_UNPAID = 2;

async function stand(code: string) {
  return db.vendor.findFirst({
    where: { code: code.toUpperCase(), active: true, portalLocked: false, curbsideEnabled: true },
    select: {
      id: true, code: true, businessName: true, marketFeePercent: true,
      curbsideOpenMinute: true, curbsideCloseMinute: true, curbsideCutoffMinutes: true,
      curbsidePausedUntil: true, curbsideEnabled: true,
    },
  });
}

function hoursOf(v: { curbsideOpenMinute: number; curbsideCloseMinute: number; curbsideCutoffMinutes: number }) {
  return { openMinute: v.curbsideOpenMinute, closeMinute: v.curbsideCloseMinute, cutoffMinutes: v.curbsideCutoffMinutes };
}

/**
 * The menu, and whether it can be ordered from right now.
 *
 * Open or shut is decided HERE, every time, never by the page. A phone left on
 * the dashboard overnight would otherwise happily order a lemonade at 3am.
 */
export async function GET(_req: NextRequest, { params }: { params: { code: string } }) {
  return runRoute("public/curbside GET", async () => {
    const v = await stand(params.code);
    if (!v) return NextResponse.json({ error: "No curbside ordering here." }, { status: 404 });

    const state = openState(minuteOfDay(new Date(), TZ), hoursOf(v), {
      enabled: v.curbsideEnabled,
      pausedUntil: v.curbsidePausedUntil,
    });

    const items = await db.item.findMany({
      where: { vendorId: v.id, active: true },
      orderBy: [{ featured: "desc" }, { name: "asc" }],
      include: {
        optionGroups: {
          where: { active: true },
          include: { options: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        },
      },
    });

    const cardPercent = await getCardAdjustPercent();
    const fee = marketFeeFor(v, await getMarketFeePercent());

    return NextResponse.json({
      vendor: { code: v.code, businessName: v.businessName },
      open: state.open,
      reason: state.open ? "" : state.reason,
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        unitLabel: i.unitLabel,
        /* The price with nothing chosen yet. Options move it, and the page
           asks the server for the real figure before anything is ordered. */
        priceCents: tagCents(cashCents(effectivePriceCents(i), fee), cardPercent),
        taxClass: normalizeTaxClass(i.taxClass),
        /* Sold out takes the whole drink off; a single syrup running out is
           handled per option below. */
        soldOut: i.optionGroups.length === 0 ? false : i.optionGroups.every((g) => g.required && g.options.every((o) => o.soldOut)),
        optionGroups: i.optionGroups.map((g) => ({
          id: g.id, name: g.name, required: g.required, minChoices: g.minChoices, maxChoices: g.maxChoices,
          options: g.options.map((o) => ({ id: o.id, name: o.name, priceDeltaCents: o.priceDeltaCents, soldOut: o.soldOut })),
        })),
      })),
    });
  });
}

/**
 * POST { action: "quote" | "place", lines, payMode, name, phone, vehicleColor, note }
 *
 * `quote` is the same arithmetic the order will use, on the same data, so the
 * basket on screen and the money taken can't disagree.
 *
 * `place` with payMode "INSIDE" creates a live, unpaid order — deliberately NOT
 * the PENDING state the rest of the app uses for an abandoned checkout, which
 * a sweeper would clear away. With "NOW" it goes to Stripe and only becomes
 * visible to the stand once the payment lands.
 */
export async function POST(req: NextRequest, { params }: { params: { code: string } }) {
  return runRoute("public/curbside POST", async () => {
    const v = await stand(params.code);
    if (!v) return NextResponse.json({ error: "No curbside ordering here." }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const lines = (Array.isArray(body.lines) ? body.lines : []) as CartRequest;

    const priced = await priceCart(params.code, lines, "CURBSIDE");
    if (!priced.ok) return NextResponse.json({ error: priced.error }, { status: 400 });
    const cart = priced.cart;

    if (body.action === "quote") {
      return NextResponse.json({
        vendorName: cart.vendorName,
        lines: cart.lines,
        subtotalCents: cart.subtotalCents,
        taxCents: cart.taxCents,
        totalCents: cart.totalCents,
      });
    }

    /* ------------------------------------------------ FINDING IT AGAIN --
    
       The status page IS the check-in button, and it lives behind a long
       random token in the URL. Close the tab on the way to the car and the
       only way to say "I'm outside" is to walk in — which is the one thing
       the whole feature exists to avoid.
    
       So: their phone number, which they already gave, against orders that
       are still live at this stand. Deliberately narrow — today's unfinished
       orders only, one stand, rate limited — because a phone number is a
       guessable thing and this hands back somebody's order. What it exposes
       is a drink and a car colour, and only while they are waiting for it. */
    if (body.action === "find") {
      const limited = await enforceRateLimit(req, "curbside-find", clientIp(req), { limit: 10, windowMs: 10 * 60 * 1000 }, "Too many tries.");
      if (limited) return limited;

      const digits = String(body.phone || "").replace(/\D/g, "");
      if (digits.length < 10) return NextResponse.json({ error: "Enter the phone number you ordered with." }, { status: 400 });

      const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
      const mine = await db.order.findFirst({
        where: {
          vendorId: v.id,
          fulfillment: "CURBSIDE",
          status: { in: ["PLACED", "ACCEPTED", "READY"] },
          createdAt: { gte: since },
          /* Stored as the customer typed it, so match on the digits. */
          customerPhone: { contains: digits.slice(-10) },
        },
        orderBy: { createdAt: "desc" },
        select: { token: true, number: true },
      });
      if (!mine) {
        return NextResponse.json(
          { error: "No order waiting on that number. If you've already collected it, you're all set." },
          { status: 404 }
        );
      }
      return NextResponse.json({ token: mine.token, number: mine.number });
    }

    if (body.action !== "place") return NextResponse.json({ error: "Unknown action." }, { status: 400 });

    /* Shut is shut, checked again at the moment of ordering rather than when
       the page loaded — a basket filled at 5:29 and sent at 5:35 is late. */
    const state = openState(minuteOfDay(new Date(), TZ), hoursOf(v), {
      enabled: v.curbsideEnabled,
      pausedUntil: v.curbsidePausedUntil,
    });
    if (!state.open) return NextResponse.json({ error: state.reason }, { status: 409 });

    const limited = await enforceRateLimit(req, "curbside-order", clientIp(req), { limit: 12, windowMs: 10 * 60 * 1000 }, "Too many orders from here — give it a few minutes.");
    if (limited) return limited;

    const name = String(body.name || "").trim().slice(0, 60);
    const phone = String(body.phone || "").replace(/[^\d+]/g, "").slice(0, 20);
    const vehicleColor = String(body.vehicleColor || "").trim().slice(0, 30);
    const note = String(body.note || "").trim().slice(0, 200);
    const email = String(body.email || "").trim().slice(0, 120);
    const payInside = body.payMode === "INSIDE";

    if (!phone || phone.replace(/\D/g, "").length < 10) {
      return NextResponse.json({ error: "A phone number, in case they need to reach you." }, { status: 400 });
    }
    if (!vehicleColor) {
      return NextResponse.json({ error: "What colour is the car? It's how they'll find you." }, { status: 400 });
    }
    if (!payInside && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: "An email for the receipt." }, { status: 400 });
    }

    /* AN UNPAID ORDER COSTS NOTHING TO PLACE, which is the whole risk of a
       public link: a bored teenager can fill the counter with drinks nobody
       collects. Paid orders are not capped — money is its own proof. */
    if (payInside) {
      const openUnpaid = await db.order.count({
        where: {
          vendorId: v.id,
          customerPhone: phone,
          paidAt: null,
          status: { in: ["PLACED", "ACCEPTED", "READY"] },
        },
      });
      if (openUnpaid >= MAX_OPEN_UNPAID) {
        return NextResponse.json(
          { error: "You've already got orders waiting. Collect those first, or come in and ask at the counter." },
          { status: 429 }
        );
      }
    }

    const token = randomBytes(24).toString("hex");
    const number = await nextOrderNumber();

    const order = await db.order.create({
      data: {
        number,
        vendorId: v.id,
        customerName: name,
        customerEmail: email,
        customerPhone: phone,
        note,
        vehicleColor,
        fulfillment: "CURBSIDE",
        subtotalCents: cart.subtotalCents,
        shippingCents: 0,
        taxCents: cart.taxCents,
        foodTaxCents: cart.foodTaxCents,
        standardTaxCents: cart.standardTaxCents,
        totalCents: cart.totalCents,
        commissionCents: cart.commissionCents,
        vendorNetCents: cart.vendorNetCents,
        /* Paying inside: live from this moment. Paying now: not the stand's
           problem until Stripe says the money arrived. */
        status: payInside ? "PLACED" : "PENDING",
        token,
        lines: {
          create: cart.lines.map((l) => ({
            itemId: l.itemId,
            name: l.name,
            unitLabel: l.unitLabel,
            priceCents: l.priceCents,
            quantity: l.quantity,
            taxClass: l.taxClass,
            shipCents: 0,
            optionsText: l.optionsText || "",
          })),
        },
      },
    });

    if (payInside) {
      try {
        await pushToVendor(
          v.id,
          `Curbside order #${order.number} 🚗`,
          `${cart.lines.reduce((n, l) => n + l.quantity, 0)} item(s) · ${vehicleColor} car · paying inside`
        );
      } catch { /* a notification must never fail an order */ }
      return NextResponse.json({ token, number: order.number, payInside: true });
    }

    if (!stripe) return NextResponse.json({ error: "Card payment isn't available right now — choose to pay inside." }, { status: 503 });

    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: email,
        line_items: [
          ...cart.lines.map((l) => ({
            price_data: {
              currency: "usd",
              product_data: { name: `${l.name}${l.optionsText ? ` (${l.optionsText})` : ""}`.slice(0, 120) },
              unit_amount: l.priceCents,
            },
            quantity: l.quantity,
          })),
          ...(cart.taxCents > 0
            ? [{ price_data: { currency: "usd" as const, product_data: { name: "Sales tax" }, unit_amount: cart.taxCents }, quantity: 1 }]
            : []),
        ],
        metadata: { app: "community-harvest-market", orderId: order.id, curbside: "1" },
        success_url: `${base}/curb/${v.code}?t=${token}`,
        cancel_url: `${base}/curb/${v.code}?cancelled=1`,
      });
      await db.order.update({ where: { id: order.id }, data: { stripeSessionId: session.id } });
      return NextResponse.json({ token, number: order.number, checkoutUrl: session.url });
    } catch (err) {
      /* No stock was claimed, so there is nothing to put back — just clear the
         shell so it can't sit in the books as an order nobody made. */
      await db.order.delete({ where: { id: order.id } }).catch(() => {});
      throw err;
    }
  });
}

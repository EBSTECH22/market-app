import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isStaff } from "@/lib/auth";
import { findOrCreateCustomer, pointsFor, REDEEM_POINTS, REDEEM_CENTS } from "@/lib/customers";
import { sendCustomerReceiptEmail } from "@/lib/email";
import { getTaxRatePercent, getCardAdjustPercent } from "@/lib/settings";
import { effectivePriceCents } from "@/lib/pricing";
import { runRoute, HttpError } from "@/lib/handler";

import { pushToVendor } from "@/lib/push";

export async function POST(req: NextRequest) {
  return runRoute("admin/sale POST", async () => {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { lines, paymentMethod, cardName, customerContact, redeem } = (await req.json()) as {
    lines: { itemId: string; quantity: number }[];
    paymentMethod: string;
    cardName?: string;
    customerContact?: string;
    redeem?: boolean;
  };
  const drawer = await db.drawerSession.findFirst({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } });
  if (!drawer) return NextResponse.json({ error: "Open the drawer (employee sign-in) before ringing sales." }, { status: 400 });
  if (!Array.isArray(lines) || !lines.length) return NextResponse.json({ error: "Nothing on the ticket." }, { status: 400 });
  if (!["CASH", "CARD"].includes(paymentMethod)) return NextResponse.json({ error: "Pick a payment method." }, { status: 400 });

  const items = await db.item.findMany({
    where: { id: { in: lines.map((l) => l.itemId) } },
    include: { vendor: true },
  });

  const taxRate = await getTaxRatePercent();
  let subtotal = 0;
  const saleLines: {
    itemId: string; vendorId: string; name: string; basePriceCents: number; priceCents: number; quantity: number;
    commissionCents: number; vendorNetCents: number;
  }[] = [];

  let saleSavingsCents = 0;
  for (const l of lines) {
    const item = items.find((i) => i.id === l.itemId);
    if (!item) return NextResponse.json({ error: "An item on the ticket no longer exists." }, { status: 400 });
    const q = Math.max(1, Math.round(l.quantity));
    const unit = effectivePriceCents(item);
    saleSavingsCents += (item.priceCents - unit) * q;
    const gross = unit * q;
    const commission = Math.round((gross * item.vendor.commissionPercent) / 100);
    subtotal += gross;
    saleLines.push({
      itemId: item.id,
      vendorId: item.vendorId,
      name: item.name,
      basePriceCents: item.priceCents,
      priceCents: unit,
      quantity: q,
      commissionCents: commission,
      vendorNetCents: gross - commission,
    });
  }

  // dual pricing: posted prices are card prices; cash skips the non-cash adjustment
  const adjustPercent = await getCardAdjustPercent();
  const cardAdjustCents = paymentMethod === "CARD" && adjustPercent > 0 ? Math.round((subtotal * adjustPercent) / 100) : 0;
  const taxCents = Math.round(((subtotal + cardAdjustCents) * taxRate) / 100);

  // rewards: find the customer up front so redemption can discount this sale.
  // This is only a friendly pre-check — the authoritative balance check and the
  // decrement both happen inside the transaction below.
  const customer = customerContact ? await findOrCreateCustomer(customerContact) : null;
  let discountCents = 0;
  if (redeem) {
    if (!customer) return NextResponse.json({ error: "Enter the customer's email or phone to redeem." }, { status: 400 });
    if (customer.points < REDEEM_POINTS) return NextResponse.json({ error: `Only ${customer.points} points — ${REDEEM_POINTS} needed for $5 off.` }, { status: 400 });
    discountCents = Math.min(REDEEM_CENTS, subtotal + taxCents);
  }
  const totalCents = subtotal + cardAdjustCents + taxCents - discountCents;

  /* Retry the whole transaction if the ticket number collides. Two concurrent
     sales can compute the same next number; the unique index rejects the second
     with Prisma error P2002, and a retry recomputes against the committed max.
     Anything else rethrows immediately. */
  const runSale = async () => db.$transaction(async (tx) => {
    /* ---- stock: claim it atomically, don't check-then-take.
       A SELECT followed by a decrement lets two registers both read "1 left"
       and both sell it, because Postgres reads a snapshot. Instead each item
       is claimed with a conditional UPDATE whose WHERE carries the quantity
       test — the row is locked and re-checked by the database, so exactly one
       of two concurrent tickets can match. 0 rows matched means we lost the
       race. The names are read first only to write a useful error. */
    const needed = new Map<string, number>();
    for (const sl of saleLines) needed.set(sl.itemId, (needed.get(sl.itemId) || 0) + sl.quantity);
    const known = await tx.item.findMany({
      where: { id: { in: [...needed.keys()] } },
      select: { id: true, name: true },
    });
    const nameOf = (id: string) => known.find((i) => i.id === id)?.name || "That item";

    // Claim in a stable order so two tickets sharing items can't deadlock by
    // grabbing the same rows in opposite orders.
    for (const itemId of [...needed.keys()].sort()) {
      const qty = needed.get(itemId)!;
      if (!known.some((i) => i.id === itemId)) {
        throw new HttpError(400, "An item on the ticket no longer exists.");
      }
      const claimed = await tx.item.updateMany({
        where: { id: itemId, quantity: { gte: qty } },
        data: { quantity: { decrement: qty } },
      });
      if (claimed.count === 0) {
        const row = await tx.item.findUnique({ where: { id: itemId }, select: { quantity: true } });
        const left = row?.quantity ?? 0;
        throw new HttpError(
          400,
          left <= 0
            ? `${nameOf(itemId)} is sold out — take it off the ticket.`
            : `Only ${left} of ${nameOf(itemId)} left (ticket has ${qty}) — adjust the quantity.`
        );
      }
    }

    // ---- redemption: conditional decrement, so the same 100 points can't be
    // spent twice by two concurrent sales. 0 rows matched = someone beat us.
    if (redeem && customer) {
      const spent = await tx.customer.updateMany({
        where: { id: customer.id, points: { gte: REDEEM_POINTS } },
        data: { points: { decrement: REDEEM_POINTS } },
      });
      if (spent.count === 0) {
        throw new HttpError(400, `Those points were just used — ${REDEEM_POINTS} points aren't available anymore. Ring it up without the reward.`);
      }
    }

    /* Ticket number. Reading the max and adding one is racy — two registers
       ringing at the same moment both read the same max. A unique index on
       Sale.number is what actually prevents a duplicate; this transaction is
       retried by the caller when that index rejects the insert. */
    const last = await tx.sale.aggregate({ _max: { number: true } });
    const number = Math.max(1000, (last._max.number || 999) + 1);
    const created = await tx.sale.create({
      data: {
        customerId: customer ? customer.id : "",
        discountCents,
        cardAdjustCents,
        saleSavingsCents,
        number,
        cardName: paymentMethod === "CARD" ? (cardName || "").trim().slice(0, 60) : "",
        employee: drawer.employee,
        subtotalCents: subtotal, taxCents, totalCents, paymentMethod,
        lines: { create: saleLines },
      },
    });
    for (const sl of saleLines) {
      // Stock was already claimed at the top of this transaction — decrementing
      // again here would double-count it.
      await tx.ledgerEntry.create({
        data: {
          vendorId: sl.vendorId,
          type: "SALE",
          amountCents: sl.vendorNetCents,
          note: `${sl.quantity}× ${sl.name}`,
        },
      });
    }
    /* The old code clamped negative quantities here, which quietly hid an
       oversell after the fact. The conditional claim above makes a negative
       count unreachable, so there is nothing left to paper over. */

    // ---- points earned + the audit trail, committed with the sale
    if (customer) {
      const earned = pointsFor(totalCents);
      if (earned > 0) {
        await tx.customer.update({ where: { id: customer.id }, data: { points: { increment: earned } } });
        await tx.loyaltyEvent.create({ data: { customerId: customer.id, saleId: created.id, delta: earned, note: `Sale #${created.number}` } });
      }
      if (redeem) {
        await tx.loyaltyEvent.create({ data: { customerId: customer.id, saleId: created.id, delta: -REDEEM_POINTS, note: `$5 reward redeemed on #${created.number}` } });
      }
    }
    return created;
  });

  let sale;
  try {
    sale = await runSale();
  } catch (err) {
    const code = (err as { code?: string }).code;
    const target = String((err as { meta?: { target?: unknown } }).meta?.target || "");
    // Index is named Sale_number_unique, so either fragment identifies it.
    if (code === "P2002" && (target.includes("number") || target.includes("Sale"))) {
      sale = await runSale(); // one retry is enough for a two-register collision
    } else {
      throw err;
    }
  }

  // one email per vendor involved, after commit
  const byVendor = new Map<string, typeof saleLines>();
  for (const sl of saleLines) {
    byVendor.set(sl.vendorId, [...(byVendor.get(sl.vendorId) || []), sl]);
  }
  for (const [vendorId, vLines] of byVendor) {
    const vendor = items.find((i) => i.vendorId === vendorId)?.vendor;
    if (vendor?.email) {
      try {
        const net = vLines.reduce((n, l) => n + l.vendorNetCents, 0);
        const itemsTxt = vLines.map((l) => `${l.quantity}x ${l.name}`).join(", ");
        // push-enabled vendors get pinged per sale; everyone else gets one daily summary email (cron)
        await pushToVendor(
          vendor.id,
          "You made a sale! 🎉",
          `${itemsTxt} — your net $${(net / 100).toFixed(2)}`
        );
      } catch (err) {
        console.error("sale email failed", err);
      }
    }
  }

  let customerPoints: number | null = null;
  if (customer) {
    const fresh = await db.customer.findUnique({ where: { id: customer.id } });
    customerPoints = fresh?.points ?? null;
    if (customer.email) {
      try {
        await sendCustomerReceiptEmail(customer.email, sale.number,
          saleLines.map((l) => ({ name: l.name, quantity: l.quantity, priceCents: l.basePriceCents || l.priceCents })),
          subtotal, taxCents, discountCents, totalCents, customerPoints ?? 0, saleSavingsCents);
      } catch {}
    }
  }

  return NextResponse.json({ sale: { id: sale.id, number: sale.number, employee: sale.employee, cardName: sale.cardName, createdAt: sale.createdAt, subtotalCents: subtotal, taxCents, discountCents, cardAdjustCents, saleSavingsCents, totalCents, taxRate, customerPoints, customerContact: customer ? (customer.email || customer.phone) : "" } });
  });
}

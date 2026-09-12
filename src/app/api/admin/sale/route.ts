import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isStaff } from "@/lib/auth";
import { findOrCreateCustomer, pointsFor, REDEEM_POINTS, REDEEM_CENTS } from "@/lib/customers";
import { sendCustomerReceiptEmail } from "@/lib/email";
import { getTaxRatePercent, getCardAdjustPercent } from "@/lib/settings";

import { pushToVendor } from "@/lib/push";

export async function POST(req: NextRequest) {
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
    itemId: string; vendorId: string; name: string; priceCents: number; quantity: number;
    commissionCents: number; vendorNetCents: number;
  }[] = [];

  for (const l of lines) {
    const item = items.find((i) => i.id === l.itemId);
    if (!item) return NextResponse.json({ error: "An item on the ticket no longer exists." }, { status: 400 });
    const q = Math.max(1, Math.round(l.quantity));
    const gross = item.priceCents * q;
    const commission = Math.round((gross * item.vendor.commissionPercent) / 100);
    subtotal += gross;
    saleLines.push({
      itemId: item.id,
      vendorId: item.vendorId,
      name: item.name,
      priceCents: item.priceCents,
      quantity: q,
      commissionCents: commission,
      vendorNetCents: gross - commission,
    });
  }

  // dual pricing: posted prices are card prices; cash skips the non-cash adjustment
  const adjustPercent = await getCardAdjustPercent();
  const cardAdjustCents = paymentMethod === "CARD" && adjustPercent > 0 ? Math.round((subtotal * adjustPercent) / 100) : 0;
  const taxCents = Math.round(((subtotal + cardAdjustCents) * taxRate) / 100);

  // rewards: find the customer up front so redemption can discount this sale
  let customer = customerContact ? await findOrCreateCustomer(customerContact) : null;
  let discountCents = 0;
  if (redeem) {
    if (!customer) return NextResponse.json({ error: "Enter the customer's email or phone to redeem." }, { status: 400 });
    if (customer.points < REDEEM_POINTS) return NextResponse.json({ error: `Only ${customer.points} points — ${REDEEM_POINTS} needed for $5 off.` }, { status: 400 });
    discountCents = Math.min(REDEEM_CENTS, subtotal + taxCents);
  }
  const totalCents = subtotal + cardAdjustCents + taxCents - discountCents;

  const sale = await db.$transaction(async (tx) => {
    const last = await tx.sale.aggregate({ _max: { number: true } });
    const number = Math.max(1000, (last._max.number || 999) + 1);
    const created = await tx.sale.create({
      data: {
        customerId: customer ? customer.id : "",
        discountCents,
        cardAdjustCents,
        number,
        cardName: paymentMethod === "CARD" ? (cardName || "").trim().slice(0, 60) : "",
        employee: drawer.employee,
        subtotalCents: subtotal, taxCents, totalCents, paymentMethod,
        lines: { create: saleLines },
      },
    });
    for (const sl of saleLines) {
      await tx.item.update({
        where: { id: sl.itemId },
        data: { quantity: { decrement: sl.quantity } },
      });
      await tx.ledgerEntry.create({
        data: {
          vendorId: sl.vendorId,
          type: "SALE",
          amountCents: sl.vendorNetCents,
          note: `${sl.quantity}× ${sl.name}`,
        },
      });
    }
    // never let floor counts go negative
    await tx.item.updateMany({ where: { quantity: { lt: 0 } }, data: { quantity: 0 } });
    return created;
  });

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
    const earned = pointsFor(totalCents);
    const delta = earned - (redeem ? REDEEM_POINTS : 0);
    if (delta !== 0) {
      await db.customer.update({ where: { id: customer.id }, data: { points: { increment: delta } } });
    }
    if (earned > 0) await db.loyaltyEvent.create({ data: { customerId: customer.id, saleId: sale.id, delta: earned, note: `Sale #${sale.number}` } });
    if (redeem) await db.loyaltyEvent.create({ data: { customerId: customer.id, saleId: sale.id, delta: -REDEEM_POINTS, note: `$5 reward redeemed on #${sale.number}` } });
    const fresh = await db.customer.findUnique({ where: { id: customer.id } });
    customerPoints = fresh?.points ?? null;
    if (customer.email) {
      try {
        await sendCustomerReceiptEmail(customer.email, sale.number,
          saleLines.map((l) => ({ name: l.name, quantity: l.quantity, priceCents: l.priceCents })),
          subtotal, taxCents, discountCents, totalCents, customerPoints ?? 0);
      } catch {}
    }
  }

  return NextResponse.json({ sale: { id: sale.id, number: sale.number, employee: sale.employee, cardName: sale.cardName, createdAt: sale.createdAt, subtotalCents: subtotal, taxCents, discountCents, cardAdjustCents, totalCents, taxRate, customerPoints, customerContact: customer ? (customer.email || customer.phone) : "" } });
}

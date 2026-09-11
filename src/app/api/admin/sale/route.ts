import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { getTaxRatePercent } from "@/lib/settings";
import { sendSaleEmail } from "@/lib/email";

export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { lines, paymentMethod } = (await req.json()) as {
    lines: { itemId: string; quantity: number }[];
    paymentMethod: string;
  };
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

  const taxCents = Math.round((subtotal * taxRate) / 100);
  const totalCents = subtotal + taxCents;

  const sale = await db.$transaction(async (tx) => {
    const created = await tx.sale.create({
      data: { subtotalCents: subtotal, taxCents, totalCents, paymentMethod, lines: { create: saleLines } },
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
        await sendSaleEmail(vendor, vLines);
      } catch (err) {
        console.error("sale email failed", err);
      }
    }
  }

  return NextResponse.json({ sale: { id: sale.id, subtotalCents: subtotal, taxCents, totalCents, taxRate } });
}

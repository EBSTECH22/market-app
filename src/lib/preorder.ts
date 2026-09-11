import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { pushToAdmin, pushToVendor } from "@/lib/push";
import { sendVendorInboxEmail, sendPreorderPaidEmail } from "@/lib/email";

// Verifies a Stripe session and, if paid, books the sale exactly like a register sale:
// receipt number, vendor ledger credit net of commission, tax in reports. Idempotent.
export async function finalizeIfPaid(preorderId: string): Promise<boolean> {
  const po = await db.preOrder.findUnique({ where: { id: preorderId } });
  if (!po || po.status === "PAID") return po?.status === "PAID";
  if (po.status !== "ACCEPTED" || !po.stripeSessionId || !stripe) return false;

  let paid = false;
  try {
    const session = await stripe.checkout.sessions.retrieve(po.stripeSessionId);
    paid = session.payment_status === "paid";
  } catch (err) {
    console.error("stripe session check failed", err);
    return false;
  }
  if (!paid) return false;

  const vendor = await db.vendor.findUnique({ where: { id: po.vendorId } });
  if (!vendor) return false;
  const thread = await db.thread.findUnique({ where: { id: po.threadId } });
  const commissionCents = Math.round((po.subtotalCents * vendor.commissionPercent) / 100);
  const vendorNetCents = po.subtotalCents - commissionCents;

  await db.$transaction(async (tx) => {
    const fresh = await tx.preOrder.findUnique({ where: { id: po.id } });
    if (!fresh || fresh.status === "PAID") return; // double-finalize guard
    const last = await tx.sale.aggregate({ _max: { number: true } });
    const number = Math.max(1000, (last._max.number || 999) + 1);
    const sale = await tx.sale.create({
      data: {
        number,
        cardName: thread?.customerName || "",
        employee: "ONLINE",
        subtotalCents: po.subtotalCents,
        taxCents: po.taxCents,
        totalCents: po.totalCents,
        paymentMethod: "CARD",
        lines: {
          create: [{
            itemId: `PREORDER`,
            vendorId: vendor.id,
            name: `Pre-order: ${po.description.slice(0, 80)}`,
            priceCents: po.subtotalCents,
            quantity: 1,
            commissionCents,
            vendorNetCents,
          }],
        },
      },
    });
    await tx.ledgerEntry.create({
      data: { vendorId: vendor.id, type: "SALE", amountCents: vendorNetCents, note: `Pre-order paid online (ticket #${number})` },
    });
    await tx.preOrder.update({
      where: { id: po.id },
      data: { status: "PAID", paidAt: new Date(), saleId: sale.id },
    });
    if (thread) {
      await tx.threadMsg.create({
        data: { threadId: thread.id, sender: "VENDOR", body: `✅ Payment received — $${(po.totalCents / 100).toFixed(2)}. Ticket #${number}. Expected: ${po.expectedDate}.` },
      });
      await tx.thread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
    }
  });

  try {
    if (thread) await sendPreorderPaidEmail(thread.email, thread.customerName, vendor.businessName, po.description, po.totalCents, po.expectedDate, thread.token);
  } catch (err) { console.error("paid email failed", err); }
  try {
    const pushed = await pushToVendor(vendor.id, "Pre-order PAID 🎉", `${thread?.customerName || "Customer"} paid $${(po.totalCents / 100).toFixed(2)} — ${po.description.slice(0, 60)}`);
    if (pushed === 0) await sendVendorInboxEmail(vendor, "PREORDER", `${thread?.customerName || "Customer"} (PAID)`);
  } catch (err) { console.error("vendor paid notify failed", err); }
  try { await pushToAdmin("Pre-order paid 💳", `${vendor.businessName}: $${(po.totalCents / 100).toFixed(2)} online`); } catch {}
  return true;
}

// Sweep a vendor's outstanding accepted pre-orders (called when their inbox loads)
export async function reconcileVendorPreorders(vendorId: string): Promise<void> {
  const open = await db.preOrder.findMany({
    where: { vendorId, status: "ACCEPTED", stripeSessionId: { not: "" } },
    take: 20, orderBy: { createdAt: "desc" },
  });
  for (const po of open) await finalizeIfPaid(po.id).catch(() => {});
}

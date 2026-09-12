import { db } from "@/lib/db";
import { randomBytes } from "crypto";
import { sendCustomerReceiptEmail, sendRestockAlertEmail, sendFollowConfirmEmail } from "@/lib/email";

export const POINTS_PER_CENTS = 200;   // 1 point per $2 spent
export const REDEEM_POINTS = 100;      // 100 points =
export const REDEEM_CENTS = 500;       // $5 off

const isEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
const cleanPhone = (v: string) => v.replace(/[^\d]/g, "");

// contact can be an email or a phone number; finds or creates the one Customer record
export async function findOrCreateCustomer(contactRaw: string) {
  const contact = contactRaw.trim().toLowerCase();
  if (!contact) return null;
  if (isEmail(contact)) {
    const existing = await db.customer.findFirst({ where: { email: { equals: contact, mode: "insensitive" } } });
    if (existing) return existing;
    return db.customer.create({ data: { email: contact, token: randomBytes(12).toString("hex") } });
  }
  const phone = cleanPhone(contact);
  if (phone.length < 7) return null;
  const existing = await db.customer.findFirst({ where: { phone } });
  if (existing) return existing;
  return db.customer.create({ data: { phone, token: randomBytes(12).toString("hex") } });
}

export async function lookupCustomer(contactRaw: string) {
  const contact = contactRaw.trim().toLowerCase();
  if (!contact) return null;
  if (isEmail(contact)) return db.customer.findFirst({ where: { email: { equals: contact, mode: "insensitive" } } });
  const phone = cleanPhone(contact);
  if (!phone) return null;
  return db.customer.findFirst({ where: { phone } });
}

export function pointsFor(totalCents: number) {
  return Math.floor(totalCents / POINTS_PER_CENTS);
}

// attach a customer to a completed sale, award points, email a receipt if we can
export async function attachCustomerToSale(saleId: string, contact: string): Promise<{ points: number; contact: string } | null> {
  const sale = await db.sale.findUnique({ where: { id: saleId }, include: { lines: true } });
  if (!sale || sale.status === "VOIDED") return null;
  const customer = await findOrCreateCustomer(contact);
  if (!customer) return null;
  const earned = pointsFor(sale.totalCents);
  await db.$transaction(async (tx) => {
    await tx.sale.update({ where: { id: sale.id }, data: { customerId: customer.id } });
    if (earned > 0 && sale.customerId !== customer.id) {
      await tx.customer.update({ where: { id: customer.id }, data: { points: { increment: earned } } });
      await tx.loyaltyEvent.create({ data: { customerId: customer.id, saleId: sale.id, delta: earned, note: `Sale #${sale.number}` } });
    }
  });
  const fresh = await db.customer.findUnique({ where: { id: customer.id } });
  if (customer.email) {
    try {
      await sendCustomerReceiptEmail(customer.email, sale.number,
        sale.lines.map((l) => ({ name: l.name, quantity: l.quantity, priceCents: l.basePriceCents || l.priceCents })),
        sale.subtotalCents, sale.taxCents, sale.discountCents, sale.totalCents, fresh?.points ?? 0, sale.saleSavingsCents);
    } catch {}
  }
  return { points: fresh?.points ?? 0, contact: customer.email || customer.phone };
}

// restock alerts — at most one per vendor per ~20h
export async function notifyVendorRestock(vendorId: string) {
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor || !vendor.active) return;
  const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000);
  if (vendor.lastRestockAlertAt && vendor.lastRestockAlertAt > cutoff) return;
  const follows = await db.vendorFollow.findMany({ where: { vendorId }, include: { customer: true } });
  const emails = follows.map((f) => f.customer).filter((c) => c.email && !c.unsubscribed);
  if (emails.length === 0) return;
  await db.vendor.update({ where: { id: vendorId }, data: { lastRestockAlertAt: new Date() } });
  const items = await db.item.findMany({ where: { vendorId, active: true, quantity: { gt: 0 } }, orderBy: { name: "asc" }, take: 8 });
  for (const c of emails) {
    try { await sendRestockAlertEmail(c.email, vendor.businessName, vendor.code, items.map((i) => ({ name: i.name, priceCents: i.priceCents })), c.token); } catch {}
  }
}

export async function followVendor(vendorCode: string, email: string): Promise<{ ok: boolean; error?: string }> {
  if (!isEmail(email.trim().toLowerCase())) return { ok: false, error: "That email doesn't look right." };
  const vendor = await db.vendor.findFirst({ where: { code: { equals: vendorCode, mode: "insensitive" }, active: true } });
  if (!vendor) return { ok: false, error: "Vendor not found." };
  const customer = await findOrCreateCustomer(email);
  if (!customer) return { ok: false, error: "Couldn't save that email." };
  await db.vendorFollow.upsert({
    where: { customerId_vendorId: { customerId: customer.id, vendorId: vendor.id } },
    create: { customerId: customer.id, vendorId: vendor.id },
    update: {},
  });
  if (customer.unsubscribed) await db.customer.update({ where: { id: customer.id }, data: { unsubscribed: false } });
  try { await sendFollowConfirmEmail(customer.email, vendor.businessName, vendor.code, customer.token); } catch {}
  return { ok: true };
}

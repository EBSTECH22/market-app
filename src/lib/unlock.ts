import { db } from "@/lib/db";
import { randomBytes } from "crypto";
import { hashPassword } from "@/lib/auth";
import { TEMP_PASSWORD_BYTES } from "@/lib/vendor";
import { sendWelcomeEmail } from "@/lib/email";

// Approved-vendor gate: portal opens only when contract is fully signed AND rent is fully paid (balance >= 0)
export async function unlockIfRentPaid(vendorId: string) {
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor || !vendor.portalLocked) return;
  const contract = await db.contract.findFirst({ where: { vendorId, vendorSignedAt: { not: null }, marketSignedAt: { not: null } } });
  if (!contract) return;
  const agg = await db.ledgerEntry.aggregate({ where: { vendorId }, _sum: { amountCents: true } });
  if ((agg._sum.amountCents || 0) < 0) return;
  // only ever emailed — never returned to a caller
  const tempPassword = randomBytes(TEMP_PASSWORD_BYTES).toString("hex");
  await db.vendor.update({ where: { id: vendorId }, data: { portalLocked: false, passwordHash: hashPassword(tempPassword), mustChangePassword: true } });
  try { await sendWelcomeEmail({ email: vendor.email, businessName: vendor.businessName, code: vendor.code }, tempPassword); } catch {}
}

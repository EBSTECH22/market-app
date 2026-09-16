import { db } from "@/lib/db";
import { randomBytes } from "crypto";
import { hashPassword } from "@/lib/auth";
import { TEMP_PASSWORD_BYTES } from "@/lib/vendor";
import { sendWelcomeEmail, sendSetupGuideEmail } from "@/lib/email";

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

  // Credentials first — the setup guide tells them to log in, so it's only
  // useful once they have a password and the portal actually opens.
  try { await sendWelcomeEmail({ email: vendor.email, businessName: vendor.businessName, code: vendor.code }, tempPassword); } catch {}

  /* The setup guide used to be a manual button the office had to remember. It
     belongs here: this is the exact moment the portal opens, so "put the app on
     your phone and add your products" is finally true. phoneType comes off
     their application so the instructions match the phone they told us about. */
  try {
    const app = await db.vendorApplication.findFirst({
      where: { email: { equals: vendor.email, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      select: { phoneType: true },
    });
    await sendSetupGuideEmail(vendor.email, vendor.businessName, app?.phoneType || "");
  } catch {}
}

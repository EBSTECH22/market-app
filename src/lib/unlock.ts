import { db } from "@/lib/db";
import { randomBytes } from "crypto";
import { hashPassword } from "@/lib/auth";
import { TEMP_PASSWORD_BYTES } from "@/lib/vendor";
import { sendWelcomeEmail, sendSetupGuideEmail } from "@/lib/email";

/**
 * The setup guide, exactly once.
 *
 * Kept apart from the unlock because a vendor can arrive at "fully signed and
 * paid up" already unlocked — anyone added straight from the Vendors screen
 * is created with an open portal and a password emailed on the spot. That
 * vendor still needs the guide, and used to get nothing: the unlock bailed
 * on the first line because there was no lock to undo, and the guide went
 * with it.
 */
async function sendSetupGuideOnce(vendor: { id: string; email: string; businessName: string; setupGuideSentAt: Date | null }) {
  if (vendor.setupGuideSentAt) return;
  try {
    const app = await db.vendorApplication.findFirst({
      where: { email: { equals: vendor.email, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      select: { phoneType: true },
    });
    await sendSetupGuideEmail(vendor.email, vendor.businessName, app?.phoneType || "");
    await db.vendor.update({ where: { id: vendor.id }, data: { setupGuideSentAt: new Date() } });
  } catch (err) {
    /* Leave the stamp unset so it is tried again next time rather than
       silently counted as sent. */
    console.error("setup guide failed", err);
  }
}

// Approved-vendor gate: portal opens only when contract is fully signed AND rent is fully paid (balance >= 0)
export async function unlockIfRentPaid(vendorId: string) {
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return;
  const contract = await db.contract.findFirst({ where: { vendorId, vendorSignedAt: { not: null }, marketSignedAt: { not: null } } });
  if (!contract) return;

  /* Already open — nothing to unlock, and resetting their password here would
     lock out a vendor who is happily using the portal. They still get the
     guide if they never had it. */
  if (!vendor.portalLocked) {
    await sendSetupGuideOnce(vendor);
    return;
  }
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
     your phone and add your products" is finally true. */
  await sendSetupGuideOnce(vendor);
}

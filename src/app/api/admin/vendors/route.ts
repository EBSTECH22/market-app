import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { sendWelcomeEmail } from "@/lib/email";
import { runRoute } from "@/lib/handler";
import { VENDOR_PUBLIC_SELECT, TEMP_PASSWORD_BYTES } from "@/lib/vendor";
import { randomBytes } from "crypto";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

export async function GET() {
  return runRoute("admin/vendors GET", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const vendors = await db.vendor.findMany({
      orderBy: { code: "asc" },
      select: { id: true, code: true, businessName: true, contactName: true, email: true, phone: true, commissionPercent: true, active: true, allowSelfCheckout: true, portalLocked: true },
    });
    const balances = await db.ledgerEntry.groupBy({ by: ["vendorId"], _sum: { amountCents: true } });
    const map = Object.fromEntries(balances.map((b) => [b.vendorId, b._sum.amountCents || 0]));
    const apps = await db.vendorApplication.findMany({ select: { id: true, vendorId: true, email: true } });
    const appByVendor: Record<string, string> = {};
    for (const a of apps) { if (a.vendorId) appByVendor[a.vendorId] = a.id; }
    const emailMap: Record<string, string> = {};
    for (const a of apps) { if (!a.vendorId) emailMap[a.email.toLowerCase()] = a.id; }
    const signed = await db.contract.findMany({ where: { vendorSignedAt: { not: null }, marketSignedAt: { not: null } }, select: { vendorId: true } });
    const signedSet = new Set(signed.map((c) => c.vendorId));
    /* Whose space is no longer being held over an unpaid invoice — shown on
       the vendor record itself, so it can't be missed by anyone who opens the
       vendor rather than the money screen. */
    const releasedRows = await db.contract.findMany({
      where: { spaceReleasedAt: { not: null } },
      select: { vendorId: true, boothLabel: true, spaceReleasedAt: true },
    });
    const releasedMap = new Map<string, { boothLabel: string; at: Date | null }>(
      releasedRows.map((c) => [c.vendorId, { boothLabel: c.boothLabel, at: c.spaceReleasedAt }] as [string, { boothLabel: string; at: Date | null }])
    );
    return NextResponse.json({ vendors: vendors.map((v) => ({ ...v, balance: map[v.id] || 0, applicationId: appByVendor[v.id] || emailMap[v.email.toLowerCase()] || null, portalLocked: v.portalLocked, hasSignedContract: signedSet.has(v.id), holdReleased: releasedMap.get(v.id) || null })) });
  });
}

export async function POST(req: NextRequest) {
  return runRoute("admin/vendors POST", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const { businessName, contactName, email, phone, commissionPercent } = await req.json();
    if (!businessName?.trim() || !email?.includes("@")) {
      return NextResponse.json({ error: "Business name and a valid email are required." }, { status: 400 });
    }
    const cleanEmail = String(email).toLowerCase().trim();

    // pre-check the unique email so a duplicate is a friendly 400 rather than
    // an unhandled Prisma P2002 (same check the PATCH route does)
    const clash = await db.vendor.findFirst({
      where: { email: { equals: cleanEmail, mode: "insensitive" } },
      select: { businessName: true },
    });
    if (clash) return NextResponse.json({ error: `${clash.businessName} already uses that email.` }, { status: 400 });

    const count = await db.vendor.count();
    const code = `V${String(count + 1).padStart(2, "0")}`;
    const tempPassword = randomBytes(TEMP_PASSWORD_BYTES).toString("hex");

    const vendor = await db.vendor.create({
      data: {
        code,
        businessName: businessName.trim(),
        contactName: (contactName || "").trim(),
        email: cleanEmail,
        phone: (phone || "").trim(),
        passwordHash: hashPassword(tempPassword),
        mustChangePassword: true,
        commissionPercent: Math.max(0, Math.min(50, Number(commissionPercent) || 0)),
      },
      select: VENDOR_PUBLIC_SELECT,
    });

    try {
      await sendWelcomeEmail(vendor, tempPassword);
    } catch (err) {
      console.error("welcome email failed", err);
    }

    // tempPassword stays in the response on purpose: the admin UI shows it in a
    // copyable dialog, and the caller is already an authenticated admin.
    return NextResponse.json({ vendor, tempPassword });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { sendPasswordResetEmail } from "@/lib/email";
import { runRoute } from "@/lib/handler";
import { VENDOR_PUBLIC_SELECT, TEMP_PASSWORD_BYTES } from "@/lib/vendor";
import { randomBytes } from "crypto";
import { denyUnless } from "@/lib/perm";
import { unlockIfRentPaid } from "@/lib/unlock";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return runRoute("admin/vendors/[id] PATCH", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const body = await req.json();
    const data: { businessName?: string; contactName?: string; phone?: string; email?: string; commissionPercent?: number; active?: boolean; allowSelfCheckout?: boolean; rentFree?: boolean; marketFeePercent?: number | null } = {};
    if (typeof body.businessName === "string" && body.businessName.trim()) data.businessName = body.businessName.trim();
    if (typeof body.contactName === "string") data.contactName = body.contactName.trim();
    if (typeof body.phone === "string") data.phone = body.phone.trim();
    if (body.commissionPercent !== undefined) {
      const c = Number(body.commissionPercent);
      if (Number.isNaN(c) || c < 0 || c > 50) return NextResponse.json({ error: "Commission must be 0-50%." }, { status: 400 });
      data.commissionPercent = c;
    }
    if (typeof body.email === "string") {
      const email = body.email.toLowerCase().trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "That email doesn't look right." }, { status: 400 });
      const clash = await db.vendor.findFirst({ where: { email: { equals: email, mode: "insensitive" }, id: { not: params.id } }, select: { businessName: true } });
      if (clash) return NextResponse.json({ error: `${clash.businessName} already uses that email.` }, { status: 400 });
      data.email = email;
    }
    if (typeof body.active === "boolean") data.active = body.active;
    if (typeof body.allowSelfCheckout === "boolean") data.allowSelfCheckout = body.allowSelfCheckout;
    if (typeof body.rentFree === "boolean") data.rentFree = body.rentFree;

    /* THE MARKET FEE, FOR THIS VENDOR ALONE.
    
       Three states, and they have to stay three. `null` — sent as an empty
       string from the form — means "whatever the market charges", and keeps
       following the market rate when it moves. A number pins this vendor to
       that rate, and 0 waives the fee entirely. Collapsing null and 0 into one
       value would lose the difference between a vendor who is exempt and a
       market that simply hasn't set a rate yet. */
    if (body.marketFeePercent !== undefined) {
      const raw = body.marketFeePercent;
      if (raw === null || String(raw).trim() === "") {
        data.marketFeePercent = null;
      } else {
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0 || v > 25) {
          return NextResponse.json({ error: "The market fee has to be between 0 and 25% — leave it blank to use the market rate." }, { status: 400 });
        }
        data.marketFeePercent = v;
      }
    }

    let tempPassword: string | undefined;
    if (body.resetPassword) {
      tempPassword = randomBytes(TEMP_PASSWORD_BYTES).toString("hex");
    }

    if (!Object.keys(data).length && !tempPassword) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    // explicit select — the bare update result carries passwordHash,
    // stripeCustomerId and stripePmId
    const vendor = await db.vendor.update({
      where: { id: params.id },
      data: { ...data, ...(tempPassword ? { passwordHash: hashPassword(tempPassword), mustChangePassword: true } : {}) },
      select: VENDOR_PUBLIC_SELECT,
    });
    /* Made rent-free after both signed: nothing is owed, so open the portal
       now (it only opens if the agreement is fully signed). */
    if (data.rentFree === true) {
      try { await unlockIfRentPaid(params.id); } catch (err) { console.error("unlock after rent-free failed", err); }
    }
    if (tempPassword) {
      try { await sendPasswordResetEmail(vendor, tempPassword); } catch (err) { console.error("reset email failed", err); }
    }
    // tempPassword stays in the response on purpose: the admin UI shows it in a
    // copyable dialog, and the caller is already an authenticated admin.
    return NextResponse.json({ vendor, tempPassword });
  });
}

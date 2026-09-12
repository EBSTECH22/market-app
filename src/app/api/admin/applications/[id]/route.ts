import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin, hashPassword } from "@/lib/auth";
import { sendApplicationDecisionEmail, sendWelcomeEmail } from "@/lib/email";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

// PATCH { action: "accept" } | { action: "decline", reason? }
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { action, reason } = await req.json();
  const app = await db.vendorApplication.findUnique({ where: { id: params.id } });
  if (!app) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!["accept", "decline"].includes(action)) return NextResponse.json({ error: "Unknown action." }, { status: 400 });

  const accepted = action === "accept";
  let vendor = null;
  let tempPassword = "";

  if (accepted) {
    // accepting an application creates the vendor account (unless that email already has one)
    const existing = await db.vendor.findFirst({ where: { email: { equals: app.email, mode: "insensitive" } } });
    if (existing) {
      vendor = existing;
    } else {
      const count = await db.vendor.count();
      const code = `V${String(count + 1).padStart(2, "0")}`;
      tempPassword = randomBytes(4).toString("hex");
      vendor = await db.vendor.create({
        data: {
          code,
          businessName: app.businessName.trim(),
          contactName: (app.contactName || "").trim(),
          email: app.email.toLowerCase().trim(),
          phone: (app.phone || "").trim(),
          passwordHash: hashPassword(tempPassword),
          mustChangePassword: true,
          commissionPercent: 0,
        },
      });
    }
  }

  const updated = await db.vendorApplication.update({
    where: { id: app.id },
    data: { status: accepted ? "ACCEPTED" : "DECLINED", decidedAt: new Date() },
  });

  try {
    await sendApplicationDecisionEmail(app.email, app.contactName, app.businessName, accepted, (reason || "").trim().slice(0, 500));
  } catch (err) { console.error("decision email failed", err); }
  if (accepted && vendor && tempPassword) {
    try {
      await sendWelcomeEmail(vendor, tempPassword);
    } catch (err) { console.error("welcome email failed", err); }
  }

  return NextResponse.json({ application: updated, vendor: vendor ? { id: vendor.id, code: vendor.code, businessName: vendor.businessName } : null });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin, hashPassword } from "@/lib/auth";
import { sendApplicationDecisionEmail, sendViewingEmail, sendContractSignEmail } from "@/lib/email";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

// PATCH — application pipeline:
//   { action: "save_notes", notes }            — call/review notes
//   { action: "mark_called" }                  — stage NEW -> CALLED
//   { action: "schedule_viewing", when }       — emails applicant, stage -> VIEWING
//   { action: "create_contract", boothLabel, rentDollars, startDate }
//       -> creates LOCKED vendor (no credentials email), creates contract, emails signing link
//   { action: "decline", reason? }             — any stage
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const action = String(body.action || "");
  const app = await db.vendorApplication.findUnique({ where: { id: params.id } });
  if (!app) return NextResponse.json({ error: "Not found." }, { status: 404 });

  if (action === "save_notes") {
    const updated = await db.vendorApplication.update({ where: { id: app.id }, data: { adminNotes: String(body.notes ?? "").slice(0, 5000) } });
    return NextResponse.json({ application: updated });
  }

  if (action === "mark_called") {
    const updated = await db.vendorApplication.update({ where: { id: app.id }, data: { stage: "CALLED" } });
    return NextResponse.json({ application: updated });
  }

  if (action === "schedule_viewing") {
    const when = String(body.when || "").trim().slice(0, 120);
    if (!when) return NextResponse.json({ error: "Enter a date/time for the viewing." }, { status: 400 });
    const updated = await db.vendorApplication.update({ where: { id: app.id }, data: { stage: "VIEWING", viewingAt: when } });
    try { await sendViewingEmail(app.email, app.contactName, app.businessName, when); } catch {}
    return NextResponse.json({ application: updated });
  }

  if (action === "create_contract") {
    const boothLabel = String(body.boothLabel || "").trim().slice(0, 40);
    const rentDollars = Number(body.rentDollars);
    const startDate = String(body.startDate || "").trim();
    if (!boothLabel || !Number.isFinite(rentDollars) || rentDollars <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      return NextResponse.json({ error: "Booth label, rent, and start date (YYYY-MM-DD) are required." }, { status: 400 });
    }

    // vendor account: created LOCKED — no credentials until the contract is fully signed
    let vendor = await db.vendor.findFirst({ where: { email: { equals: app.email, mode: "insensitive" } } });
    if (!vendor) {
      const count = await db.vendor.count();
      const code = `V${String(count + 1).padStart(2, "0")}`;
      vendor = await db.vendor.create({
        data: {
          code,
          businessName: app.businessName.trim(),
          contactName: (app.contactName || "").trim(),
          email: app.email.toLowerCase().trim(),
          phone: (app.phone || "").trim(),
          passwordHash: hashPassword(randomBytes(16).toString("hex")), // unusable until execution issues real credentials
          mustChangePassword: true,
          commissionPercent: 0,
          portalLocked: true,
        },
      });
    }

    const start = new Date(`${startDate}T12:00:00`);
    const contract = await db.contract.create({
      data: { vendorId: vendor.id, boothLabel, monthlyRentCents: Math.round(rentDollars * 100), startDate: start },
    });
    const token = randomBytes(16).toString("hex");
    await db.contract.update({ where: { id: contract.id }, data: { signToken: token } });

    await db.vendorApplication.update({ where: { id: app.id }, data: { status: "ACCEPTED", stage: "CONTRACT", decidedAt: new Date() } });

    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    try { await sendApplicationDecisionEmail(app.email, app.contactName, app.businessName, true, ""); } catch {}
    try { await sendContractSignEmail(vendor.email, vendor.businessName, `${base}/sign/${token}`); } catch {}

    return NextResponse.json({ ok: true, vendor: { id: vendor.id, code: vendor.code }, contractId: contract.id });
  }

  if (action === "decline") {
    const updated = await db.vendorApplication.update({ where: { id: app.id }, data: { status: "DECLINED", stage: "DONE", decidedAt: new Date() } });
    try { await sendApplicationDecisionEmail(app.email, app.contactName, app.businessName, false, String(body.reason || "").trim().slice(0, 500)); } catch {}
    return NextResponse.json({ application: updated });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

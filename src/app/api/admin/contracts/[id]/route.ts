import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { sendContractSignEmail, sendSetupGuideEmail, sendRentLinkEmail, sendAgreementReminderEmail } from "@/lib/email";
import { randomBytes } from "crypto";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const { action, monthlyRentDollars, boothLabel } = body as { action?: string; monthlyRentDollars?: number; boothLabel?: string };

  const contract = await db.contract.findUnique({ where: { id: params.id } });
  if (!contract) return NextResponse.json({ error: "Contract not found." }, { status: 404 });

  if (action === "send_for_signature") {
    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    let token = contract.signToken;
    if (!token) {
      token = randomBytes(16).toString("hex");
      await db.contract.update({ where: { id: contract.id }, data: { signToken: token } });
    }
    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    try {
      await sendContractSignEmail(vendor.email, vendor.businessName, `${base}/sign/${token}`);
    } catch {
      return NextResponse.json({ error: "Email failed to send — check the vendor's email address." }, { status: 500 });
    }
    return NextResponse.json({ ok: true, sentTo: vendor.email });
  }

  if (action === "send_rent_link") {
    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    if (!contract.vendorSignedAt || !contract.marketSignedAt) return NextResponse.json({ error: "Contract must be fully signed first — rent posts on execution." }, { status: 400 });
    let token = contract.signToken;
    if (!token) {
      token = randomBytes(16).toString("hex");
      await db.contract.update({ where: { id: contract.id }, data: { signToken: token } });
    }
    const agg = await db.ledgerEntry.aggregate({ where: { vendorId: vendor.id }, _sum: { amountCents: true } });
    const balance = agg._sum.amountCents || 0;
    const dueCents = balance < 0 ? -balance : 0;
    const feeCents = Math.round((dueCents * 3) / 100);
    try {
      await sendRentLinkEmail(vendor.email, vendor.businessName, contract.boothLabel, dueCents, feeCents, token);
    } catch {
      return NextResponse.json({ error: "Email failed to send." }, { status: 500 });
    }
    return NextResponse.json({ ok: true, sentTo: vendor.email, dueCents });
  }

  if (action === "send_setup_guide") {
    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    const app = await db.vendorApplication.findFirst({ where: { email: { equals: vendor.email, mode: "insensitive" } }, orderBy: { createdAt: "desc" } });
    try {
      await sendSetupGuideEmail(vendor.email, vendor.businessName, app?.phoneType || "");
    } catch {
      return NextResponse.json({ error: "Email failed to send." }, { status: 500 });
    }
    return NextResponse.json({ ok: true, sentTo: vendor.email });
  }

  if (action === "give_notice") {
    const nd = typeof (body as { noticeDate?: string }).noticeDate === "string" && (body as { noticeDate: string }).noticeDate
      ? new Date((body as { noticeDate: string }).noticeDate + "T12:00:00")
      : new Date();
    if (isNaN(nd.getTime())) return NextResponse.json({ error: "Bad notice date." }, { status: 400 });
    const endDate = new Date(nd.getTime() + 30 * 24 * 60 * 60 * 1000);
    const dim = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).getDate();
    const finalRentCents = Math.round((contract.monthlyRentCents * endDate.getDate()) / dim);
    const updated = await db.contract.update({
      where: { id: contract.id },
      data: { status: "TERMINATING", noticeGivenAt: nd, endDate },
    });
    return NextResponse.json({ contract: updated, finalRentCents });
  }

  if (action === "end_now") {
    const updated = await db.contract.update({
      where: { id: contract.id },
      data: { status: "ENDED", endDate: new Date() },
    });
    return NextResponse.json({ contract: updated });
  }

  // ---- nudge an agreement that's been sent but not signed -------------------
  if (action === "send_reminder") {
    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    if (contract.vendorSignedAt) {
      return NextResponse.json({ error: "They've already signed — nothing to remind them about." }, { status: 400 });
    }
    let token = contract.signToken;
    if (!token) {
      token = randomBytes(16).toString("hex");
      await db.contract.update({ where: { id: contract.id }, data: { signToken: token } });
    }
    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    const days = Math.max(
      0,
      Math.round((Date.now() - new Date(contract.createdAt).getTime()) / 86_400_000)
    );
    try {
      await sendAgreementReminderEmail(
        vendor.email, vendor.businessName, `${base}/sign/${token}`,
        contract.boothLabel, contract.monthlyRentCents, days
      );
    } catch {
      return NextResponse.json({ error: "Email failed to send — check their email address." }, { status: 500 });
    }
    return NextResponse.json({ ok: true, sentTo: vendor.email });
  }

  // ---- edit the terms of an agreement nobody has signed yet -----------------
  if (action === "update_terms") {
    if (contract.vendorSignedAt) {
      return NextResponse.json(
        { error: "They've already signed this one. Void it and send a fresh agreement instead of changing signed terms." },
        { status: 400 }
      );
    }
    if (contract.status === "ENDED" || contract.status === "VOIDED") {
      return NextResponse.json({ error: "This agreement is closed — create a new one." }, { status: 400 });
    }

    const data: { boothLabel?: string; monthlyRentCents?: number; startDate?: Date } = {};

    if (typeof boothLabel === "string") {
      const b = boothLabel.trim().slice(0, 40);
      if (!b) return NextResponse.json({ error: "Booth label can't be blank." }, { status: 400 });
      data.boothLabel = b;
    }
    if (monthlyRentDollars !== undefined) {
      const rent = Math.round(Number(monthlyRentDollars) * 100);
      if (!Number.isFinite(rent) || rent < 0) return NextResponse.json({ error: "Rent has to be a number, zero or more." }, { status: 400 });
      if (rent > 100_000_00) return NextResponse.json({ error: "That rent looks wrong — check the amount." }, { status: 400 });
      data.monthlyRentCents = rent;
    }
    const sd = (body as { startDate?: string }).startDate;
    if (typeof sd === "string" && sd.trim()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sd.trim())) return NextResponse.json({ error: "Start date must be YYYY-MM-DD." }, { status: 400 });
      const d = new Date(`${sd.trim()}T12:00:00`);
      if (isNaN(d.getTime())) return NextResponse.json({ error: "That start date isn't valid." }, { status: 400 });
      data.startDate = d;
    }

    if (!Object.keys(data).length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

    const updated = await db.contract.update({ where: { id: contract.id }, data });
    return NextResponse.json({ contract: updated });
  }

  // ---- they signed, terms were wrong: void it and issue a corrected one -----
  if (action === "void_and_reissue") {
    if (contract.marketSignedAt) {
      return NextResponse.json({ error: "This agreement is fully executed. Use 30-day notice to end it." }, { status: 400 });
    }
    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });

    const b = typeof boothLabel === "string" && boothLabel.trim()
      ? boothLabel.trim().slice(0, 40)
      : contract.boothLabel;
    const rent = monthlyRentDollars !== undefined
      ? Math.round(Number(monthlyRentDollars) * 100)
      : contract.monthlyRentCents;
    if (!Number.isFinite(rent) || rent < 0) return NextResponse.json({ error: "Rent has to be a number, zero or more." }, { status: 400 });

    const sd2 = (body as { startDate?: string }).startDate;
    let start = contract.startDate;
    if (typeof sd2 === "string" && sd2.trim()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sd2.trim())) return NextResponse.json({ error: "Start date must be YYYY-MM-DD." }, { status: 400 });
      const d = new Date(`${sd2.trim()}T12:00:00`);
      if (isNaN(d.getTime())) return NextResponse.json({ error: "That start date isn't valid." }, { status: 400 });
      start = d;
    }

    // The old one is kept, marked VOIDED, with its signature intact as a record
    // of what they agreed to. The replacement starts clean and unsigned.
    const [, replacement] = await db.$transaction([
      db.contract.update({
        where: { id: contract.id },
        data: { status: "VOIDED", endDate: new Date() },
      }),
      db.contract.create({
        data: { vendorId: contract.vendorId, boothLabel: b, monthlyRentCents: rent, startDate: start, signToken: randomBytes(16).toString("hex") },
      }),
    ]);

    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    let emailed = false;
    try {
      await sendContractSignEmail(vendor.email, vendor.businessName, `${base}/sign/${replacement.signToken}`);
      emailed = true;
    } catch { /* the replacement exists either way — surface it below */ }

    return NextResponse.json({
      contract: replacement,
      emailed,
      sentTo: vendor.email,
      signUrl: `${base}/sign/${replacement.signToken}`,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { sendPreorderAcceptedEmail, sendThreadLinkEmail } from "@/lib/email";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

// POST { action: "accept", description, subtotalDollars, expectedDate } | { action: "decline", reason }
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const thread = await db.thread.findFirst({ where: { id: params.id, vendorId } });
  if (!thread) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (thread.type !== "PREORDER") return NextResponse.json({ error: "Only pre-order conversations can be accepted or declined." }, { status: 400 });
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const body = await req.json();

  if (body.action === "decline") {
    const reason = (body.reason || "").trim();
    if (!reason) return NextResponse.json({ error: "Give the customer a short reason." }, { status: 400 });
    const existing = await db.preOrder.findUnique({ where: { threadId: thread.id } });
    if (existing?.status === "PAID") return NextResponse.json({ error: "Already paid — can't decline now. Refund it from the register tickets instead." }, { status: 400 });
    if (existing) await db.preOrder.update({ where: { id: existing.id }, data: { status: "DECLINED" } });
    await db.threadMsg.create({ data: { threadId: thread.id, sender: "VENDOR", body: `❌ Pre-order declined: ${reason.slice(0, 500)}` } });
    await db.thread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
    try { await sendThreadLinkEmail(thread.email, thread.customerName, vendor.businessName, thread.type, thread.token, true); } catch {}
    return NextResponse.json({ ok: true, declined: true });
  }

  if (body.action === "accept") {
    const desc = (body.description || "").trim();
    const expectedDate = (body.expectedDate || "").trim();
    const subtotalCents = Math.round(Number(body.subtotalDollars) * 100);
    if (!desc || !expectedDate || isNaN(subtotalCents) || subtotalCents <= 0) {
      return NextResponse.json({ error: "Description, amount, and expected date are all needed." }, { status: 400 });
    }
    const existing = await db.preOrder.findUnique({ where: { threadId: thread.id } });
    if (existing?.status === "PAID") return NextResponse.json({ error: "This one's already paid." }, { status: 400 });

    const setting = await db.setting.findUnique({ where: { key: "taxRatePercent" } });
    const taxRate = setting ? Number(setting.value) : 0;
    const taxCents = Math.round((subtotalCents * taxRate) / 100);
    const totalCents = subtotalCents + taxCents;
    const token = existing?.token || randomBytes(16).toString("hex");

    const po = existing
      ? await db.preOrder.update({
          where: { id: existing.id },
          data: { description: desc.slice(0, 300), subtotalCents, taxCents, totalCents, expectedDate: expectedDate.slice(0, 60), status: "ACCEPTED", stripeSessionId: "" },
        })
      : await db.preOrder.create({
          data: {
            threadId: thread.id, vendorId, description: desc.slice(0, 300),
            subtotalCents, taxCents, totalCents, expectedDate: expectedDate.slice(0, 60), token,
          },
        });

    await db.threadMsg.create({
      data: { threadId: thread.id, sender: "VENDOR", body: `✅ Accepted! ${desc} — $${(totalCents / 100).toFixed(2)} total (tax included). Expected: ${expectedDate}. A secure payment link was emailed to you.` },
    });
    await db.thread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
    try {
      await sendPreorderAcceptedEmail(thread.email, thread.customerName, vendor.businessName, desc, totalCents, expectedDate, po.token, thread.token);
    } catch (err) { console.error("accept email failed", err); }
    return NextResponse.json({ ok: true, preorder: { status: po.status, totalCents, taxCents, expectedDate: po.expectedDate, payUrl: `/pay/${po.token}` } });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const po = await db.preOrder.findFirst({ where: { threadId: params.id, vendorId } });
  return NextResponse.json({ preorder: po ? { status: po.status, description: po.description, subtotalCents: po.subtotalCents, taxCents: po.taxCents, totalCents: po.totalCents, expectedDate: po.expectedDate, payUrl: `/pay/${po.token}` } : null });
}

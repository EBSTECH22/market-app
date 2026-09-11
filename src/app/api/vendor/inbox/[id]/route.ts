import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { sendThreadLinkEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const thread = await db.thread.findFirst({
    where: { id: params.id, vendorId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!thread) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ thread });
}

// POST { body } reply · PATCH { status } open/close
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const { body } = await req.json();
  const b = (body || "").trim();
  if (!b) return NextResponse.json({ error: "Write a reply first." }, { status: 400 });
  const thread = await db.thread.findFirst({ where: { id: params.id, vendorId } });
  if (!thread) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const msg = await db.threadMsg.create({ data: { threadId: thread.id, sender: "VENDOR", body: b.slice(0, 3000) } });
  await db.thread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  try {
    await sendThreadLinkEmail(thread.email, thread.customerName, vendor?.businessName || "The vendor", thread.type, thread.token, true);
  } catch (err) { console.error("customer reply email failed", err); }
  return NextResponse.json({ msg });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const { status } = await req.json();
  if (!["OPEN", "CLOSED"].includes(status)) return NextResponse.json({ error: "Bad status." }, { status: 400 });
  const thread = await db.thread.findFirst({ where: { id: params.id, vendorId } });
  if (!thread) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await db.thread.update({ where: { id: thread.id }, data: { status } });
  return NextResponse.json({ ok: true });
}

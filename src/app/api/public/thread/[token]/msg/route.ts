import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendVendorInboxEmail } from "@/lib/email";
import { pushToVendor } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const { body, website } = await req.json();
  if (website) return NextResponse.json({ ok: true });
  const thread = await db.thread.findUnique({ where: { token: params.token } });
  if (!thread) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  if (thread.status === "CLOSED") return NextResponse.json({ error: "This conversation was closed by the vendor." }, { status: 400 });
  const b = (body || "").trim();
  if (!b) return NextResponse.json({ error: "Write something first." }, { status: 400 });

  const msg = await db.threadMsg.create({ data: { threadId: thread.id, sender: "CUSTOMER", body: b.slice(0, 3000) } });
  await db.thread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });

  const vendor = await db.vendor.findUnique({ where: { id: thread.vendorId } });
  if (vendor) {
    try {
      const pushed = await pushToVendor(vendor.id, "New message 📩", `${thread.customerName}: ${b.slice(0, 90)}`);
      if (pushed === 0) await sendVendorInboxEmail(vendor, thread.type, thread.customerName);
    } catch (err) { console.error("vendor notify failed", err); }
  }
  return NextResponse.json({ msg });
}

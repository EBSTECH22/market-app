import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendThreadLinkEmail, sendVendorInboxEmail } from "@/lib/email";
import { pushToVendor } from "@/lib/push";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { PREORDER: "Pre-order", REQUEST: "Request", COMPLAINT: "Complaint" };

export async function POST(req: NextRequest, { params }: { params: { code: string } }) {
  const { type, name, email, phone, body, website } = await req.json();
  if (website) return NextResponse.json({ ok: true }); // honeypot
  const vendor = await db.vendor.findFirst({ where: { code: params.code.toUpperCase(), active: true } });
  if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });

  if (!["PREORDER", "REQUEST", "COMPLAINT"].includes(type)) return NextResponse.json({ error: "Bad type." }, { status: 400 });
  if (type === "PREORDER" && !vendor.acceptsPreorders) return NextResponse.json({ error: "This vendor isn't taking pre-orders right now." }, { status: 400 });
  if (type === "REQUEST" && !vendor.acceptsRequests) return NextResponse.json({ error: "This vendor isn't taking requests right now." }, { status: 400 });

  const n = (name || "").trim(), e = (email || "").trim(), p = (phone || "").trim(), b = (body || "").trim();
  if (!n || !b) return NextResponse.json({ error: "Name and message are needed." }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return NextResponse.json({ error: "A real email is needed — replies go there." }, { status: 400 });
  if (p.replace(/\D/g, "").length < 10) return NextResponse.json({ error: "A phone number is needed." }, { status: 400 });

  const token = randomBytes(16).toString("hex");
  const thread = await db.thread.create({
    data: {
      vendorId: vendor.id, type, customerName: n.slice(0, 60), email: e.slice(0, 120), phone: p.slice(0, 25), token,
      messages: { create: { sender: "CUSTOMER", body: b.slice(0, 3000) } },
    },
  });

  try { await sendThreadLinkEmail(e, n, vendor.businessName, type, token, false); } catch (err) { console.error("cust email failed", err); }
  try {
    const pushed = await pushToVendor(vendor.id, `New ${LABEL[type].toLowerCase()} 📩`, `${n}: ${b.slice(0, 90)}`);
    if (pushed === 0) await sendVendorInboxEmail(vendor, type, n);
  } catch (err) { console.error("vendor notify failed", err); }

  return NextResponse.json({ ok: true, token: thread.token });
}

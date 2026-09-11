import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendApplicationReceivedEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const b = await req.json();
  if (b.website) return NextResponse.json({ ok: true }); // honeypot
  const need = (v: unknown) => String(v || "").trim();
  const businessName = need(b.businessName), contactName = need(b.contactName);
  const email = need(b.email), phone = need(b.phone), products = need(b.products), madeByYou = need(b.madeByYou);
  if (!businessName || !contactName || !products || !madeByYou) {
    return NextResponse.json({ error: "Business name, your name, what you sell, and who makes it are all required." }, { status: 400 });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "A real email is needed." }, { status: 400 });
  if (phone.replace(/\D/g, "").length < 10) return NextResponse.json({ error: "A phone number is needed — we call accepted vendors." }, { status: 400 });

  await db.vendorApplication.create({
    data: {
      businessName: businessName.slice(0, 100), contactName: contactName.slice(0, 80),
      email: email.slice(0, 120), phone: phone.slice(0, 25),
      category: need(b.category).slice(0, 60), products: products.slice(0, 2000),
      madeByYou: madeByYou.slice(0, 500), links: need(b.links).slice(0, 500),
      licenses: need(b.licenses).slice(0, 500), insurance: need(b.insurance).slice(0, 200),
      availability: need(b.availability).slice(0, 300), boothRequest: need(b.boothRequest).slice(0, 120),
      heardFrom: need(b.heardFrom).slice(0, 200),
      notes: need(b.notes).slice(0, 1000),
    },
  });
  try { await sendApplicationReceivedEmail(email, contactName, businessName); } catch (err) { console.error("app email failed", err); }
  return NextResponse.json({ ok: true });
}

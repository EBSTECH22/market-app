import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendApplicationReceivedEmail } from "@/lib/email";
import { pushToAdmin } from "@/lib/push";
import { waitlisted, termsLabel } from "@/lib/spaces";

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

  /* Which space they asked for, and whether that one is taking names rather
     than bookings. Read from the table at the moment they apply — a booth that
     went this morning must not be promised this afternoon. Applying is never
     refused: a full offer puts them on the waiting list instead. */
  const spaceKey = String(b.spaceKey || "").trim().slice(0, 40).toUpperCase();
  const offer = spaceKey ? await db.spaceOffer.findFirst({ where: { key: spaceKey, active: true } }) : null;
  const onWaitlist = !!offer && waitlisted(offer);

  const app = await db.vendorApplication.create({
    data: {
      businessName: businessName.slice(0, 100), contactName: contactName.slice(0, 80),
      email: email.slice(0, 120), phone: phone.slice(0, 25),
      category: need(b.category).slice(0, 60), products: products.slice(0, 2000),
      madeByYou: madeByYou.slice(0, 500), links: need(b.links).slice(0, 500),
      licenses: need(b.licenses).slice(0, 500), insurance: need(b.insurance).slice(0, 200),
      availability: need(b.availability).slice(0, 300), boothRequest: need(b.boothRequest).slice(0, 120),
      heardFrom: need(b.heardFrom).slice(0, 200),
      phoneType: ["IPHONE", "ANDROID", "OTHER"].includes(String(b.phoneType || "").toUpperCase()) ? String(b.phoneType).toUpperCase() : "",
      notes: need(b.notes).slice(0, 1000),
      spaceKey: offer ? offer.key : "",
      status: onWaitlist ? "WAITLIST" : "PENDING",
    },
  });

  /* Their place in the queue: everyone waiting for the same thing who applied
     before them, plus one. Worked out from the times rather than stored, so it
     stays right when somebody ahead is accepted or withdraws. */
  let position = 0;
  if (onWaitlist && offer) {
    position = 1 + (await db.vendorApplication.count({
      where: { spaceKey: offer.key, status: "WAITLIST", createdAt: { lt: app.createdAt } },
    }));
  }
  try {
    await sendApplicationReceivedEmail(email, contactName, businessName, {
      spaceName: offer ? offer.name : "",
      terms: offer ? termsLabel(offer) : "",
      waitlistPosition: onWaitlist ? position : 0,
    });
  } catch (err) { console.error("app email failed", err); }
  try {
    await pushToAdmin(
      onWaitlist ? "Waiting list: new application \u23f3" : "New vendor application \ud83d\udccb",
      `${businessName} — ${contactName}${offer ? ` · ${offer.name}` : ""}${onWaitlist ? ` · #${position} waiting` : ""}`
    );
  } catch {}
  return NextResponse.json({
    ok: true,
    waitlisted: onWaitlist,
    position,
    spaceName: offer ? offer.name : "",
  });
}

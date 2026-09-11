import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { tentSpotsTaken, TENT_DEPOSIT_CENTS } from "@/lib/tents";
import { sendTentConfirmEmail } from "@/lib/email";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

// GET: open future dates with remaining spots
export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  const dates = await db.tentDate.findMany({
    where: { open: true, date: { gte: today } },
    include: { bookings: true },
    orderBy: { date: "asc" },
    take: 90,
  });
  return NextResponse.json({
    dates: dates
      .map((d) => ({ id: d.id, date: d.date, spotsLeft: Math.max(0, d.capacity - tentSpotsTaken(d.bookings)) }))
      .filter((d) => d.spotsLeft > 0),
  });
}

// POST { dateId, name, businessName, email, phone, creditToken? } → checkout url, or instant book on credit
export async function POST(req: NextRequest) {
  const { dateId, name, businessName, email, phone, creditToken, website } = await req.json();
  if (website) return NextResponse.json({ ok: true });
  const d = await db.tentDate.findUnique({ where: { id: dateId }, include: { bookings: true } });
  if (!d || !d.open) return NextResponse.json({ error: "That date isn't available." }, { status: 400 });
  if (d.capacity - tentSpotsTaken(d.bookings) <= 0) return NextResponse.json({ error: "That date just filled up — pick another." }, { status: 400 });

  // weather-credit rebooking: no new charge
  if (creditToken) {
    const credit = await db.tentBooking.findUnique({ where: { token: creditToken } });
    if (!credit || credit.status !== "WEATHER_CREDIT") return NextResponse.json({ error: "That credit link isn't valid (already used?)." }, { status: 400 });
    const token = randomBytes(16).toString("hex");
    const nb = await db.tentBooking.create({
      data: {
        dateId: d.id, name: credit.name, businessName: credit.businessName, email: credit.email, phone: credit.phone,
        status: "PAID_DEPOSIT", token, creditFromId: credit.id,
      },
    });
    await db.tentBooking.update({ where: { id: credit.id }, data: { status: "CREDIT_USED" } });
    try { await sendTentConfirmEmail(nb.email, nb.name, d.date, nb.token, true); } catch {}
    return NextResponse.json({ booked: true, date: d.date });
  }

  const n = (name || "").trim(), e = (email || "").trim(), p = (phone || "").trim();
  if (!n) return NextResponse.json({ error: "Your name is needed." }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return NextResponse.json({ error: "A real email is needed — your confirmation goes there." }, { status: 400 });
  if (p.replace(/\D/g, "").length < 10) return NextResponse.json({ error: "A phone number is needed." }, { status: 400 });
  if (!stripe) return NextResponse.json({ error: "Online booking isn't configured — call the market to book." }, { status: 500 });

  const token = randomBytes(16).toString("hex");
  const booking = await db.tentBooking.create({
    data: { dateId: d.id, name: n.slice(0, 60), businessName: (businessName || "").trim().slice(0, 100), email: e.slice(0, 120), phone: p.slice(0, 25), token },
  });
  const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: `Outdoor tent deposit — ${d.date}`, description: "Community Harvest tent spot deposit. $12.50 balance due at setup ($25/day). Weather day = full credit to a future date." },
        unit_amount: TENT_DEPOSIT_CENTS,
      },
      quantity: 1,
    }],
    metadata: { app: "community-harvest-market", tentBookingId: booking.id },
    success_url: `${base}/tents?manage=${token}&done=1`,
    cancel_url: `${base}/tents`,
  });
  await db.tentBooking.update({ where: { id: booking.id }, data: { stripeSessionId: session.id } });
  return NextResponse.json({ url: session.url });
}

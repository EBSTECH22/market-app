import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { tentSpotsTaken, TENT_DEPOSIT_CENTS } from "@/lib/tents";
import { sendTentConfirmEmail } from "@/lib/email";
import { pushToAdmin } from "@/lib/push";
import { runRoute, HttpError } from "@/lib/handler";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

async function tentPause(): Promise<{ paused: boolean; message: string }> {
  const row = await db.setting.findUnique({ where: { key: "tentsPaused" } });
  if (!row) return { paused: false, message: "" };
  try { const v = JSON.parse(row.value); return { paused: !!v.paused, message: String(v.message || "") }; }
  catch { return { paused: false, message: "" }; }
}

// GET: open future dates with remaining spots
export async function GET() {
  const pause = await tentPause();
  if (pause.paused) return NextResponse.json({ paused: true, message: pause.message, dates: [] });
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

const FULL_MSG = "That date just filled up — pick another.";

// POST { dateId, name, businessName, email, phone, creditToken? } → checkout url, or instant book on credit
export async function POST(req: NextRequest) {
  return runRoute("public/tents POST", async () => {
  const { dateId, name, businessName, email, phone, creditToken, website } = await req.json();
  if (website) return NextResponse.json({ ok: true });
  const pause = await tentPause();
  if (pause.paused) return NextResponse.json({ error: "Tent bookings are paused right now — check back soon." }, { status: 400 });
  const d = await db.tentDate.findUnique({ where: { id: dateId }, include: { bookings: true } });
  if (!d || !d.open) return NextResponse.json({ error: "That date isn't available." }, { status: 400 });
  if (d.capacity - tentSpotsTaken(d.bookings) <= 0) return NextResponse.json({ error: FULL_MSG }, { status: 400 });

  // weather-credit rebooking: no new charge
  if (creditToken) {
    // read-check-create in one transaction: without it two people holding
    // credits could both pass the capacity check and both take the last spot.
    const nb = await db.$transaction(async (tx) => {
      const fresh = await tx.tentDate.findUnique({ where: { id: d.id }, include: { bookings: true } });
      if (!fresh || !fresh.open) throw new HttpError(400, "That date isn't available.");
      if (fresh.capacity - tentSpotsTaken(fresh.bookings) <= 0) throw new HttpError(400, FULL_MSG);

      // consume the credit conditionally, so one credit link can't book twice
      const consumed = await tx.tentBooking.updateMany({
        where: { token: creditToken, status: "WEATHER_CREDIT" },
        data: { status: "CREDIT_USED" },
      });
      if (consumed.count === 0) throw new HttpError(400, "That credit link isn't valid (already used?).");
      const credit = await tx.tentBooking.findUnique({ where: { token: creditToken } });
      if (!credit) throw new HttpError(400, "That credit link isn't valid (already used?).");

      const token = randomBytes(16).toString("hex");
      return tx.tentBooking.create({
        data: {
          dateId: fresh.id, name: credit.name, businessName: credit.businessName, email: credit.email, phone: credit.phone,
          status: "PAID_DEPOSIT", token, creditFromId: credit.id,
        },
      });
    });
    try { await sendTentConfirmEmail(nb.email, nb.name, d.date, nb.token, true); } catch {}
    try { await pushToAdmin("Tent rebooked ⛺", `${nb.businessName || nb.name} — ${d.date} (weather credit)`); } catch {}
    return NextResponse.json({ booked: true, date: d.date });
  }

  const n = (name || "").trim(), e = (email || "").trim(), p = (phone || "").trim();
  if (!n) return NextResponse.json({ error: "Your name is needed." }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return NextResponse.json({ error: "A real email is needed — your confirmation goes there." }, { status: 400 });
  if (p.replace(/\D/g, "").length < 10) return NextResponse.json({ error: "A phone number is needed." }, { status: 400 });
  if (!stripe) return NextResponse.json({ error: "Online booking isn't configured — call the market to book." }, { status: 500 });

  const token = randomBytes(16).toString("hex");
  const booking = await db.$transaction(async (tx) => {
    const fresh = await tx.tentDate.findUnique({ where: { id: d.id }, include: { bookings: true } });
    if (!fresh || !fresh.open) throw new HttpError(400, "That date isn't available.");
    if (fresh.capacity - tentSpotsTaken(fresh.bookings) <= 0) throw new HttpError(400, FULL_MSG);
    return tx.tentBooking.create({
      data: { dateId: fresh.id, name: n.slice(0, 60), businessName: (businessName || "").trim().slice(0, 100), email: e.slice(0, 120), phone: p.slice(0, 25), token },
    });
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
  });
}

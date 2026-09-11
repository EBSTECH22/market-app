import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { reconcileTents } from "@/lib/tents";
import { sendTentWeatherCreditEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await reconcileTents().catch(() => {});
  const today = new Date().toISOString().slice(0, 10);
  const dates = await db.tentDate.findMany({
    where: { date: { gte: today } },
    include: { bookings: { orderBy: { createdAt: "asc" } } },
    orderBy: { date: "asc" },
    take: 120,
  });
  return NextResponse.json({ dates });
}

// POST — { action: "openDates", dates: ["YYYY-MM-DD"...], capacity } | { action: "toggle", dateId, open } |
//        { action: "capacity", dateId, capacity } | { action: "checkin", bookingId } |
//        { action: "weatherDay", dateId } | { action: "cancelBooking", bookingId }
export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json();

  if (b.action === "openDates") {
    const cap = Math.max(1, Math.min(20, Number(b.capacity) || 4));
    const list: string[] = (b.dates || []).filter((x: string) => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 62);
    for (const date of list) {
      await db.tentDate.upsert({ where: { date }, create: { date, capacity: cap, open: true }, update: { open: true, capacity: cap } });
    }
    return NextResponse.json({ ok: true, opened: list.length });
  }
  if (b.action === "toggle") {
    await db.tentDate.update({ where: { id: b.dateId }, data: { open: !!b.open } });
    return NextResponse.json({ ok: true });
  }
  if (b.action === "capacity") {
    const cap = Math.max(1, Math.min(20, Number(b.capacity) || 4));
    await db.tentDate.update({ where: { id: b.dateId }, data: { capacity: cap } });
    return NextResponse.json({ ok: true });
  }
  if (b.action === "checkin") {
    const bk = await db.tentBooking.findUnique({ where: { id: b.bookingId } });
    if (!bk || bk.status !== "PAID_DEPOSIT") return NextResponse.json({ error: "Only deposit-paid bookings check in." }, { status: 400 });
    await db.tentBooking.update({ where: { id: bk.id }, data: { status: "CHECKED_IN" } });
    return NextResponse.json({ ok: true });
  }
  if (b.action === "cancelBooking") {
    await db.tentBooking.update({ where: { id: b.bookingId }, data: { status: "CANCELED" } });
    return NextResponse.json({ ok: true });
  }
  if (b.action === "weatherDay") {
    const d = await db.tentDate.findUnique({ where: { id: b.dateId }, include: { bookings: true } });
    if (!d) return NextResponse.json({ error: "Not found." }, { status: 404 });
    let converted = 0;
    for (const bk of d.bookings) {
      if (bk.status === "PAID_DEPOSIT" || bk.status === "CHECKED_IN") {
        await db.tentBooking.update({ where: { id: bk.id }, data: { status: "WEATHER_CREDIT" } });
        try { await sendTentWeatherCreditEmail(bk.email, bk.name, d.date, bk.token); } catch {}
        converted++;
      }
    }
    await db.tentDate.update({ where: { id: d.id }, data: { open: false } });
    return NextResponse.json({ ok: true, converted });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

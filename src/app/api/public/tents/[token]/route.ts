import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { finalizeTentIfPaid } from "@/lib/tents";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const b = await db.tentBooking.findUnique({ where: { token: params.token }, include: { date: true } });
  if (!b) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  if (b.status === "RESERVED" && b.stripeSessionId) await finalizeTentIfPaid(b.id);
  const fresh = await db.tentBooking.findUnique({ where: { token: params.token }, include: { date: true } });
  return NextResponse.json({ booking: { status: fresh!.status, date: fresh!.date.date, name: fresh!.name } });
}

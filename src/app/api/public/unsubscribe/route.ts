import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Unsubscribing is a state change, so it needs an explicit POST.
 *
 * It used to happen as a side effect of rendering GET /u/[token], which meant
 * an email-link scanner or a browser prefetch silently unsubscribed people who
 * never clicked anything. The page now asks first and calls this.
 */
export async function POST(req: NextRequest) {
  let token = "";
  try {
    const body = await req.json();
    token = String(body?.token || "").slice(0, 200);
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }
  if (!token) return NextResponse.json({ error: "Missing unsubscribe token." }, { status: 400 });

  const customer = await db.customer.findUnique({ where: { token } });
  if (!customer) {
    return NextResponse.json({ error: "This unsubscribe link doesn't match anyone." }, { status: 404 });
  }
  if (!customer.unsubscribed) {
    await db.customer.update({ where: { id: customer.id }, data: { unsubscribed: true } });
  }
  return NextResponse.json({ ok: true, alreadyUnsubscribed: customer.unsubscribed });
}

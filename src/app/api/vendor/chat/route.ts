import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { pushToVendors, pushToAdmin } from "@/lib/push";
import { afterResponse } from "@/lib/after";

export const dynamic = "force-dynamic";

export async function GET() {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  /* The NEWEST 200, shown oldest-first. (Taking the first 200 ascending meant
     that once the board passed 200 messages, new ones never appeared.) */
  const msgs = (await db.vendorChatMsg.findMany({ orderBy: { createdAt: "desc" }, take: 200 })).reverse();
  const vendors = await db.vendor.findMany({ select: { id: true, businessName: true } });
  const vmap = Object.fromEntries(vendors.map((v) => [v.id, v.businessName]));
  /* The office posts here as "MARKET". */
  return NextResponse.json({ me: vendorId, messages: msgs.map((m) => ({ id: m.id, vendorId: m.vendorId, name: m.vendorId === "MARKET" ? "Community Harvest" : vmap[m.vendorId] || "Vendor", body: m.body, createdAt: m.createdAt })) });
}

export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const body = String((await req.json()).body || "").trim().slice(0, 1000);
  if (!body) return NextResponse.json({ error: "Empty message." }, { status: 400 });
  const msg = await db.vendorChatMsg.create({ data: { vendorId, body } });
  /* Everyone else at the market hears about it — the office too. */
  const [me, others] = await Promise.all([
    db.vendor.findUnique({ where: { id: vendorId }, select: { businessName: true } }),
    db.vendor.findMany({ where: { active: true, id: { not: vendorId } }, select: { id: true } }),
  ]);
  const who = me?.businessName || "A vendor";
  await afterResponse(Promise.all([
    pushToVendors(others.map((v) => v.id), `Vendor chat · ${who}`, body.slice(0, 180), { url: "/vendor#messages", tag: "board" }),
    pushToAdmin(`Vendor chat · ${who}`, body.slice(0, 180), { url: "/admin/messages", tag: "board" }),
  ]));
  return NextResponse.json({ message: msg });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { code: string } }) {
  const { name, rating, body, website } = await req.json();
  if (website) return NextResponse.json({ ok: true }); // honeypot: bots fill every field
  const vendor = await db.vendor.findFirst({ where: { code: params.code.toUpperCase(), active: true } });
  if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
  const r = Math.round(Number(rating));
  if (!name?.trim() || !body?.trim() || isNaN(r) || r < 1 || r > 5) {
    return NextResponse.json({ error: "Name, a 1-5 star rating, and your review are all needed." }, { status: 400 });
  }
  const review = await db.review.create({
    data: { vendorId: vendor.id, name: name.trim().slice(0, 60), rating: r, body: body.trim().slice(0, 2000) },
  });
  return NextResponse.json({ review });
}

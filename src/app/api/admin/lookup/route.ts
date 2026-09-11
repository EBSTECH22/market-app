import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sku = req.nextUrl.searchParams.get("sku")?.trim().toUpperCase();
  if (!sku) return NextResponse.json({ error: "No code." }, { status: 400 });

  const item = await db.item.findUnique({
    where: { sku },
    include: { vendor: { select: { businessName: true, code: true } } },
  });
  if (!item || !item.active) return NextResponse.json({ error: `No item found for ${sku}.` }, { status: 404 });
  return NextResponse.json({ item });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sale = await db.sale.findUnique({ where: { id: params.id }, include: { lines: true } });
  if (!sale) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ sale });
}

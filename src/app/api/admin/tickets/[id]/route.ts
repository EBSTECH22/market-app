import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isStaff } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sale = await db.sale.findUnique({ where: { id: params.id }, include: { lines: true } });
  if (!sale) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const refunds = await db.refund.findMany({ where: { saleId: sale.id } });
  const refunded: Record<string, number> = {};
  for (const r of refunds) {
    for (const pl of JSON.parse(r.linesJson || "[]") as { lineId: string; quantity: number }[]) {
      refunded[pl.lineId] = (refunded[pl.lineId] || 0) + pl.quantity;
    }
  }
  return NextResponse.json({ sale, refunded });
}

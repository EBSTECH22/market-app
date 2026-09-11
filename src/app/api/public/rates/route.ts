import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Public booth pricing so the application can quote custom sizes live
export async function GET() {
  const row = await db.setting.findUnique({ where: { key: "rentPerSqft" } });
  const v = row ? Number(row.value) : NaN;
  return NextResponse.json({ rentPerSqft: Number.isFinite(v) && v > 0 ? v : 6 });
}

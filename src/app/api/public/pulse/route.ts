import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const row = await db.setting.findUnique({ where: { key: "pulse" } });
  return NextResponse.json({ pulse: row?.value || "0" });
}

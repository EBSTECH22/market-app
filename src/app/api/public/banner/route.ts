import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const DEFAULTS = {
  enabled: true,
  title: "COMING SOON",
  dateLine: "EXPECTED GRAND OPENING — OCTOBER 15, 2026 · 8:00 AM",
  message: "Apply to get on the vendor list before the doors open.",
};

export async function GET() {
  const row = await db.setting.findUnique({ where: { key: "publicBanner" } });
  if (!row) return NextResponse.json({ banner: DEFAULTS });
  try {
    return NextResponse.json({ banner: { ...DEFAULTS, ...JSON.parse(row.value) } });
  } catch {
    return NextResponse.json({ banner: DEFAULTS });
  }
}

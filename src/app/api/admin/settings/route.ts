import { NextRequest, NextResponse } from "next/server";
import { isAdmin, isStaff } from "@/lib/auth";
import { getTaxRatePercent, setTaxRatePercent } from "@/lib/settings";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ taxRatePercent: await getTaxRatePercent() });
}

export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();

  if (body.banner !== undefined) {
    const b = body.banner || {};
    const banner = {
      enabled: !!b.enabled,
      title: String(b.title || "").slice(0, 60),
      dateLine: String(b.dateLine || "").slice(0, 120),
      message: String(b.message || "").slice(0, 200),
    };
    await db.setting.upsert({
      where: { key: "publicBanner" },
      create: { key: "publicBanner", value: JSON.stringify(banner) },
      update: { value: JSON.stringify(banner) },
    });
    return NextResponse.json({ ok: true, banner });
  }

  const v = Number(body.taxRatePercent);
  if (Number.isNaN(v) || v < 0 || v > 15) {
    return NextResponse.json({ error: "Tax rate must be between 0 and 15%." }, { status: 400 });
  }
  await setTaxRatePercent(v);
  return NextResponse.json({ ok: true, taxRatePercent: v });
}

import { NextRequest, NextResponse } from "next/server";
import { isAdmin, isStaff } from "@/lib/auth";
import { getTaxRatePercent, setTaxRatePercent, getCardAdjustPercent } from "@/lib/settings";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

async function getRentPerSqft(): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: "rentPerSqft" } });
  const v = row ? Number(row.value) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 6; // 5x5 at $150 = $6/sqft
}

async function getSelfCheckoutPaused(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: "selfCheckoutPaused" } });
  return row?.value === "1";
}

export async function GET() {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ taxRatePercent: await getTaxRatePercent(), rentPerSqft: await getRentPerSqft(), selfCheckoutPaused: await getSelfCheckoutPaused(), cardAdjustPercent: await getCardAdjustPercent() });
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

  if (body.cardAdjustPercent !== undefined) {
    const v = Number(body.cardAdjustPercent);
    if (!Number.isFinite(v) || v < 0 || v > 4) return NextResponse.json({ error: "Card adjustment must be between 0 and 4%." }, { status: 400 });
    await db.setting.upsert({ where: { key: "cardAdjustPercent" }, create: { key: "cardAdjustPercent", value: String(v) }, update: { value: String(v) } });
    return NextResponse.json({ ok: true, cardAdjustPercent: v });
  }

  if (body.selfCheckoutPaused !== undefined) {
    const paused = !!body.selfCheckoutPaused;
    await db.setting.upsert({ where: { key: "selfCheckoutPaused" }, create: { key: "selfCheckoutPaused", value: paused ? "1" : "0" }, update: { value: paused ? "1" : "0" } });
    return NextResponse.json({ ok: true, selfCheckoutPaused: paused });
  }

  if (body.rentPerSqft !== undefined) {
    const r = Number(body.rentPerSqft);
    if (Number.isNaN(r) || r <= 0 || r > 100) return NextResponse.json({ error: "Rate must be between 0 and 100 $/sqft." }, { status: 400 });
    await db.setting.upsert({ where: { key: "rentPerSqft" }, create: { key: "rentPerSqft", value: String(r) }, update: { value: String(r) } });
    return NextResponse.json({ ok: true, rentPerSqft: r });
  }

  const v = Number(body.taxRatePercent);
  if (Number.isNaN(v) || v < 0 || v > 15) {
    return NextResponse.json({ error: "Tax rate must be between 0 and 15%." }, { status: 400 });
  }
  await setTaxRatePercent(v);
  return NextResponse.json({ ok: true, taxRatePercent: v });
}

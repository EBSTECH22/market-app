import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getTaxRatePercent, setTaxRatePercent } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ taxRatePercent: await getTaxRatePercent() });
}

export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { taxRatePercent } = await req.json();
  const v = Number(taxRatePercent);
  if (Number.isNaN(v) || v < 0 || v > 15) {
    return NextResponse.json({ error: "Tax rate must be between 0 and 15%." }, { status: 400 });
  }
  await setTaxRatePercent(v);
  return NextResponse.json({ ok: true, taxRatePercent: v });
}

import { NextRequest, NextResponse } from "next/server";
import { denyUnless } from "@/lib/perm";
import { getTaxRatePercent, setTaxRatePercent, getCardAdjustPercent, getFoodTaxRatePercent, setFoodTaxRatePercent, getTerminalReaderId, getPrinterKey, getPrinterHost, getPrintMode } from "@/lib/settings";
import { getApprovalThresholdCents, setApprovalThresholdCents, recordAudit } from "@/lib/audit";
import { getPayoutFee, setPayoutFee } from "@/lib/payouts";
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
  // The register and the kiosk read the tax rates from here on every load.
  { const denied = await denyUnless("ops"); if (denied) return denied; }
  return NextResponse.json({ taxRatePercent: await getTaxRatePercent(), rentPerSqft: await getRentPerSqft(), selfCheckoutPaused: await getSelfCheckoutPaused(), cardAdjustPercent: await getCardAdjustPercent(), foodTaxRatePercent: (await getFoodTaxRatePercent()) ?? (await getTaxRatePercent()), refundApprovalCents: await getApprovalThresholdCents(), payoutFee: await getPayoutFee(),
    /* What hardware the till can count on. The register asks on every load so
       it can offer "put it on the reader" or fall back to typing an approval
       code, without a second round trip to find out which. */
    cardReaderReady: !!(await getTerminalReaderId()),
    printerReady: (await getPrintMode()) === "direct" ? !!(await getPrinterHost()) : !!(await getPrinterKey()),
    /* The till prints for itself in direct mode, so it needs to know. */
    printMode: await getPrintMode() });
}

/** Every change to a market-wide setting goes in the log, with what it was. */
async function auditSetting(req: NextRequest, key: string, before: unknown, after: unknown, detail: string) {
  await recordAudit(
    { action: "SETTING_CHANGE", targetType: "SETTING", targetId: key, targetLabel: key, detail, before, after },
    req
  );
}

export async function POST(req: NextRequest) {
  { const denied = await denyUnless("config"); if (denied) return denied; }
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

  if (body.foodTaxRatePercent !== undefined) {
    const v = Number(body.foodTaxRatePercent);
    if (!Number.isFinite(v) || v < 0 || v > 15) return NextResponse.json({ error: "Food tax rate must be between 0 and 15%." }, { status: 400 });
    const before = await getFoodTaxRatePercent();
    await setFoodTaxRatePercent(v);
    await auditSetting(req, "foodTaxRatePercent", before, v, `Food tax rate set to ${v}%${before === null ? " (was unset — food was taxed at the full rate)" : ` (was ${before}%)`}`);
    return NextResponse.json({ ok: true, foodTaxRatePercent: v });
  }

  if (body.refundApprovalCents !== undefined) {
    const v = Number(body.refundApprovalCents);
    if (!Number.isFinite(v) || v < 0 || v > 100000) {
      return NextResponse.json({ error: "Approval threshold must be between $0 and $1,000." }, { status: 400 });
    }
    const before = await getApprovalThresholdCents();
    await setApprovalThresholdCents(v);
    await auditSetting(
      req, "refundApprovalCents", before, Math.round(v),
      v === 0
        ? "Manager approval for refunds turned off"
        : `Refunds of $${(v / 100).toFixed(2)} or more now need a manager's PIN (was $${(before / 100).toFixed(2)})`
    );
    return NextResponse.json({ ok: true, refundApprovalCents: Math.round(v) });
  }

  if (body.payoutFeePercent !== undefined || body.payoutFeeFixedCents !== undefined) {
    const before = await getPayoutFee();
    const percent = body.payoutFeePercent === undefined ? before.percent : Number(body.payoutFeePercent);
    const fixed = body.payoutFeeFixedCents === undefined ? before.fixedCents : Number(body.payoutFeeFixedCents);
    if (!Number.isFinite(percent) || percent < 0 || percent > 5) {
      return NextResponse.json({ error: "Payout fee percent must be between 0 and 5%." }, { status: 400 });
    }
    if (!Number.isFinite(fixed) || fixed < 0 || fixed > 1000) {
      return NextResponse.json({ error: "Fixed payout fee must be between $0 and $10." }, { status: 400 });
    }
    await setPayoutFee(percent, fixed);
    await auditSetting(
      req, "payoutFee", before, { percent, fixedCents: Math.round(fixed) },
      `Vendor payout fee set to ${percent}% + $${(fixed / 100).toFixed(2)} (was ${before.percent}% + $${(before.fixedCents / 100).toFixed(2)})`
    );
    return NextResponse.json({ ok: true, payoutFee: { percent, fixedCents: Math.round(fixed) } });
  }

  if (body.cardAdjustPercent !== undefined) {
    const v = Number(body.cardAdjustPercent);
    if (!Number.isFinite(v) || v < 0 || v > 4) return NextResponse.json({ error: "Card adjustment must be between 0 and 4%." }, { status: 400 });
    const before = await getCardAdjustPercent();
    await db.setting.upsert({ where: { key: "cardAdjustPercent" }, create: { key: "cardAdjustPercent", value: String(v) }, update: { value: String(v) } });
    await auditSetting(req, "cardAdjustPercent", before, v, `Card adjustment set to ${v}% (was ${before}%)`);
    return NextResponse.json({ ok: true, cardAdjustPercent: v });
  }

  if (body.selfCheckoutPaused !== undefined) {
    const paused = !!body.selfCheckoutPaused;
    const before = await getSelfCheckoutPaused();
    await db.setting.upsert({ where: { key: "selfCheckoutPaused" }, create: { key: "selfCheckoutPaused", value: paused ? "1" : "0" }, update: { value: paused ? "1" : "0" } });
    if (before !== paused) {
      await auditSetting(req, "selfCheckoutPaused", before, paused, paused ? "Self-checkout paused" : "Self-checkout turned back on");
    }
    return NextResponse.json({ ok: true, selfCheckoutPaused: paused });
  }

  if (body.rentPerSqft !== undefined) {
    const r = Number(body.rentPerSqft);
    if (Number.isNaN(r) || r <= 0 || r > 100) return NextResponse.json({ error: "Rate must be between 0 and 100 $/sqft." }, { status: 400 });
    const before = await getRentPerSqft();
    await db.setting.upsert({ where: { key: "rentPerSqft" }, create: { key: "rentPerSqft", value: String(r) }, update: { value: String(r) } });
    await auditSetting(req, "rentPerSqft", before, r, `Booth rate set to $${r}/sqft (was $${before})`);
    return NextResponse.json({ ok: true, rentPerSqft: r });
  }

  const v = Number(body.taxRatePercent);
  if (Number.isNaN(v) || v < 0 || v > 15) {
    return NextResponse.json({ error: "Tax rate must be between 0 and 15%." }, { status: 400 });
  }
  const beforeRate = await getTaxRatePercent();
  await setTaxRatePercent(v);
  await auditSetting(req, "taxRatePercent", beforeRate, v, `Sales tax rate set to ${v}% (was ${beforeRate}%)`);
  return NextResponse.json({ ok: true, taxRatePercent: v });
}

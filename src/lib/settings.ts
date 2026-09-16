import { db } from "@/lib/db";

export async function getTaxRatePercent(): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: "taxRatePercent" } });
  const v = row ? Number(row.value) : NaN;
  return Number.isFinite(v) ? v : 9.0;
}

export async function setTaxRatePercent(v: number): Promise<void> {
  await db.setting.upsert({
    where: { key: "taxRatePercent" },
    create: { key: "taxRatePercent", value: String(v) },
    update: { value: String(v) },
  });
}

/**
 * Local-only rate for food and food ingredients.
 *
 * Unset means "not configured yet", and the honest thing to do then is tax food
 * at the full rate exactly as before — deploying this must not silently start
 * under-collecting on every grocery item in the market. It only splits once
 * somebody has entered the number deliberately.
 */
export async function getFoodTaxRatePercent(): Promise<number | null> {
  const row = await db.setting.findUnique({ where: { key: "foodTaxRatePercent" } });
  if (!row) return null;
  const v = Number(row.value);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

export async function setFoodTaxRatePercent(v: number): Promise<void> {
  await db.setting.upsert({
    where: { key: "foodTaxRatePercent" },
    create: { key: "foodTaxRatePercent", value: String(v) },
    update: { value: String(v) },
  });
}

/** Both rates, ready to hand to taxFor(). */
export async function getTaxRates(): Promise<{ standardPercent: number; foodPercent: number }> {
  const standardPercent = await getTaxRatePercent();
  const food = await getFoodTaxRatePercent();
  return { standardPercent, foodPercent: food === null ? standardPercent : food };
}

export async function getCardAdjustPercent(): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: "cardAdjustPercent" } });
  const v = row ? Number(row.value) : 0;
  return Number.isFinite(v) && v >= 0 && v <= 4 ? v : 0;
}

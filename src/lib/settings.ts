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

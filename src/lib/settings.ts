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

/* ------------------------------------------------------ till hardware -- */

const str = async (key: string, fallback = ""): Promise<string> => {
  const row = await db.setting.findUnique({ where: { key } });
  return row ? row.value : fallback;
};

const put = async (key: string, value: string): Promise<void> => {
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
};

/**
 * The secret in the printer's poll address.
 *
 * The printer can't sign in — it has no cookies and no idea who anybody is. So
 * the URL itself is the credential: a long random word in the path, typed into
 * the printer once. Anyone who knows it can print on the market's paper and
 * pop the drawer, which is why it is generated rather than chosen, and why
 * changing it is one button.
 */
export async function getPrinterKey(): Promise<string> {
  return str("printerKey");
}

export async function setPrinterKey(v: string): Promise<void> {
  await put("printerKey", v);
}

/** Lines across the top of every receipt. Blank means the built-in default. */
export async function getReceiptHeader(): Promise<string[]> {
  return (await str("receiptHeader")).split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 6);
}

export async function setReceiptHeader(lines: string[]): Promise<void> {
  await put("receiptHeader", lines.slice(0, 6).join("\n"));
}

export async function getReceiptFooter(): Promise<string[]> {
  return (await str("receiptFooter")).split("\n").map((s) => s.trim()).slice(0, 8);
}

export async function setReceiptFooter(lines: string[]): Promise<void> {
  await put("receiptFooter", lines.slice(0, 8).join("\n"));
}

/** Which card reader the till sends charges to. */
export async function getTerminalReaderId(): Promise<string> {
  return str("terminalReaderId");
}

export async function setTerminalReaderId(v: string): Promise<void> {
  await put("terminalReaderId", v.trim());
}

export async function getTerminalLocationId(): Promise<string> {
  return str("terminalLocationId");
}

export async function setTerminalLocationId(v: string): Promise<void> {
  await put("terminalLocationId", v.trim());
}

/**
 * Print a receipt for every sale without being asked.
 *
 * On by default: a till that prints when you tell it to is a till where
 * somebody eventually forgets, and the customer is already out of the door.
 */
export async function getAutoPrint(): Promise<boolean> {
  return (await str("autoPrintReceipts", "1")) !== "0";
}

export async function setAutoPrint(on: boolean): Promise<void> {
  await put("autoPrintReceipts", on ? "1" : "0");
}

/**
 * Which version of Server Direct Print the printer is spoken to in.
 *
 * "1.00" is the default and the safe one. Firmware that doesn't understand a
 * 2.00 document ignores it silently rather than complaining, which looks
 * exactly like a printer that never received anything — so the broadest
 * version is the one used until somebody has a reason to change it.
 */
export async function getSdpVersion(): Promise<"1.00" | "2.00"> {
  return (await str("sdpVersion", "1.00")) === "2.00" ? "2.00" : "1.00";
}

export async function setSdpVersion(v: string): Promise<void> {
  await put("sdpVersion", v === "2.00" ? "2.00" : "1.00");
}

/** The last thing the printer said to us, for working out why it's quiet. */
export async function notePrinterEvent(what: string): Promise<void> {
  await put("printerLastEvent", `${new Date().toISOString()}|${what}`.slice(0, 200));
}

export async function getPrinterEvent(): Promise<{ at: string; what: string } | null> {
  const raw = await str("printerLastEvent");
  if (!raw) return null;
  const i = raw.indexOf("|");
  return i < 0 ? null : { at: raw.slice(0, i), what: raw.slice(i + 1) };
}

/**
 * The printer's last report, word for word.
 *
 * Kept because a tidied-up error message is no use when the tidying is the
 * thing that's wrong. When paper isn't coming out and the code means nothing,
 * the raw document is what settles it.
 */
export async function notePrinterResponse(raw: string): Promise<void> {
  await put("printerLastResponse", String(raw || "").slice(0, 900));
}

export async function getPrinterResponse(): Promise<string> {
  return str("printerLastResponse");
}

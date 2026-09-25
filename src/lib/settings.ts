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

/**
 * Which printer on the device the paper comes out of.
 *
 * "local_printer" is Epson's usual name for it and is right on most units,
 * but it is a SETTING on the printer, not a constant — a hybrid like the
 * TM-H6000V has a receipt station, a slip station and a customer display, each
 * with its own name, and those names can be changed. Send one the printer
 * doesn't have and it runs nothing and reports nothing, which looks for all
 * the world like a printer that is ignoring you.
 */
export async function getPrinterDeviceId(): Promise<string> {
  return (await str("printerDeviceId", "local_printer")) || "local_printer";
}

export async function setPrinterDeviceId(v: string): Promise<void> {
  await put("printerDeviceId", String(v || "").trim().slice(0, 60) || "local_printer");
}

/**
 * The last dozen things the printer did, oldest last.
 *
 * One line of "last event" was not enough to tell what was going on: the
 * interesting thing was never the most recent exchange but the SHAPE of
 * several in a row — handed a job, then an empty report, then handed it
 * again. Best-effort and lossy under concurrency, which is fine for something
 * whose only job is to be read by a person trying to work out why the paper
 * isn't moving.
 */
export async function logPrinter(what: string): Promise<void> {
  const now = new Date().toISOString();
  const line = `${now}|${String(what).slice(0, 300)}`;
  const prev = (await str("printerLog")).split("\n").filter(Boolean);
  await put("printerLog", [...prev, line].slice(-12).join("\n"));
}

export async function getPrinterLog(): Promise<{ at: string; what: string }[]> {
  return (await str("printerLog"))
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("|");
      return { at: l.slice(0, i), what: l.slice(i + 1) };
    })
    .reverse();
}

/** How the request document is laid out. See SdpStyle in lib/epos. */
export async function getSdpStyle(): Promise<"pretty" | "compact" | "bare"> {
  const v = await str("sdpStyle", "pretty");
  return v === "compact" || v === "bare" ? v : "pretty";
}

export async function setSdpStyle(v: string): Promise<void> {
  await put("sdpStyle", v === "compact" || v === "bare" ? v : "pretty");
}

/**
 * The printer's address on the market's own wifi.
 *
 * Only meaningful in direct mode, where the till talks to the printer itself
 * rather than leaving jobs for it to collect.
 */
export async function getPrinterHost(): Promise<string> {
  return str("printerHost");
}

export async function setPrinterHost(v: string): Promise<void> {
  await put("printerHost", String(v || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "").slice(0, 80));
}

/**
 * How receipts reach the paper.
 *
 * "direct"  — whichever till is open sends the job to the printer over the
 *             shop wifi. Instant, and the only route that works on this
 *             printer's firmware.
 * "collect" — the printer fetches its own work (Epson's Server Direct Print).
 *             Works from anywhere, and does not work here: this firmware takes
 *             the job and never hands it to its own print engine.
 */
export async function getPrintMode(): Promise<"direct" | "collect"> {
  return (await str("printMode", "direct")) === "collect" ? "collect" : "direct";
}

export async function setPrintMode(v: string): Promise<void> {
  await put("printMode", v === "collect" ? "collect" : "direct");
}

/**
 * Characters across the receipt.
 *
 * 42 on this market's printer. Wrong by even one and every total wraps, so it
 * is a setting rather than a constant — a replacement printer on a different
 * paper width should be a number typed in, not a deploy.
 */
export async function getReceiptColumns(): Promise<number> {
  const n = Math.round(Number(await str("receiptColumns", "42")));
  return Number.isFinite(n) && n >= 24 && n <= 96 ? n : 42;
}

export async function setReceiptColumns(v: number): Promise<void> {
  const n = Math.round(Number(v));
  await put("receiptColumns", String(Number.isFinite(n) && n >= 24 && n <= 96 ? n : 42));
}

/** Print the logo at the top of every receipt. */
export async function getReceiptLogo(): Promise<boolean> {
  return (await str("receiptLogo", "1")) !== "0";
}

export async function setReceiptLogo(on: boolean): Promise<void> {
  await put("receiptLogo", on ? "1" : "0");
}

/**
 * How many dots across the logo prints.
 *
 * This printer refuses a job whose image is too large, and the limit is not
 * published. So this is a setting the office can step down until a test print
 * comes out, rather than something to be guessed at in code.
 */
export async function getLogoSize(): Promise<number> {
  const n = Math.round(Number(await str("receiptLogoSize", "192")));
  return [128, 192, 256, 320, 384].includes(n) ? n : 192;
}

export async function setLogoSize(v: number): Promise<void> {
  const n = Math.round(Number(v));
  await put("receiptLogoSize", String([128, 192, 256, 320, 384].includes(n) ? n : 192));
}

/**
 * Where the receipt's logo comes from.
 *
 * "image" sends the picture with every receipt. "printer" prints one loaded
 * into the printer's own memory with Epson's utility — two key codes on the
 * wire instead of thousands of characters, which removes the size ceiling
 * that an image keeps running into.
 */
export async function getLogoSource(): Promise<"image" | "printer"> {
  return (await str("logoSource", "image")) === "printer" ? "printer" : "image";
}

export async function setLogoSource(v: string): Promise<void> {
  await put("logoSource", v === "printer" ? "printer" : "image");
}

/** The two key codes Epson's utility gave the stored logo. */
export async function getLogoKeys(): Promise<{ key1: number; key2: number }> {
  const clamp = (raw: string, fallback: number) => {
    const n = Math.round(Number(raw));
    return Number.isFinite(n) && n >= 0 && n <= 255 ? n : fallback;
  };
  return {
    key1: clamp(await str("logoKey1", "32"), 32),
    key2: clamp(await str("logoKey2", "32"), 32),
  };
}

export async function setLogoKeys(key1: number, key2: number): Promise<void> {
  const ok = (n: number, fallback: number) =>
    Number.isFinite(n) && n >= 0 && n <= 255 ? Math.round(n) : fallback;
  await put("logoKey1", String(ok(key1, 32)));
  await put("logoKey2", String(ok(key2, 32)));
}

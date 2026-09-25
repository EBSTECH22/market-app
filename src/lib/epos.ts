/**
 * Receipts and drawer kicks, written in the language the Epson speaks.
 *
 * Everything here is a pure function that turns a booked sale into ePOS-Print
 * XML. Nothing in this file talks to the database, the network or the printer,
 * which is what makes a receipt something you can test rather than something
 * you find out about by feeding it paper.
 *
 * The printer is a TM-H6000V on 80mm paper. Font A on that roll is 48
 * characters wide, and that number is the whole reason the helpers below
 * exist: a receipt is not a document with a layout, it is 48 columns of
 * monospace, and every line has to be padded to fit by hand.
 */

import { RECEIPT_LOGOS, DEFAULT_LOGO_SIZE } from "@/lib/receiptlogo";
import { tagCents } from "@/lib/cardprice";

export const EPOS_NS = "http://www.epson-pos.com/schemas/2011/03/epos-print";

/**
 * How many characters fit across the paper in Font A.
 *
 * 42 on the market's TM-H6000V — Epson's sheet lists its receipt as 56/51/42
 * columns against fonts 9x17, 10x20 and 12x24, and Font A is the 12x24. This
 * number is the whole layout: every line below is padded out to it by hand, so
 * setting it too high makes every total wrap onto a line of its own and the
 * receipt comes out looking like a ransom note. A different printer would want
 * a different number, which is why it can be overridden per receipt.
 */
export const COLS = 42;

export const esc = (s: string): string =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    /* Control characters are not legal in XML 1.0 and the printer rejects the
       whole job over one of them. An item named from a barcode scan can carry
       anything, so they go rather than the receipt. */
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

const money = (cents: number): string => {
  const neg = cents < 0;
  const v = (Math.abs(Math.round(cents)) / 100).toFixed(2);
  return `${neg ? "-" : ""}$${v}`;
};

/** Left text, right text, padded apart to fill the roll. */
export function pad(left: string, right: string, cols = COLS): string {
  const l = String(left);
  const r = String(right);
  /* The right-hand side is the money, so it is the side that must survive: a
     total chopped in half is worse than a truncated item name. */
  const room = Math.max(0, cols - r.length);
  const cut = l.length > room ? l.slice(0, Math.max(0, room - 1)) : l;
  const gap = Math.max(1, cols - cut.length - r.length);
  return cut + " ".repeat(gap) + r;
}

/**
 * A name and an amount, wrapped rather than chopped.
 *
 * "Hand-poured soy candle, large lavender" does not fit beside its price on
 * 42 columns, and cutting it at "large la" makes the paper look broken. The
 * name runs on instead, indented, with the money on the last line where the
 * eye expects it.
 */
export function wrapLine(left: string, right: string, cols = COLS, indent = "   "): string[] {
  const room = Math.max(8, cols - right.length - 1);
  const words = String(left).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    const limit = lines.length === 0 ? room : room - indent.length;
    if (next.length <= limit) { cur = next; continue; }
    if (cur) lines.push(cur);
    /* A single word longer than the paper — a SKU, or a name typed without
       spaces. Break it rather than let the printer decide. */
    cur = w;
    while (cur.length > room - indent.length) {
      lines.push(cur.slice(0, room - indent.length));
      cur = cur.slice(room - indent.length);
    }
  }
  if (cur) lines.push(cur);
  if (lines.length === 0) lines.push("");

  return lines.map((l, i) =>
    i === lines.length - 1
      ? pad(i === 0 ? l : indent + l, right, cols)
      : (i === 0 ? l : indent + l)
  );
}

export function center(s: string, cols = COLS): string {
  const t = String(s).slice(0, cols);
  const left = Math.max(0, Math.floor((cols - t.length) / 2));
  return " ".repeat(left) + t;
}

export function rule(ch = "-", cols = COLS): string {
  return ch.repeat(cols);
}

/** A line of text, as the printer wants it: escaped, with the newline inside. */
const t = (s: string): string => `<text>${esc(s)}&#10;</text>`;

/* ------------------------------------------------------------- the bits -- */

/**
 * Open the cash drawer.
 *
 * The drawer has no wire of its own — it hangs off the printer's DK port, and
 * a pulse down that wire is what pops it. 200ms is Epson's middle setting and
 * the one that works with the widest range of solenoids; 100 sometimes isn't
 * enough to throw a stiff drawer.
 */
export const drawerPulse = (): string => `<pulse drawer="drawer_1" time="pulse_200"/>`;

export const cut = (): string => `<feed unit="60"/><cut type="feed"/>`;

/**
 * The market's logo across the top of the receipt.
 *
 * Sent as raster dots rather than stored in the printer's own memory, so the
 * logo travels with the receipt and changing it needs no trip to the printer
 * with a Windows utility.
 *
 * The size is a setting because this printer has an undocumented ceiling on
 * how much image it will accept in one job, and past it the whole receipt is
 * refused with a schema error. Rather than guess at the limit, the office
 * picks a size and prints a test.
 *
 * The attribute order below matters. This firmware accepts
 * width/height/align/color/mode and rejects the same attributes in a
 * different order, which is not how XML is supposed to work and is how it
 * behaves. Leave it alone.
 */
/**
 * A logo already sitting in the printer's memory.
 *
 * Epson's utility loads the artwork into the printer once and gives it two key
 * codes; the receipt then just names them. Nothing about the size of the
 * picture affects the size of the job, which is what makes this the right way
 * to put a logo on a receipt and the thing to reach for the moment an image
 * starts bumping into limits.
 */
export const storedLogo = (key1 = 32, key2 = 32): string =>
  `<logo key1="${Math.max(0, Math.min(255, Math.round(key1)))}" ` +
  `key2="${Math.max(0, Math.min(255, Math.round(key2)))}" align="center"/>`;

export const logoImage = (size: number = DEFAULT_LOGO_SIZE): string => {
  const l = RECEIPT_LOGOS[size] || RECEIPT_LOGOS[DEFAULT_LOGO_SIZE];
  if (!l) return "";
  return `<image width="${l.width}" height="${l.height}" align="center" color="color_1" mode="mono">${l.data}</image>`;
};

/** Wrap finished children in the document element the printer expects. */
export const eposDoc = (children: string): string =>
  `<epos-print xmlns="${EPOS_NS}">${children}</epos-print>`;

/* ------------------------------------------ putting the logo IN the printer -- */

/**
 * Base64 to hex, by hand.
 *
 * Buffer belongs to the server and atob to the browser, and this file is
 * imported by both. Forty lines of arithmetic beats a runtime check that
 * works everywhere except the one place it's needed.
 */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const HEX = "0123456789ABCDEF";

function b64ToHex(b64: string): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const ch of b64) {
    if (ch === "=" || ch === "\n" || ch === "\r" || ch === " ") continue;
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (acc >> bits) & 0xff;
      out += HEX[byte >> 4] + HEX[byte & 0x0f];
    }
  }
  return out;
}

const hexByte = (n: number): string => HEX[(n >> 4) & 0x0f] + HEX[n & 0x0f];

/**
 * The ESC/POS command that writes the logo into the printer's own memory.
 *
 * GS ( L function 112 — "define the NV graphics data, raster format". Once
 * this has run the artwork lives in the printer until it is overwritten, and
 * every receipt after it names two key codes instead of carrying thirty
 * kilobytes of picture. That is the whole point: the receipts that were
 * timing out stop being big.
 *
 * Laid out exactly as Epson's reference has it:
 *   GS ( L pL pH m fn a kc1 kc2 b xL xH yL yH c  d1...dk
 * where p is everything after pH, the two key codes are the name the logo
 * will answer to, b is one colour, and c names that colour.
 */
export function nvLogoCommandHex(size: number, key1: number, key2: number): string {
  const l = RECEIPT_LOGOS[size] || RECEIPT_LOGOS[DEFAULT_LOGO_SIZE];
  if (!l) return "";
  const data = b64ToHex(l.data);
  const bytes = data.length / 2;

  /* m fn a kc1 kc2 b xL xH yL yH c, then the raster. */
  const p = 11 + bytes;
  const k1 = Math.max(32, Math.min(126, Math.round(key1)));
  const k2 = Math.max(32, Math.min(126, Math.round(key2)));

  return (
    "1D284C" +
    hexByte(p & 0xff) +
    hexByte((p >> 8) & 0xff) +
    "30" + // m
    "70" + // fn 112, define NV graphics
    "30" + // a, monochrome
    hexByte(k1) +
    hexByte(k2) +
    "01" + // one colour
    hexByte(l.width & 0xff) +
    hexByte((l.width >> 8) & 0xff) +
    hexByte(l.height & 0xff) +
    hexByte((l.height >> 8) & 0xff) +
    "31" + // colour 1
    data
  );
}

/**
 * The same command wrapped for the printer, in both dialects.
 *
 * Epson's own documentation is not consistent about whether a <command>
 * element carries hex or base64, and the two firmwares in this building
 * disagree. Rather than spend an evening finding out, both are sent: they
 * define byte-for-byte the same logo under the same key codes, so whichever
 * one the printer understands is the one that takes, and the other is
 * refused without doing anything. Nothing prints either way.
 */
export function nvLogoJobs(
  size: number,
  key1: number,
  key2: number
): { label: string; body: string }[] {
  const hex = nvLogoCommandHex(size, key1, key2);
  if (!hex) return [];
  const raw = RECEIPT_LOGOS[size] || RECEIPT_LOGOS[DEFAULT_LOGO_SIZE];
  const b64 = hexToB64(hex);
  return [
    { label: `Store the logo (${raw.width} dots)`, body: eposDoc(`<command>${hex}</command>`) },
    { label: `Store the logo (second format)`, body: eposDoc(`<command>${b64}</command>`) },
  ];
}

function hexToB64(hex: string): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < hex.length; i += 2) {
    acc = (acc << 8) | parseInt(hex.slice(i, i + 2), 16);
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64[(acc >> bits) & 0x3f];
    }
  }
  if (bits > 0) out += B64[(acc << (6 - bits)) & 0x3f];
  while (out.length % 4) out += "=";
  return out;
}

/** Print whatever is stored under those key codes, with a line to say so. */
export const nvLogoProofXml = (key1: number, key2: number): string =>
  eposDoc(
    storedLogo(key1, key2) +
      t("") +
      t(center("LOGO STORED IN THE PRINTER")) +
      t(center(`key codes ${Math.round(key1)} and ${Math.round(key2)}`)) +
      cut()
  );

/* --------------------------------------------------------- the receipt -- */

export type ReceiptLine = {
  name: string;
  quantity: number;
  priceCents: number;
  basePriceCents?: number;
  /* Who it belongs to. On a consignment floor this is the point of the
     receipt: a customer with a question about a jar of jam needs to know
     whose jam it was, and the market needs to be able to answer months
     later from a piece of paper in somebody's handbag. */
  vendorName?: string;
  vendorCode?: string;
};

export type ReceiptSale = {
  number: number;
  createdAt: string | Date;
  employee?: string;
  lines: ReceiptLine[];
  subtotalCents: number;
  saleSavingsCents?: number;
  cardAdjustCents?: number;
  taxCents: number;
  foodTaxCents?: number;
  standardTaxCents?: number;
  discountCents?: number;
  totalCents: number;
  cashTenderedCents?: number;
  changeCents?: number;
  paymentMethod: string;
  cardName?: string;
  customerPoints?: number | null;
};

export type ReceiptOptions = {
  /** Characters across. Defaults to this printer's 42. */
  cols?: number;
  /** Print the ticket number as a scannable barcode at the foot. */
  barcode?: boolean;
  /** Print the market's logo above the address. */
  logo?: boolean;
  /** How many dots across the logo prints. Image mode only. */
  logoSize?: number;
  /**
   * Where the logo comes from.
   *
   * "image" sends the picture with every receipt — simple, needs no setup, and
   * limited by how much image this printer will accept in one job.
   * "printer" prints one already stored in the printer's own memory: two key
   * codes instead of thousands of characters, at any size, with no size limit
   * to run into. It has to be loaded into the printer once with Epson's
   * utility first.
   */
  logoSource?: "image" | "printer";
  /** The key codes the utility gave the stored logo. Printer mode only. */
  logoKey1?: number;
  logoKey2?: number;
  /** Shop name and address, from settings, so a rename doesn't need a deploy. */
  header?: string[];
  footer?: string[];
  /** Printed across the top so nobody hands a duplicate over as the original. */
  reprint?: boolean;
  timeZone?: string;
  /** The card percentage: item lines print at TAG prices (lib/cardprice), and a
      cash sale shows the difference as CASH DISCOUNT. 0 prints plain prices. */
  cardPercent?: number;
};

const DEFAULT_HEADER = ["COMMUNITY HARVEST", "510 N Main St", "Noble, Oklahoma"];
const DEFAULT_FOOTER = ["THANK YOU!", "homegrown + homemade", "", "ALL SALES FINAL", "NO REFUNDS OR EXCHANGES"];

/**
 * A sale, as 48-column paper.
 *
 * Deliberately the same information, in the same order, as the receipt the
 * browser used to print — a customer comparing an old receipt to a new one
 * should not find the market has started telling them different things.
 */
export function receiptBody(sale: ReceiptSale, opts: ReceiptOptions = {}): string {
  const tz = opts.timeZone || "America/Chicago";
  const cols = Math.max(24, Math.min(96, Math.round(opts.cols || COLS)));
  const when = new Date(sale.createdAt);
  const header = opts.header?.length ? opts.header : DEFAULT_HEADER;
  const footer = opts.footer?.length ? opts.footer : DEFAULT_FOOTER;
  const line = (l: string, r: string) => t(pad(l, r, cols));

  const out: string[] = [];
  out.push(`<text align="center"/>`);

  if (opts.logo !== false && opts.logoSource === "printer") {
    /* A stored logo costs about forty characters however big it is, which is
       the whole reason for using one. */
    out.push(storedLogo(opts.logoKey1, opts.logoKey2));
  } else if (opts.logo !== false) {
    out.push(logoImage(opts.logoSize));
  } else {
    /* No logo: the shop's name in double-size characters instead, so the top
       of the receipt is still the top of the receipt. */
    out.push(`<text width="2" height="2">${esc(header[0] || "")}&#10;</text>`);
    out.push(`<text width="1" height="1"/>`);
  }
  for (const h of header.slice(1)) out.push(t(h));

  if (opts.reprint) {
    out.push(t(""));
    out.push(`<text em="true">${esc("*** REPRINT ***")}&#10;</text>`);
  }

  out.push(t(""));
  out.push(`<text align="left"/>`);
  out.push(t(rule("-", cols)));
  out.push(line(`RECEIPT #${sale.number}`, when.toLocaleDateString("en-US", { timeZone: tz })));
  out.push(
    line(
      sale.employee ? `CLERK: ${sale.employee}` : "",
      when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })
    )
  );
  out.push(t(rule("-", cols)));

  /* Every line prints at its TAG price — the number on the shelf label. A
     cash sale then takes the card percentage back as CASH DISCOUNT; a card
     sale pays the tags as they are. */
  const pct = Math.max(0, Number(opts.cardPercent) || 0);
  const tag = (c: number) => tagCents(c, pct);
  let itemCount = 0;
  let tagBase = 0;
  let tagPaid = 0;
  for (const l of sale.lines) {
    const qty = Math.max(1, Math.round(l.quantity));
    itemCount += qty;
    const base = l.basePriceCents || l.priceCents;
    tagBase += tag(base) * qty;
    tagPaid += tag(l.priceCents) * qty;
    for (const row of wrapLine(`${qty}x ${l.name}`, money(tag(base) * qty), cols)) out.push(t(row));

    /* A discounted item shows what it normally is, indented under itself —
       people want to see the saving on the paper, not just in the total. */
    if (l.basePriceCents && l.priceCents !== l.basePriceCents) {
      out.push(line(`   sale price`, money(tag(l.priceCents) * qty)));
    }

    /* Whose stall it came from. The code is what the market files everything
       by, so it goes on the paper next to the name. */
    if (l.vendorName || l.vendorCode) {
      const who = [l.vendorName, l.vendorCode ? `(${l.vendorCode})` : ""].filter(Boolean).join(" ");
      out.push(t(`   ${who}`.slice(0, cols)));
    }
  }

  out.push(t(rule("-", cols)));
  out.push(line(`ITEMS SOLD`, String(itemCount)));
  out.push(line("SUBTOTAL", money(tagBase)));
  if (tagBase > tagPaid) out.push(line("SALE SAVINGS", `-${money(tagBase - tagPaid)}`));
  if (sale.paymentMethod === "CASH") {
    const cashOff = tagPaid - sale.subtotalCents;
    if (cashOff > 0) out.push(line("CASH DISCOUNT", `-${money(cashOff)}`));
  } else {
    /* Card pays the tags. Anything left over is an older ticket, or one rung
       at a different percentage, and is shown rather than hidden so the paper
       still adds up. */
    const rest = sale.subtotalCents + (sale.cardAdjustCents || 0) - tagPaid;
    if (rest !== 0) out.push(line("NON-CASH ADJ", money(rest)));
  }

  if (sale.foodTaxCents && sale.standardTaxCents) {
    out.push(line("TAX (GENERAL)", money(sale.standardTaxCents)));
    out.push(line("TAX (FOOD)", money(sale.foodTaxCents)));
  } else {
    out.push(line("TAX", money(sale.taxCents)));
  }
  if (sale.discountCents) out.push(line("REWARDS", `-${money(sale.discountCents)}`));

  /* Double-size characters are twice as wide, so the total gets half the
     columns to lay itself out in. */
  out.push(`<text em="true" width="2" height="2">${esc(pad("TOTAL", money(sale.totalCents), Math.floor(cols / 2)))}&#10;</text>`);
  out.push(`<text em="false" width="1" height="1"/>`);

  const tendered = (sale.cashTenderedCents || 0) > 0;
  if (tendered) {
    out.push(line("CASH", money(sale.cashTenderedCents || 0)));
    out.push(line("CHANGE", money(sale.changeCents || 0)));
  }
  /* Say how it was paid once. Cash that shows what was handed over and what
     came back has already said it; a card says which card. */
  if (!tendered || sale.cardName) {
    out.push(line(`PAID BY ${sale.paymentMethod}`, sale.cardName ? String(sale.cardName) : ""));
  }

  if (typeof sale.customerPoints === "number") {
    out.push(t(""));
    out.push(t(center(`REWARDS POINTS: ${sale.customerPoints}`, cols)));
  }

  out.push(t(""));
  out.push(`<text align="center"/>`);
  for (const f of footer) out.push(t(f));

  /* The ticket number, scannable. Costs almost nothing to print — a barcode
     is an instruction, not a picture — and turns "I bought it a few weeks
     ago" into a scan at the counter. */
  if (opts.barcode !== false && sale.number > 0) {
    out.push(t(""));
    out.push(`<barcode type="code39" hri="below" font="font_b" width="2" height="48">${esc(String(sale.number))}</barcode>`);
  }

  out.push(cut());
  return out.join("");
}

/** A receipt, ready to hand to the printer. */
export const receiptXml = (sale: ReceiptSale, opts: ReceiptOptions = {}): string =>
  eposDoc(receiptBody(sale, opts));

/** Nothing but a drawer kick — the No Sale button. */
export const drawerXml = (): string => eposDoc(drawerPulse());

/** A receipt with the drawer popping as it prints. Cash sales. */
export const receiptWithDrawerXml = (sale: ReceiptSale, opts: ReceiptOptions = {}): string =>
  eposDoc(drawerPulse() + receiptBody(sale, opts));

/** Proof of life: prints, then pops the drawer, so one test covers both. */
export function testXml(
  who: string,
  at: Date = new Date(),
  timeZone = "America/Chicago",
  cols = COLS,
  logoSize = 0,
  stored?: { key1: number; key2: number }
): string {
  const out: string[] = [];
  out.push(`<text align="center"/>`);
  /* The logo goes on the test page when one is being tried, so finding what
     the printer accepts costs test prints rather than real sales. */
  if (stored) out.push(storedLogo(stored.key1, stored.key2));
  else if (logoSize) out.push(logoImage(logoSize));
  out.push(`<text width="2" height="2">${esc("TEST")}&#10;</text>`);
  out.push(`<text width="1" height="1"/>`);
  out.push(t("Community Harvest"));
  out.push(t(""));
  out.push(`<text align="left"/>`);
  out.push(t(rule("-", cols)));
  out.push(t(pad("PRINTER", "OK", cols)));
  out.push(t(pad("DRAWER", "kicking now", cols)));
  out.push(t(pad("SENT BY", who || "the office", cols)));
  out.push(t(pad("AT", at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone }), cols)));
  out.push(t(rule("-", cols)));
  out.push(t(""));
  out.push(`<text align="center"/>`);
  out.push(t("If you are reading this, the till"));
  out.push(t("can print. If the drawer also"));
  out.push(t("opened, it is wired right."));
  out.push(drawerPulse());
  out.push(cut());
  return eposDoc(out.join(""));
}

/* ------------------------------------------------- the Epson's envelope -- */

export type QueuedPrint = { id: string; body: string };

/**
 * The answer the printer gets when it asks for work.
 *
 * `devid` names which printer on the device — "local_printer" is the one the
 * paper comes out of. The timeout is the printer's own patience with the job,
 * not ours.
 *
 * TWO VERSIONS, and which one a printer understands depends on its firmware.
 * Version 2.00 carries a job id that comes back in the completion report, so
 * a job can be matched exactly. Version 1.00 has no job id at all, and older
 * firmware IGNORES A 2.00 DOCUMENT ENTIRELY rather than complaining about it
 * — the printer asks, is handed a document it can't read, and says nothing,
 * which looks from here exactly like a printer that never got anything.
 *
 * So 1.00 is the default. It is understood by every printer that does Server
 * Direct Print at all, and the cost is only that a completion has to be
 * matched to the oldest job outstanding instead of by name.
 */
export type SdpVersion = "1.00" | "2.00";

/**
 * How the request document is laid out on the wire.
 *
 * "pretty" writes it across lines the way Epson's manual prints it. "compact"
 * puts it on one line. Whitespace between elements is meaningless to an XML
 * parser and ought to make no difference whatsoever — but the thing reading
 * this is embedded firmware, not a browser, and the manual's sample is the
 * only known-good example in existence. "bare" additionally drops the XML
 * declaration, for the same reason.
 *
 * This is a knob rather than a decision because each round of finding out
 * costs somebody at a counter twenty minutes.
 */
export type SdpStyle = "pretty" | "compact" | "bare";

export function printRequestXml(
  jobs: QueuedPrint[],
  /* Epson's own sample says 10000 and there is no reason to differ. A value
     outside what the firmware expects is the kind of thing that makes a
     printer skip a job without saying why. */
  timeoutMs = 10000,
  version: SdpVersion = "1.00",
  devid = "local_printer",
  style: SdpStyle = "pretty"
): string {
  const nl = style === "compact" ? "" : "\n";
  const parts = jobs
    .map((j) =>
      [
        `<ePOSPrint>`,
        `<Parameter>`,
        `<devid>${esc(devid || "local_printer")}</devid>`,
        `<timeout>${Math.round(timeoutMs)}</timeout>`,
        ...(version === "2.00" ? [`<printjobid>${esc(j.id)}</printjobid>`] : []),
        `</Parameter>`,
        `<PrintData>`,
        j.body,
        `</PrintData>`,
        `</ePOSPrint>`,
      ].join(nl)
    )
    .join(nl);

  const open = version === "2.00" ? `<PrintRequestInfo Version="2.00">` : `<PrintRequestInfo>`;
  const body = [open, parts, `</PrintRequestInfo>`].join(nl);
  /* Spelled the way Epson's sample spells it, space before the close and all.
     There is no reason a parser should care and no reason to find out. */
  return style === "bare" ? body : `<?xml version="1.0" encoding="utf-8" ?>${nl}${body}`;
}

/**
 * Read the printer's report of how a job went.
 *
 * Deliberately not a real XML parse: this runs on every completion, the
 * document is machine-written and three attributes deep, and a parser
 * dependency to read `success="true"` would be the heaviest thing in the
 * printing path. Anything it can't make sense of is treated as a failure,
 * which puts the job back rather than losing it.
 */
export function readPrintResponse(xml: string): { jobId: string; ok: boolean; code: string; status: string; reported: boolean } {
  const s = String(xml || "");
  const jobId = (s.match(/<printjobid>([^<]*)<\/printjobid>/i) || [])[1] || "";
  /* Attributes are read from inside the <response> tag rather than from the
     document at large. The envelope around it carries a Version attribute and
     a namespace, and a loose search for code= has no way of knowing it has
     wandered into one of those. */
  /* No <response> element AT ALL is its own answer, and a different one from
     a job that failed. It means the printer read the request, found nothing it
     could run, and had nothing to report — which in practice means the device
     name in the request is not one this printer has. */
  const found = s.match(/<response\b[^>]*>/i);
  const tag = found ? found[0] : "";
  const attr = (name: string) => (tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i")) || [])[1] || "";
  return {
    jobId: jobId.trim(),
    ok: /^(true|1)$/i.test(attr("success").trim()),
    code: attr("code").trim(),
    status: attr("status").trim(),
    reported: !!found,
  };
}

/**
 * The simplest document the printer could possibly accept.
 *
 * Nothing but a line of text and a cut: no sizes, no alignment, no drawer, no
 * feed amount. When a full receipt is refused and this prints, the fault is a
 * particular element in the receipt rather than the connection, the address or
 * the protocol — which is a much smaller haystack.
 */
export const plainTestXml = (): string =>
  eposDoc(`<text>PLAIN TEST&#10;</text><text>If this prints, the link works.&#10;</text><feed line="3"/><cut/>`);

/**
 * The envelope the printer wants when it is spoken to directly.
 *
 * Server Direct Print wraps jobs in PrintRequestInfo because the printer is
 * fetching them. Talking to the printer's own ePOS-Print endpoint is the other
 * way round — we do the asking — and there it expects a SOAP body. Same
 * epos-print document inside either way, which is why the receipt builder
 * neither knows nor cares which route it takes.
 */
export const soapEnvelope = (eposPrintDoc: string): string =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
  `<s:Body>${eposPrintDoc}</s:Body>` +
  "</s:Envelope>";

/** Where the printer listens when it is being spoken to directly. */
export const directPrintUrl = (host: string, devid = "local_printer"): string =>
  `https://${String(host).trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")}` +
  `/cgi-bin/epos/service.cgi?devid=${encodeURIComponent(devid || "local_printer")}&timeout=10000`;

/**
 * The printer's error code, in words a person at the till can act on.
 *
 * Lives here rather than in the queue because the till needs it too, to put
 * the actual reason on the "Printer" badge instead of a generic guess.
 */
export function troubleText(code: string): string {
  const c = String(code || "").trim();
  const known: Record<string, string> = {
    EPTR_COVER_OPEN: "The printer cover is open — close it and it'll print.",
    EPTR_REC_EMPTY: "The printer is out of paper — load a roll and it'll print.",
    EPTR_AUTOMATICAL: "The printer stopped with an error — switch it off and on.",
    EPTR_UNRECOVERABLE: "The printer needs switching off and on.",
    EPTR_CUTTER: "The cutter is jammed — clear it and switch off and on.",
    EPTR_MECHANICAL: "The printer is jammed.",
    SchemaError: "The receipt itself was malformed — this one's on us, not the printer.",
    DeviceNotFound: "The printer couldn't find itself — check its settings.",
    PrintSystemError: "The printer reported a system error.",
    EX_BADPORT: "Can't reach the printer — check it's on and the tablet is on the shop wifi.",
    EX_TIMEOUT: "The printer timed out mid-job.",
  };
  if (known[c]) return known[c];
  return c ? `The printer refused the job (${c}).` : "The printer refused the job.";
}

/**
 * Errors a person fixes in ten seconds. A job refused for one of these is
 * retried until it prints rather than counted towards giving up — a roll
 * change must never be the reason a receipt is lost.
 */
export const isFixableByHand = (code: string): boolean =>
  ["EPTR_COVER_OPEN", "EPTR_REC_EMPTY"].includes(String(code || "").trim());

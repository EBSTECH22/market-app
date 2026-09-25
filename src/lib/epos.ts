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

export const EPOS_NS = "http://www.epson-pos.com/schemas/2011/03/epos-print";

/** 80mm paper, Font A. Narrower paper or Font B would change this. */
export const COLS = 48;

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

/** Wrap finished children in the document element the printer expects. */
export const eposDoc = (children: string): string =>
  `<epos-print xmlns="${EPOS_NS}">${children}</epos-print>`;

/* --------------------------------------------------------- the receipt -- */

export type ReceiptLine = {
  name: string;
  quantity: number;
  priceCents: number;
  basePriceCents?: number;
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
  /** Shop name and address, from settings, so a rename doesn't need a deploy. */
  header?: string[];
  footer?: string[];
  /** Printed across the top so nobody hands a duplicate over as the original. */
  reprint?: boolean;
  timeZone?: string;
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
  const when = new Date(sale.createdAt);
  const header = opts.header?.length ? opts.header : DEFAULT_HEADER;
  const footer = opts.footer?.length ? opts.footer : DEFAULT_FOOTER;

  const out: string[] = [];
  out.push(`<text align="center"/>`);

  /* The shop's name is the one thing on the receipt worth the double-size
     characters — everything else has to fit 48 columns, and doubling the width
     halves that to 24. */
  out.push(`<text width="2" height="2">${esc(header[0] || "")}&#10;</text>`);
  out.push(`<text width="1" height="1"/>`);
  for (const h of header.slice(1)) out.push(t(h));

  if (opts.reprint) {
    out.push(t(""));
    out.push(`<text em="true">${esc("*** REPRINT ***")}&#10;</text>`);
  }

  out.push(t(""));
  out.push(`<text align="left"/>`);
  out.push(t(rule()));
  out.push(t(pad(`RECEIPT #${sale.number}`, when.toLocaleDateString("en-US", { timeZone: tz }))));
  out.push(
    t(
      pad(
        sale.employee ? `CLERK: ${sale.employee}` : "",
        when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })
      )
    )
  );
  out.push(t(rule()));

  for (const l of sale.lines) {
    const qty = Math.max(1, Math.round(l.quantity));
    const unit = l.basePriceCents || l.priceCents;
    out.push(t(pad(`${qty}x ${l.name}`, money(unit * qty))));
    /* A discounted item shows what it normally is, indented under itself —
       people want to see the saving on the paper, not just in the total. */
    if (l.basePriceCents && l.priceCents !== l.basePriceCents) {
      out.push(t(pad(`   sale price`, money(l.priceCents * qty))));
    }
  }

  out.push(t(rule()));
  out.push(t(pad("SUBTOTAL", money(sale.subtotalCents + (sale.saleSavingsCents || 0)))));
  if (sale.saleSavingsCents) out.push(t(pad("SALE SAVINGS", `-${money(sale.saleSavingsCents)}`)));
  if (sale.cardAdjustCents) out.push(t(pad("NON-CASH ADJ", money(sale.cardAdjustCents))));

  if (sale.foodTaxCents && sale.standardTaxCents) {
    out.push(t(pad("TAX (GENERAL)", money(sale.standardTaxCents))));
    out.push(t(pad("TAX (FOOD)", money(sale.foodTaxCents))));
  } else {
    out.push(t(pad("TAX", money(sale.taxCents))));
  }
  if (sale.discountCents) out.push(t(pad("REWARDS", `-${money(sale.discountCents)}`)));

  out.push(`<text em="true" width="2" height="2">${esc(pad("TOTAL", money(sale.totalCents), Math.floor(COLS / 2)))}&#10;</text>`);
  out.push(`<text em="false" width="1" height="1"/>`);

  if ((sale.cashTenderedCents || 0) > 0) {
    out.push(t(pad("CASH", money(sale.cashTenderedCents || 0))));
    out.push(t(pad("CHANGE", money(sale.changeCents || 0))));
  }
  out.push(t(pad(sale.paymentMethod, sale.cardName ? String(sale.cardName) : "")));

  if (typeof sale.customerPoints === "number") {
    out.push(t(""));
    out.push(t(center(`REWARDS POINTS: ${sale.customerPoints}`)));
  }

  out.push(t(""));
  out.push(`<text align="center"/>`);
  for (const f of footer) out.push(t(f));

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
export function testXml(who: string, at: Date = new Date(), timeZone = "America/Chicago"): string {
  const out: string[] = [];
  out.push(`<text align="center"/>`);
  out.push(`<text width="2" height="2">${esc("TEST")}&#10;</text>`);
  out.push(`<text width="1" height="1"/>`);
  out.push(t("Community Harvest"));
  out.push(t(""));
  out.push(`<text align="left"/>`);
  out.push(t(rule()));
  out.push(t(pad("PRINTER", "OK")));
  out.push(t(pad("DRAWER", "kicking now")));
  out.push(t(pad("SENT BY", who || "the office")));
  out.push(t(pad("AT", at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone }))));
  out.push(t(rule()));
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

export function printRequestXml(
  jobs: QueuedPrint[],
  timeoutMs = 60000,
  version: SdpVersion = "1.00",
  devid = "local_printer"
): string {
  const parts = jobs
    .map(
      (j) =>
        `<ePOSPrint>` +
        `<Parameter>` +
        `<devid>${esc(devid || "local_printer")}</devid>` +
        `<timeout>${Math.round(timeoutMs)}</timeout>` +
        (version === "2.00" ? `<printjobid>${esc(j.id)}</printjobid>` : "") +
        `</Parameter>` +
        `<PrintData>${j.body}</PrintData>` +
        `</ePOSPrint>`
    )
    .join("");
  const open = version === "2.00" ? `<PrintRequestInfo Version="2.00">` : `<PrintRequestInfo>`;
  /* Spelled the way Epson's sample spells it, space before the close and all.
     There is no reason a parser should care and no reason to find out. */
  return `<?xml version="1.0" encoding="utf-8" ?>${open}${parts}</PrintRequestInfo>`;
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

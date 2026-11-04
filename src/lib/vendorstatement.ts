import { db } from "@/lib/db";
import { TZ, centralInputToDate } from "@/lib/time";
import { shiftDays } from "@/lib/payperiod";

/**
 * Everything that happened on one vendor's account between two dates.
 *
 * ONE BUILDER, THREE CONSUMERS — the screen, the print page and the email all
 * call this. The alternative is three places that each decide what a refund
 * does to a balance, and the first time they disagree the vendor is holding a
 * statement that contradicts the one in the office.
 *
 * IT RECONCILES, and that is the whole design. Opening balance, every movement
 * in order, closing balance — and the closing balance is the plain sum of the
 * ledger, which is what the balance means everywhere else in this app and what
 * the payout screen pays. A statement whose total disagrees with what the
 * vendor is paid is worse than no statement.
 *
 * The sales detail is a SEPARATE section, not the spine. "SALE +$9.00" on a
 * Tuesday tells a vendor nothing; they want to know which jar sold. But the
 * money column is the ledger, because that is what was settled.
 */

export type StatementLine = {
  /** ISO instant, for sorting and for the caller to format. */
  at: string;
  dateStr: string;
  timeStr: string;
  /** SALE | REFUND | VOID | RENT | RENT_PAYMENT | PAYOUT | PAYOUT_FEE | ADJUST | COMPLAINT */
  type: string;
  label: string;
  note: string;
  /** Signed, in cents. Positive is money towards the vendor. */
  amountCents: number;
  /** The account balance immediately after this line. */
  balanceCents: number;
};

export type StatementSale = {
  at: string;
  dateStr: string;
  timeStr: string;
  ticket: number;
  item: string;
  optionsText: string;
  quantity: number;
  /** What the customer paid for the line. */
  grossCents: number;
  /** The market's share of it — service fee plus any commission. */
  marketShareCents: number;
  /** What it put on the vendor's account. */
  netCents: number;
  /** VOIDED tickets are excluded entirely; this flags a partly-refunded one. */
  saleStatus: string;
};

export type VendorStatement = {
  vendor: { id: string; code: string; businessName: string; email: string; contactName: string };
  from: string;
  to: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  lines: StatementLine[];
  sales: StatementSale[];
  totals: {
    salesGrossCents: number;
    marketShareCents: number;
    salesNetCents: number;
    refundsCents: number;
    rentChargedCents: number;
    rentPaidCents: number;
    paidOutCents: number;
    adjustmentsCents: number;
    unitsSold: number;
    /** Anything the named buckets above don't cover. Normally zero. */
    otherCents: number;
  };
};

/** What each ledger type is called on a statement a vendor reads. */
const LABEL: Record<string, string> = {
  SALE: "Sold at the market",
  REFUND: "Refund to a customer",
  VOID: "Ticket voided",
  RENT: "Booth rent",
  RENT_PAYMENT: "Rent you paid",
  PAYOUT: "Paid out to you",
  PAYOUT_FEE: "Transfer fee",
  ADJUST: "Adjustment",
  COMPLAINT: "Complaint credit",
};

/**
 * Central midnight to Central midnight.
 *
 * The end is the NEXT day's midnight less a millisecond rather than the start
 * plus 24 hours, because a range that ends on the day the clocks go back is 25
 * hours long — and +24h would drop the last hour of trading off the statement.
 */
function window_(from: string, to: string) {
  return {
    start: centralInputToDate(`${from}T00:00`),
    end: new Date(centralInputToDate(`${shiftDays(to, 1)}T00:00`).getTime() - 1),
  };
}

const dateStr = (d: Date) =>
  d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: TZ });
const timeStr = (d: Date) =>
  d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });

export async function buildVendorStatement(
  vendorId: string,
  from: string,
  to: string
): Promise<VendorStatement | null> {
  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, code: true, businessName: true, email: true, contactName: true },
  });
  if (!vendor) return null;

  const { start, end } = window_(from, to);

  /* Where the account stood the instant before the period opened. Without it
     the movements below are a list rather than a statement. */
  const opening = await db.ledgerEntry.aggregate({
    where: { vendorId, createdAt: { lt: start } },
    _sum: { amountCents: true },
  });
  const openingBalanceCents = opening._sum.amountCents || 0;

  const entries = await db.ledgerEntry.findMany({
    where: { vendorId, createdAt: { gte: start, lte: end } },
    orderBy: { createdAt: "asc" },
  });

  /* The sales detail, at the split decided at the till. Never recomputed from
     today's fee or today's price — a vendor whose rate changed mid-period must
     not have the earlier weeks quietly restated. VOIDED tickets are left out
     altogether: the ticket never happened, and its reversal is on the ledger
     below where the money is. */
  const lines = await db.saleLine.findMany({
    where: {
      vendorId,
      sale: { createdAt: { gte: start, lte: end }, status: { not: "VOIDED" } },
    },
    select: {
      name: true, optionsText: true, quantity: true, priceCents: true,
      commissionCents: true, vendorNetCents: true,
      sale: { select: { number: true, createdAt: true, status: true } },
    },
  });

  const sales: StatementSale[] = lines
    .filter((l) => l.sale)
    .map((l) => ({
      at: l.sale!.createdAt.toISOString(),
      dateStr: dateStr(l.sale!.createdAt),
      timeStr: timeStr(l.sale!.createdAt),
      ticket: l.sale!.number,
      item: l.name,
      optionsText: l.optionsText || "",
      quantity: l.quantity,
      grossCents: l.priceCents * l.quantity,
      marketShareCents: l.commissionCents,
      netCents: l.vendorNetCents,
      saleStatus: l.sale!.status,
    }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.ticket - b.ticket);

  /* A running balance down the page, so any line can be pointed at and
     explained. Starts from the opening balance, not from zero. */
  let running = openingBalanceCents;
  const statementLines: StatementLine[] = entries.map((e) => {
    running += e.amountCents;
    return {
      at: e.createdAt.toISOString(),
      dateStr: dateStr(e.createdAt),
      timeStr: timeStr(e.createdAt),
      type: e.type,
      label: LABEL[e.type] || "Account activity",
      note: e.note || "",
      amountCents: e.amountCents,
      balanceCents: running,
    };
  });

  const t = {
    salesGrossCents: 0, marketShareCents: 0, salesNetCents: 0, refundsCents: 0,
    rentChargedCents: 0, rentPaidCents: 0, paidOutCents: 0, adjustmentsCents: 0,
    unitsSold: 0, otherCents: 0,
  };
  for (const s of sales) {
    t.salesGrossCents += s.grossCents;
    t.marketShareCents += s.marketShareCents;
    t.unitsSold += s.quantity;
  }

  /* The money buckets come off the LEDGER, not off the sale lines, so they
     agree with the closing balance. `otherCents` catches anything a bucket
     doesn't name — normally nothing, reported rather than hidden because
     somebody will add the column up. */
  let explained = 0;
  for (const e of entries) {
    switch (e.type) {
      case "SALE": t.salesNetCents += e.amountCents; explained += e.amountCents; break;
      case "REFUND":
      case "VOID": t.refundsCents += Math.abs(e.amountCents); explained += e.amountCents; break;
      case "RENT":
        /* Charges are stored negative and credits positive — a closed-day
           credit is a positive RENT line — so this is a negated sum, not an
           absolute one. */
        t.rentChargedCents -= e.amountCents; explained += e.amountCents; break;
      case "RENT_PAYMENT": t.rentPaidCents += e.amountCents; explained += e.amountCents; break;
      case "PAYOUT":
      case "PAYOUT_FEE": t.paidOutCents += Math.abs(e.amountCents); explained += e.amountCents; break;
      default: t.adjustmentsCents += e.amountCents; explained += e.amountCents; break;
    }
  }
  const movement = entries.reduce((n, e) => n + e.amountCents, 0);
  t.otherCents = movement - explained;

  return {
    vendor,
    from,
    to,
    openingBalanceCents,
    closingBalanceCents: openingBalanceCents + movement,
    lines: statementLines,
    sales,
    totals: t,
  };
}

/** Every vendor who had ANY activity in the period, plus anyone carrying a balance. */
export async function vendorsWithActivity(from: string, to: string): Promise<string[]> {
  const { start, end } = window_(from, to);
  const [moved, held] = await Promise.all([
    db.ledgerEntry.groupBy({ by: ["vendorId"], where: { createdAt: { gte: start, lte: end } } }),
    db.ledgerEntry.groupBy({ by: ["vendorId"], _sum: { amountCents: true } }),
  ]);
  const ids = new Set(moved.map((m) => m.vendorId));
  for (const h of held) if ((h._sum.amountCents || 0) !== 0) ids.add(h.vendorId);

  /* Active vendors only — a statement to somebody who left the market last
     year is a confusing email, not a service. */
  const active = await db.vendor.findMany({
    where: { id: { in: [...ids] }, active: true },
    select: { id: true },
  });
  return active.map((v) => v.id);
}

/** The statement as a CSV, for whoever does their books. */
export function statementCsv(s: VendorStatement): string {
  const cell = (v: string | number) => {
    const str = String(v);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const money = (c: number) => (c / 100).toFixed(2);
  const rows: string[] = [];
  rows.push(cell(`Statement for ${s.vendor.businessName} (${s.vendor.code})`));
  rows.push(cell(`${s.from} to ${s.to}`));
  rows.push("");
  rows.push("Account activity");
  rows.push(["Date", "Time", "What", "Detail", "Amount", "Balance"].map(cell).join(","));
  rows.push(["", "", "Opening balance", "", "", money(s.openingBalanceCents)].map(cell).join(","));
  for (const l of s.lines) {
    rows.push([l.dateStr, l.timeStr, l.label, l.note, money(l.amountCents), money(l.balanceCents)].map(cell).join(","));
  }
  rows.push(["", "", "Closing balance", "", "", money(s.closingBalanceCents)].map(cell).join(","));
  rows.push("");
  rows.push("What sold");
  rows.push(["Date", "Time", "Ticket", "Item", "Choices", "Qty", "Customer paid", "Market's share", "Your share"].map(cell).join(","));
  for (const x of s.sales) {
    rows.push([x.dateStr, x.timeStr, `#${x.ticket}`, x.item, x.optionsText, x.quantity,
      money(x.grossCents), money(x.marketShareCents), money(x.netCents)].map(cell).join(","));
  }
  return rows.join("\n");
}

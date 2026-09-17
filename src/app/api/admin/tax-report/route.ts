import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { getTaxRates } from "@/lib/settings";
import { taxFor, normalizeTaxClass } from "@/lib/tax";
import { TZ, centralInputToDate } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * The sales tax return, month by month.
 *
 * Oklahoma exempts food and food ingredients from the STATE portion but not the
 * local portion, so a month's takings have to be filed as two different bases at
 * two different rates. The sales report sums one `taxCents` number, which is the
 * right number for "how did we do" and the wrong one for a return.
 *
 * THREE DECISIONS WORTH KNOWING ABOUT:
 *
 * 1. SALES AND RETURNS ARE SEPARATE, BY DATE. A ticket counts in the month it
 *    was rung; a refund or void counts in the month it was given back. The
 *    obvious alternative — excluding voided tickets — silently rewrites a month
 *    you have already filed the moment somebody voids an old ticket. A return
 *    filed in March must still foot to March's report in July.
 *
 * 2. TAX COMES FROM WHAT WAS CHARGED, NOT FROM TODAY'S RATES. Every sale stores
 *    its own food/standard split, so changing the rate in Settings cannot move
 *    last month's figures.
 *
 * 3. THE BASE IS RECOMPUTED, THE TAX IS NOT. Which bucket each line belongs in
 *    is a property of the line (its taxClass, snapshotted at sale time), and the
 *    card adjustment is spread across the buckets exactly the way the register
 *    spread it — same function, same arithmetic. No rate is involved in that, so
 *    it is safe to derive.
 */

type Bucket = {
  standardSalesCents: number;
  foodSalesCents: number;
  standardTaxCents: number;
  foodTaxCents: number;
  standardReturnedCents: number;
  foodReturnedCents: number;
  standardTaxReturnedCents: number;
  foodTaxReturnedCents: number;
  tickets: number;
  returns: number;
  /** Tickets rung before the food/standard split existed. */
  preSplitTickets: number;
};

const empty = (): Bucket => ({
  standardSalesCents: 0, foodSalesCents: 0,
  standardTaxCents: 0, foodTaxCents: 0,
  standardReturnedCents: 0, foodReturnedCents: 0,
  standardTaxReturnedCents: 0, foodTaxReturnedCents: 0,
  tickets: 0, returns: 0, preSplitTickets: 0,
});

/** YYYY-MM in the market's timezone, so a 11pm sale files in the right month. */
const monthKey = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(d).slice(0, 7);

const monthLabel = (key: string): string => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

/** Just enough of a sale to work out its bases — both queries below satisfy it. */
type Taxable = {
  cardAdjustCents: number;
  lines: { priceCents: number; quantity: number; taxClass: string }[];
};

/**
 * Pre-tax base per bucket, exactly as the register computed it.
 *
 * Rates of zero are passed deliberately: only the BASES are wanted here, and
 * `taxFor` splits the card adjustment across the buckets without reference to
 * any rate. The tax itself is read off the stored row.
 */
function basesFor(sale: Taxable): { standard: number; food: number } {
  const split = taxFor(
    sale.lines.map((l) => ({ amountCents: l.priceCents * l.quantity, taxClass: normalizeTaxClass(l.taxClass) })),
    { standardPercent: 0, foodPercent: 0 },
    sale.cardAdjustCents || 0
  );
  return { standard: split.standardBaseCents, food: split.foodBaseCents };
}

const hasSplit = (s: { foodTaxCents: number; standardTaxCents: number }) =>
  (s.foodTaxCents || 0) > 0 || (s.standardTaxCents || 0) > 0;

export async function GET(req: NextRequest) {
  return runRoute("admin/tax-report GET", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }

    const p = req.nextUrl.searchParams;
    const monthsBack = Math.min(36, Math.max(1, Number(p.get("months") || 13)));
    const selected = /^\d{4}-\d{2}$/.test(p.get("month") || "") ? String(p.get("month")) : monthKey(new Date());

    /* Window: the start of the oldest month wanted, through the end of the
       selected one. Built from the selected month rather than today, so looking
       back at last year pulls last year's neighbours and not this year's.
       Month arithmetic is done in absolute months to avoid the usual December
       off-by-one. */
    const [selY, selM] = selected.split("-").map(Number);
    const selAbs = selY * 12 + (selM - 1);
    const startAbs = selAbs - (monthsBack - 1);
    const ym = (abs: number) => `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}`;
    const start = centralInputToDate(`${ym(startAbs)}-01T00:00`);
    const endExclusive = centralInputToDate(`${ym(selAbs + 1)}-01T00:00`);

    const sales = await db.sale.findMany({
      where: { createdAt: { gte: start, lt: endExclusive } },
      select: {
        id: true, createdAt: true, subtotalCents: true, taxCents: true, cardAdjustCents: true,
        foodTaxCents: true, standardTaxCents: true,
        lines: { select: { priceCents: true, quantity: true, taxClass: true } },
      },
    });

    const refunds = await db.refund.findMany({
      where: { createdAt: { gte: start, lt: endExclusive } },
      select: { id: true, saleId: true, createdAt: true, amountCents: true, taxCents: true, linesJson: true },
    });

    /* A refund's tax has to be split the way the ORIGINAL ticket was taxed, so
       the sales behind them are loaded even when they were rung in an earlier
       month. Explicit generics on the Map: `new Map(arr.map(...))` infers the
       value as `{}` and then fails the production build on first use. */
    const refundSaleIds = [...new Set(refunds.map((r) => r.saleId))];
    const refundSales = refundSaleIds.length
      ? await db.sale.findMany({
          where: { id: { in: refundSaleIds } },
          select: {
            id: true, subtotalCents: true, taxCents: true, cardAdjustCents: true,
            foodTaxCents: true, standardTaxCents: true,
            lines: { select: { id: true, priceCents: true, quantity: true, taxClass: true } },
          },
        })
      : [];
    type RefundSale = (typeof refundSales)[number];
    const saleById = new Map<string, RefundSale>(refundSales.map((s) => [s.id, s] as [string, RefundSale]));

    const months = new Map<string, Bucket>();
    const bucketFor = (d: Date): Bucket => {
      const k = monthKey(d);
      const b = months.get(k) || empty();
      months.set(k, b);
      return b;
    };

    for (const s of sales) {
      const b = bucketFor(s.createdAt);
      b.tickets++;
      const base = basesFor(s);
      if (hasSplit(s)) {
        b.standardSalesCents += base.standard;
        b.foodSalesCents += base.food;
        b.standardTaxCents += s.standardTaxCents;
        b.foodTaxCents += s.foodTaxCents;
      } else {
        /* Before the split, one rate applied to everything on the ticket. Filing
           those as "food" because the item is a loaf of bread today would claim
           an exemption that was never taken at the till. */
        b.preSplitTickets++;
        b.standardSalesCents += base.standard + base.food;
        b.standardTaxCents += s.taxCents;
      }
    }

    for (const r of refunds) {
      const b = bucketFor(r.createdAt);
      b.returns++;
      const sale = saleById.get(r.saleId);
      if (!sale) {
        // Orphaned refund (the sale was hard-deleted). Report it rather than
        // dropping it; the full rate is the safe direction to be wrong in.
        b.standardReturnedCents += r.amountCents;
        b.standardTaxReturnedCents += r.taxCents;
        continue;
      }

      let food = 0;
      let standard = 0;
      const picks = (() => {
        try { return JSON.parse(r.linesJson || "[]") as { lineId: string; quantity: number }[]; }
        catch { return []; }
      })();
      for (const pick of picks) {
        const line = sale.lines.find((l) => l.id === pick.lineId);
        if (!line) continue;
        const amount = line.priceCents * Math.max(0, Math.round(pick.quantity));
        if (normalizeTaxClass(line.taxClass) === "FOOD") food += amount;
        else standard += amount;
      }
      /* Nothing matched — an old refund whose linesJson predates line ids, or a
         void written before lines were recorded. Fall back to the refund's own
         subtotal at the ticket's class mix. */
      if (food + standard === 0) {
        const base = basesFor(sale);
        const total = base.standard + base.food || 1;
        food = Math.round((r.amountCents * base.food) / total);
        standard = r.amountCents - food;
      }

      if (hasSplit(sale)) {
        const saleBase = basesFor(sale);
        b.foodReturnedCents += food;
        b.standardReturnedCents += standard;
        b.foodTaxReturnedCents += Math.round((sale.foodTaxCents * food) / (saleBase.food || 1));
        b.standardTaxReturnedCents += Math.round((sale.standardTaxCents * standard) / (saleBase.standard || 1));
      } else {
        b.standardReturnedCents += food + standard;
        b.standardTaxReturnedCents += r.taxCents;
      }
    }

    const rates = await getTaxRates();
    /* The food rate IS the local portion (food is exempt from the state part
       only), so the difference between the two rates is the state portion. */
    const statePercent = Math.round((rates.standardPercent - rates.foodPercent) * 1000) / 1000;

    const rows = [...months.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([key, b]) => {
        const netStandard = b.standardSalesCents - b.standardReturnedCents;
        const netFood = b.foodSalesCents - b.foodReturnedCents;
        const netStandardTax = b.standardTaxCents - b.standardTaxReturnedCents;
        const netFoodTax = b.foodTaxCents - b.foodTaxReturnedCents;
        return {
          month: key,
          label: monthLabel(key),
          tickets: b.tickets,
          returns: b.returns,
          preSplitTickets: b.preSplitTickets,
          /* Everything sold, before tax — the "gross receipts" line. */
          grossSalesCents: netStandard + netFood,
          /* Food is deducted from the state base and stays in the local base. */
          stateTaxableCents: netStandard,
          localTaxableCents: netStandard + netFood,
          exemptFromStateCents: netFood,
          standardSalesCents: netStandard,
          foodSalesCents: netFood,
          standardTaxCents: netStandardTax,
          foodTaxCents: netFoodTax,
          taxCollectedCents: netStandardTax + netFoodTax,
          returnedSalesCents: b.standardReturnedCents + b.foodReturnedCents,
          returnedTaxCents: b.standardTaxReturnedCents + b.foodTaxReturnedCents,
        };
      });

    const current = rows.find((r) => r.month === selected) || {
      month: selected, label: monthLabel(selected), tickets: 0, returns: 0, preSplitTickets: 0,
      grossSalesCents: 0, stateTaxableCents: 0, localTaxableCents: 0, exemptFromStateCents: 0,
      standardSalesCents: 0, foodSalesCents: 0, standardTaxCents: 0, foodTaxCents: 0,
      taxCollectedCents: 0, returnedSalesCents: 0, returnedTaxCents: 0,
    };

    if (p.get("format") === "csv") {
      const head = [
        "Month", "Tickets", "Gross sales", "Taxable (general)", "Exempt from state (food)",
        "Local taxable (all)", "General tax", "Food tax", "Tax collected",
        "Returns", "Tax returned",
      ];
      const money = (c: number) => (c / 100).toFixed(2);
      const body = rows.map((r) => [
        r.month, r.tickets, money(r.grossSalesCents), money(r.stateTaxableCents), money(r.exemptFromStateCents),
        money(r.localTaxableCents), money(r.standardTaxCents), money(r.foodTaxCents), money(r.taxCollectedCents),
        money(r.returnedSalesCents), money(r.returnedTaxCents),
      ]);
      const csv = [head, ...body]
        .map((line) => line.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
        .join("\r\n");
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="sales-tax-${selected}.csv"`,
        },
      });
    }

    return NextResponse.json({
      selected,
      current,
      months: rows,
      rates: {
        standardPercent: rates.standardPercent,
        foodPercent: rates.foodPercent,
        statePercent: statePercent > 0 ? statePercent : 0,
        /* Both rates the same means the food rate has never been entered, so
           nothing has actually been split yet. The UI says so rather than
           showing a food column full of zeroes and letting it look like the
           market sells no groceries. */
        splitConfigured: rates.foodPercent !== rates.standardPercent,
      },
    });
  });
}

import { enqueue, handOff, type PrintNow } from "@/lib/printqueue";
import { receiptXml, receiptWithDrawerXml, drawerXml, type ReceiptSale } from "@/lib/epos";
import type { TillSettings } from "@/lib/settings";

/**
 * The paper (and the drawer) for a booked sale. One place, used by the
 * register sale and the vendor booth ticket, so both behave the same.
 *
 * - Cash opens the drawer in the same job as the receipt.
 * - Receipts switched off still opens the drawer on cash. Before, turning off
 *   auto-print also stopped the drawer opening, because the kick only ever
 *   rode along with a receipt.
 * - When the till asked (printHere), the job comes straight back to it to
 *   carry to the printer now. Otherwise it waits in the queue and the till's
 *   print agent picks it up within a few seconds.
 *
 * Never throws: the sale is already in the books, and paper is the least
 * important thing that just happened.
 */
export async function printForSale(
  sale: ReceiptSale,
  o: { saleId: string; clerk: string; printHere: boolean; cfg: TillSettings }
): Promise<PrintNow> {
  try {
    const cash = sale.paymentMethod === "CASH";
    const cfg = o.cfg;
    let body = "";
    let kind = "RECEIPT";
    let label = `Receipt #${sale.number}`;

    if (cfg.autoPrint) {
      const opts = {
        header: cfg.header, footer: cfg.footer, cols: cfg.cols, logo: cfg.logo, logoSize: cfg.logoSize,
        logoSource: cfg.logoSource, logoKey1: cfg.logoKey1, logoKey2: cfg.logoKey2,
      };
      body = cash ? receiptWithDrawerXml(sale, opts) : receiptXml(sale, opts);
    } else if (cash) {
      body = drawerXml();
      kind = "DRAWER";
      label = `Drawer — cash sale #${sale.number}`;
    } else {
      return null;
    }

    const id = await enqueue({ kind, label, saleId: o.saleId, createdBy: o.clerk, body });
    return o.printHere ? await handOff(id, body, cfg) : null;
  } catch (err) {
    console.error("receipt queue failed", err);
    return null;
  }
}

import { db } from "@/lib/db";
import { pushToAdmin } from "@/lib/push";
import { money } from "@/lib/format";

/**
 * Tell the office a vendor just paid.
 *
 * Call this ONLY where a payment is newly recorded — inside the `!already`
 * branch. Both confirm endpoints are hit again whenever the success page is
 * reloaded, and the ledger's marker check is what stops a double entry; putting
 * the push outside that check would buzz on every refresh.
 *
 * Deliberately not called from admin settlement: charging a card on file is
 * something the office just did on purpose, and it already sees the result.
 */
export async function notifyRentPaid(
  vendorId: string,
  opts: { paidCents: number; feeCents?: number; last4?: string; source: "link" | "portal" }
): Promise<void> {
  try {
    const vendor = await db.vendor.findUnique({
      where: { id: vendorId },
      select: { businessName: true, code: true },
    });
    if (!vendor) return;

    const contract = await db.contract.findFirst({
      where: { vendorId, status: { notIn: ["VOIDED", "ENDED", "WITHDRAWN"] } },
      orderBy: { createdAt: "desc" },
      select: { boothLabel: true },
    });

    // Read the balance after the entry has landed, so "settled" is accurate.
    const agg = await db.ledgerEntry.aggregate({
      where: { vendorId },
      _sum: { amountCents: true },
    });
    const balance = agg._sum.amountCents || 0;
    const stillOwes = balance < 0 ? -balance : 0;

    const booth = contract?.boothLabel ? ` · booth ${contract.boothLabel}` : "";
    const card = opts.last4 ? ` ····${opts.last4}` : "";
    const where = opts.source === "portal" ? "from their portal" : "from their invoice link";

    const tail = stillOwes > 0
      ? `Still owes ${money(stillOwes)}.`
      : "Paid in full — their portal is open and the setup guide is on its way.";

    await pushToAdmin(
      `${vendor.businessName} paid ${money(opts.paidCents)}`,
      `${vendor.code}${booth} · ${where}${card}. ${tail}`
    );
  } catch {
    // A payment must never fail because a notification did.
  }
}

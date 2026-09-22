import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { drawerIdForRefund } from "@/lib/drawer";
import { currentEmployeeId, isAdmin } from "@/lib/auth";
import { denyUnless } from "@/lib/perm";
import { recordAudit, checkApproval } from "@/lib/audit";

export const dynamic = "force-dynamic";

// POST { saleId, action: "void", approvalPin? } — full void: never happened, restock everything, reverse vendor credits
// POST { saleId, action: "refund", lines: [{ lineId, quantity }], restock, approvalPin? } — partial/full refund with proportional tax
export async function POST(req: NextRequest) {
  { const denied = await denyUnless("money"); if (denied) return denied; }
  const { saleId, action, lines, restock, approvalPin } = await req.json();
  const sale = await db.sale.findUnique({ where: { id: saleId }, include: { lines: true } });
  if (!sale) return NextResponse.json({ error: "Sale not found." }, { status: 404 });
  if (sale.status === "VOIDED") return NextResponse.json({ error: "Already voided." }, { status: 400 });

  let empName = "";
  const empId = currentEmployeeId();
  if (empId) empName = (await db.employee.findUnique({ where: { id: empId } }))?.name || "";
  else if (isAdmin()) empName = "ADMIN";
  /* Cash handed back comes out of the refunder's own drawer, so that till's
     count expects it. Card refunds touch no drawer. */
  const refundDrawerId = sale.paymentMethod === "CASH" ? await drawerIdForRefund() : "";

  if (action === "void") {
    /* Approval BEFORE anything moves. A void hands back the whole ticket, so
       it's checked against the same threshold as a refund of that size. */
    const approval = await checkApproval(sale.totalCents, approvalPin);
    if (!approval.ok) {
      return NextResponse.json({ error: approval.error, needsApproval: true }, { status: 400 });
    }

    await db.$transaction(async (tx) => {
      for (const l of sale.lines) {
        await tx.item.update({ where: { id: l.itemId }, data: { quantity: { increment: l.quantity } } }).catch(() => {});
        await tx.ledgerEntry.create({
          data: { vendorId: l.vendorId, type: "VOID", amountCents: -l.vendorNetCents, note: `Void of ticket #${sale.number}: ${l.quantity}x ${l.name}` },
        });
      }
      await tx.sale.update({ where: { id: sale.id }, data: { status: "VOIDED" } });
      await tx.refund.create({
        data: {
          saleId: sale.id, employee: empName, method: sale.paymentMethod, drawerId: refundDrawerId,
          amountCents: sale.subtotalCents, taxCents: sale.taxCents, restocked: true,
          linesJson: JSON.stringify(sale.lines.map((l) => ({ lineId: l.id, quantity: l.quantity }))),
          note: `VOID ticket #${sale.number}`,
        },
      });
    });

    await recordAudit(
      {
        action: "SALE_VOID",
        targetType: "SALE",
        targetId: sale.id,
        targetLabel: `Ticket #${sale.number}`,
        amountCents: sale.totalCents,
        detail: `Voided ticket #${sale.number} (${sale.paymentMethod.toLowerCase()}) — ${sale.lines.length} line${sale.lines.length === 1 ? "" : "s"} restocked`,
        before: { status: sale.status, totalCents: sale.totalCents },
        after: { status: "VOIDED" },
        approvedBy: approval.required ? approval.approvedBy : "",
      },
      req
    );

    return NextResponse.json({ ok: true, kind: "VOID", cashBack: sale.paymentMethod === "CASH" ? sale.totalCents : 0 });
  }

  if (action === "refund") {
    const picks = (lines || []) as { lineId: string; quantity: number }[];
    if (!picks.length) return NextResponse.json({ error: "Pick at least one item to refund." }, { status: 400 });

    const prior = await db.refund.findMany({ where: { saleId: sale.id } });
    const already: Record<string, number> = {};
    for (const r of prior) {
      for (const pl of JSON.parse(r.linesJson || "[]") as { lineId: string; quantity: number }[]) {
        already[pl.lineId] = (already[pl.lineId] || 0) + pl.quantity;
      }
    }

    let refundSubtotal = 0;
    // Tracked per tax class, because food and general goods were taxed at
    // different rates on this ticket.
    let refundFoodBase = 0;
    let refundStandardBase = 0;
    const applied: { lineId: string; quantity: number }[] = [];
    for (const p of picks) {
      const line = sale.lines.find((l) => l.id === p.lineId);
      if (!line) return NextResponse.json({ error: "Line not found." }, { status: 400 });
      const q = Math.max(1, Math.round(p.quantity));
      const left = line.quantity - (already[line.id] || 0);
      if (q > left) return NextResponse.json({ error: `Only ${left} of ${line.name} left to refund on this ticket.` }, { status: 400 });
      const amount = line.priceCents * q;
      refundSubtotal += amount;
      if (String(line.taxClass || "STANDARD").toUpperCase() === "FOOD") refundFoodBase += amount;
      else refundStandardBase += amount;
      applied.push({ lineId: line.id, quantity: q });
    }

    /* Give back the tax that was actually charged on THESE lines.
       Prorating the whole ticket's tax by subtotal share was exact while every
       line carried the same rate. With food at a lower rate it isn't: refunding
       the groceries off a mixed ticket would hand back the ticket's average
       rate, which is more tax than was ever collected on them, and refunding
       the crafts would hand back too little. So each class is prorated against
       its own base and its own recorded tax. */
    const saleFoodBase = sale.lines
      .filter((l) => String(l.taxClass || "STANDARD").toUpperCase() === "FOOD")
      .reduce((n, l) => n + l.priceCents * l.quantity, 0);
    const saleStandardBase = sale.subtotalCents - saleFoodBase;

    const hasSplit = (sale.foodTaxCents || 0) > 0 || (sale.standardTaxCents || 0) > 0;
    const refundTax = hasSplit
      ? Math.round((sale.foodTaxCents * refundFoodBase) / (saleFoodBase || 1)) +
        Math.round((sale.standardTaxCents * refundStandardBase) / (saleStandardBase || 1))
      // Tickets rung before the split existed only ever had one rate, so the
      // old proportional calculation is still the right one for them.
      : Math.round((sale.taxCents * refundSubtotal) / (sale.subtotalCents || 1));

    /* Checked once the amount is known — the threshold is about how much money
       is going back, not how many lines were ticked. */
    const approval = await checkApproval(refundSubtotal + refundTax, approvalPin);
    if (!approval.ok) {
      return NextResponse.json({ error: approval.error, needsApproval: true }, { status: 400 });
    }

    await db.$transaction(async (tx) => {
      for (const p of applied) {
        const line = sale.lines.find((l) => l.id === p.lineId)!;
        if (restock !== false) {
          await tx.item.update({ where: { id: line.itemId }, data: { quantity: { increment: p.quantity } } }).catch(() => {});
        }
        const netBack = Math.round((line.vendorNetCents * p.quantity) / line.quantity);
        await tx.ledgerEntry.create({
          data: { vendorId: line.vendorId, type: "REFUND", amountCents: -netBack, note: `Refund on ticket #${sale.number}: ${p.quantity}x ${line.name}` },
        });
      }
      const totalRefunded = prior.reduce((n, r) => n + r.amountCents, 0) + refundSubtotal;
      await tx.sale.update({
        where: { id: sale.id },
        data: { status: totalRefunded >= sale.subtotalCents ? "REFUNDED" : "PARTIAL_REFUND" },
      });
      await tx.refund.create({
        data: {
          saleId: sale.id, employee: empName, method: sale.paymentMethod, drawerId: refundDrawerId,
          amountCents: refundSubtotal, taxCents: refundTax, restocked: restock !== false,
          linesJson: JSON.stringify(applied), note: `Refund ticket #${sale.number}`,
        },
      });
    });
    const refundedNames = applied
      .map((p) => {
        const line = sale.lines.find((l) => l.id === p.lineId);
        return line ? `${p.quantity}× ${line.name}` : "";
      })
      .filter(Boolean)
      .join(", ");

    await recordAudit(
      {
        action: "SALE_REFUND",
        targetType: "SALE",
        targetId: sale.id,
        targetLabel: `Ticket #${sale.number}`,
        amountCents: refundSubtotal + refundTax,
        detail: `Refunded ${refundedNames || "items"} on #${sale.number}${restock === false ? " (not restocked)" : ""}`,
        after: { refundSubtotal, refundTax, method: sale.paymentMethod },
        approvedBy: approval.required ? approval.approvedBy : "",
      },
      req
    );

    return NextResponse.json({
      ok: true, kind: "REFUND",
      refundCents: refundSubtotal + refundTax,
      cashBack: sale.paymentMethod === "CASH" ? refundSubtotal + refundTax : 0,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

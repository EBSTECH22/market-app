import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isStaff, currentEmployeeId, isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST { saleId, action: "void" } — full void: never happened, restock everything, reverse vendor credits
// POST { saleId, action: "refund", lines: [{ lineId, quantity }], restock } — partial/full refund with proportional tax
export async function POST(req: NextRequest) {
  if (!isStaff()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { saleId, action, lines, restock } = await req.json();
  const sale = await db.sale.findUnique({ where: { id: saleId }, include: { lines: true } });
  if (!sale) return NextResponse.json({ error: "Sale not found." }, { status: 404 });
  if (sale.status === "VOIDED") return NextResponse.json({ error: "Already voided." }, { status: 400 });

  let empName = "";
  const empId = currentEmployeeId();
  if (empId) empName = (await db.employee.findUnique({ where: { id: empId } }))?.name || "";
  else if (isAdmin()) empName = "ADMIN";

  if (action === "void") {
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
          saleId: sale.id, employee: empName, method: sale.paymentMethod,
          amountCents: sale.subtotalCents, taxCents: sale.taxCents, restocked: true,
          linesJson: JSON.stringify(sale.lines.map((l) => ({ lineId: l.id, quantity: l.quantity }))),
          note: `VOID ticket #${sale.number}`,
        },
      });
    });
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
    const applied: { lineId: string; quantity: number }[] = [];
    for (const p of picks) {
      const line = sale.lines.find((l) => l.id === p.lineId);
      if (!line) return NextResponse.json({ error: "Line not found." }, { status: 400 });
      const q = Math.max(1, Math.round(p.quantity));
      const left = line.quantity - (already[line.id] || 0);
      if (q > left) return NextResponse.json({ error: `Only ${left} of ${line.name} left to refund on this ticket.` }, { status: 400 });
      refundSubtotal += line.priceCents * q;
      applied.push({ lineId: line.id, quantity: q });
    }
    // proportional tax at this ticket's actual rate
    const refundTax = Math.round((sale.taxCents * refundSubtotal) / (sale.subtotalCents || 1));

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
          saleId: sale.id, employee: empName, method: sale.paymentMethod,
          amountCents: refundSubtotal, taxCents: refundTax, restocked: restock !== false,
          linesJson: JSON.stringify(applied), note: `Refund ticket #${sale.number}`,
        },
      });
    });
    return NextResponse.json({
      ok: true, kind: "REFUND",
      refundCents: refundSubtotal + refundTax,
      cashBack: sale.paymentMethod === "CASH" ? refundSubtotal + refundTax : 0,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

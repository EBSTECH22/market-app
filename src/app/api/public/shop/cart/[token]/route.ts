import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { finalizeSelfCartIfPaid } from "@/lib/selfcheckout";
import { tagCents } from "@/lib/cardprice";
import { getCardAdjustPercent } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const cart = await db.selfCart.findUnique({ where: { token: params.token } });
  if (!cart) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (cart.status !== "PAID") await finalizeSelfCartIfPaid(cart.id);
  const fresh = await db.selfCart.findUnique({ where: { token: params.token } });
  let number: number | null = null;
  if (fresh?.saleId) {
    const sale = await db.sale.findUnique({ where: { id: fresh.saleId }, select: { number: true } });
    number = sale?.number ?? null;
  }
  /* A card cart was charged at the tag prices; show them, so the lines add up
     to what was paid. (Carts from before tag pricing have no difference.) */
  const uplift = Math.max(0, fresh!.totalCents - fresh!.subtotalCents - fresh!.taxCents);
  const pct = uplift > 0 ? await getCardAdjustPercent() : 0;
  return NextResponse.json({
    cart: {
      status: fresh!.status, number,
      lines: JSON.parse(fresh!.linesJson).map((l: { name: string; quantity: number; priceCents: number }) => ({ name: l.name, quantity: l.quantity, priceCents: tagCents(l.priceCents, pct) })),
      subtotalCents: fresh!.subtotalCents + uplift, taxCents: fresh!.taxCents, totalCents: fresh!.totalCents, paidAt: fresh!.paidAt,
    },
  });
}

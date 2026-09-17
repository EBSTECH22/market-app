import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { pickupCode } from "@/lib/pickupcode";
import { barcodePng } from "@/lib/barcodepng";

export const dynamic = "force-dynamic";

/**
 * The collection code as a Code 128 barcode.
 *
 * The one a handheld scanner at the till reads. The QR next to it is for the
 * iPad's camera — a lot of counter scanners are laser or 1D-only and can't see
 * a QR at all, so the lines are the format that has to be here.
 *
 * Same access rule as the order page: whoever holds the 48-hex token. It draws
 * the code and nothing else — no name, no items, no total.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const token = String(params.token || "");
  if (!/^[a-f0-9]{16,64}$/i.test(token)) return new NextResponse("Not found", { status: 404 });

  const order = await db.order.findUnique({ where: { token }, select: { number: true, token: true } });
  if (!order) return new NextResponse("Not found", { status: 404 });

  /* Two pixels per module keeps a fourteen-character code under 420px, which
     is about as wide as a phone will show it without the browser scaling it
     down — and a barcode the browser has resampled is a barcode that doesn't
     read. `scale` is capped so a crafted URL can't ask for a 40MB image. */
  const scale = Math.min(6, Math.max(1, Number(req.nextUrl.searchParams.get("scale")) || 2));
  const height = Math.min(400, Math.max(40, Number(req.nextUrl.searchParams.get("h")) || 120));

  const png = barcodePng(pickupCode(order.number, order.token), { scale, height });

  return new NextResponse(png as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": `inline; filename="collect-${order.number}.png"`,
    },
  });
}

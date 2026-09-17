import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { pickupCode } from "@/lib/pickupcode";

export const dynamic = "force-dynamic";

/**
 * The collection code as a PNG.
 *
 * A route rather than a data: URI because this has to survive an email. Gmail
 * and Outlook both strip `data:` images and neither renders SVG, so the only
 * thing that reliably shows up in an inbox is a hosted PNG at a plain URL —
 * which is exactly what this is.
 *
 * Reachable by anyone holding the 48-hex token, same as the order page itself.
 * It renders the code and nothing else: no name, no items, no total. A QR
 * photographed off somebody's screen gives up the fact that an order exists and
 * nothing more, and collecting it still needs a cashier who can see the name on
 * their till.
 */
export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const token = String(params.token || "");
  if (!/^[a-f0-9]{16,64}$/i.test(token)) return new NextResponse("Not found", { status: 404 });

  const order = await db.order.findUnique({ where: { token }, select: { number: true, token: true } });
  if (!order) return new NextResponse("Not found", { status: 404 });

  /* Error correction at M, not L: this gets read off a phone screen held at an
     angle under market lighting, and sometimes off a print-out in a bag. */
  const png = await QRCode.toBuffer(pickupCode(order.number, order.token), {
    type: "png",
    width: 520,
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#ffffff" },
  });

  return new NextResponse(png as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      /* The code never changes for an order, so let inboxes and phones keep it.
         `private` because the URL carries the token. */
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": `inline; filename="collect-${order.number}.png"`,
    },
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { claim, complete, noteSeen, requeueStale } from "@/lib/printqueue";
import { printRequestXml } from "@/lib/epos";
import { getPrinterKey } from "@/lib/settings";

export const dynamic = "force-dynamic";
/* The reply is held open while waiting for a receipt to appear — see below.
   Nine seconds of that plus the database round trips has to fit inside the
   function's own lifetime, or the printer gets a gateway error instead of
   paper. */
export const maxDuration = 30;

/**
 * Where the printer comes to ask for work.
 *
 * THE ONE THING TO UNDERSTAND: this endpoint is called BY THE PRINTER, not by
 * anybody's browser. An Epson TM printer with Server Direct Print switched on
 * POSTs to a URL on a timer, prints whatever XML comes back, and POSTs again
 * to say how it went. That is the entire protocol, and it is the reason the
 * market can print from a shop wifi that nothing on the internet can reach.
 *
 * It cannot sign in, so the long random word in the path is the credential.
 *
 * It also cannot be told to hurry up. The shortest interval the printer will
 * poll at is still whole seconds, and a cashier watching a drawer not open is
 * a cashier who presses the button again. So when there is nothing to print,
 * the reply is HELD OPEN for a few seconds instead of coming back empty — if a
 * receipt is rung in that window it goes out on the connection that is already
 * standing there, and the paper starts moving as the cashier takes the money.
 * When nothing turns up, the empty answer the printer expects is sent and it
 * asks again.
 */
export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const expected = await getPrinterKey();
  /* No key set up yet means printing has never been switched on. Say nothing
     useful: this endpoint is public by necessity and a 404 is what a wrong
     address should look like. */
  if (!expected || params.key !== expected) {
    return new NextResponse("", { status: 404 });
  }

  const raw = await req.text().catch(() => "");
  const form = new URLSearchParams(raw);
  const kind = form.get("ConnectionType") || "";

  const empty = () =>
    new NextResponse("", {
      status: 200,
      headers: { "Content-Type": "text/xml; charset=utf-8", "Content-Length": "0", "Cache-Control": "no-store" },
    });

  /* ------------------------------------------------ how did that print? -- */
  if (kind === "SetResponse") {
    await complete(form.get("ResponseFile") || "").catch(() => null);
    await noteSeen().catch(() => {});
    return empty();
  }

  if (kind !== "GetRequest") return empty();

  /* ------------------------------------------------- anything to print? -- */
  await noteSeen().catch(() => {});
  await requeueStale().catch(() => {});

  const deadline = Date.now() + 9_000;
  for (;;) {
    const jobs = await claim(3);
    if (jobs.length) {
      return new NextResponse(printRequestXml(jobs), {
        status: 200,
        headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (Date.now() >= deadline) return empty();
    /* Quarter of a second. Short enough that a receipt rung now prints now;
       long enough that holding the line costs four queries a second rather
       than a thousand. */
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Some Epson firmware checks the address with a GET before it will save it.
 *
 * Answering plainly here is what turns "the printer won't accept the URL" into
 * a setting that saves first time.
 */
export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  const expected = await getPrinterKey();
  if (!expected || params.key !== expected) return new NextResponse("", { status: 404 });
  return new NextResponse("", {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8", "Content-Length": "0" },
  });
}

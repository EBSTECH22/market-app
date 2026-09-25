import { NextResponse, type NextRequest } from "next/server";
import { claim, complete, noteSeen, requeueStale } from "@/lib/printqueue";
import { printRequestXml } from "@/lib/epos";
import { getPrinterKey, getSdpVersion, notePrinterEvent, notePrinterResponse } from "@/lib/settings";

export const dynamic = "force-dynamic";
/* The reply is held open while waiting for a receipt to appear — see below.
   That wait plus the database round trips has to fit inside the function's own
   lifetime, or the printer gets a gateway error instead of paper. */
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
 * WHAT THE PRINTER IS, AS AN HTTP CLIENT: a small embedded one from a decade
 * ago, and it has to be answered the way such a thing expects. Every reply
 * below carries its own Content-Length and closes the connection. That is not
 * belt and braces — a reply sent back in chunks, which is what a modern host
 * does by default when the length isn't stated, is one this printer reads as
 * nothing at all. It then says nothing, asks again on its timer, and looks
 * from the office end like a printer that never got the job.
 *
 * It also cannot be told to hurry up. The shortest interval it will poll at is
 * whole seconds, and a cashier watching a drawer not open is a cashier who
 * presses the button again. So when there is nothing to print, the reply is
 * HELD OPEN for a few seconds instead of coming back empty — if a receipt is
 * rung in that window it goes out on the connection already standing there,
 * and the paper starts moving as the cashier takes the money.
 */

/** Everything the printer is sent, with the length it insists on being told. */
const xml = (body: string, status = 200) => {
  const bytes = Buffer.from(body, "utf8");
  return new NextResponse(bytes, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      Connection: "close",
    },
  });
};

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const expected = await getPrinterKey();
  /* No key set up yet means printing has never been switched on. Say nothing
     useful: this endpoint is public by necessity and a 404 is what a wrong
     address should look like. */
  if (!expected || params.key !== expected) return xml("", 404);

  const raw = await req.text().catch(() => "");
  const form = new URLSearchParams(raw);
  const kind = form.get("ConnectionType") || "";

  /* ------------------------------------------------ how did that print? -- */
  if (kind === "SetResponse") {
    const report = form.get("ResponseFile") || "";
    /* Kept verbatim. Whatever this says is the only first-hand account of why
       a job did or didn't print. */
    await notePrinterResponse(report).catch(() => {});
    const done = await complete(report).catch(() => null);
    await noteSeen().catch(() => {});
    await notePrinterEvent(
      done ? `reported a job ${done.ok ? "printed" : "refused"}` : "reported on a job we don't have"
    ).catch(() => {});
    return xml("");
  }

  if (kind !== "GetRequest") {
    /* Something else entirely. Worth recording rather than ignoring: it is the
       difference between "the printer is quiet" and "the printer is talking
       and we don't understand it". */
    await notePrinterEvent(kind ? `sent an unexpected "${kind}"` : "sent something we couldn't read").catch(() => {});
    return xml("");
  }

  /* ------------------------------------------------- anything to print? -- */
  await noteSeen().catch(() => {});
  await requeueStale().catch(() => {});

  const version = await getSdpVersion();
  const deadline = Date.now() + 9_000;
  for (;;) {
    const jobs = await claim(1);
    if (jobs.length) {
      await notePrinterEvent(`was handed ${jobs[0].label}`).catch(() => {});
      return xml(printRequestXml(jobs, 60_000, version));
    }
    if (Date.now() >= deadline) return xml("");
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
  if (!expected || params.key !== expected) return xml("", 404);
  return xml("");
}

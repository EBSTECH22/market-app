import { NextResponse, type NextRequest } from "next/server";
import { claim, complete, noteSeen, requeueStale, peek } from "@/lib/printqueue";
import { printRequestXml } from "@/lib/epos";
import { getPrintMode, getPrinterKey, getSdpVersion, getSdpStyle, getPrinterDeviceId, notePrinterEvent, notePrinterResponse, logPrinter } from "@/lib/settings";

export const dynamic = "force-dynamic";
/* Nothing here waits on anything now, so this is only a ceiling against a
   database that has gone slow — the printer would rather have an error than a
   connection that never answers. */
export const maxDuration = 15;

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

/**
 * Everything the printer is sent, shaped like Epson's own sample and nothing
 * more.
 *
 * The manual's sample response carries exactly two headers: the content type
 * and the length. Earlier versions of this added a few more out of habit —
 * Connection, cache directives — and a printer this old is not the place to
 * find out which extras it tolerates. So: the two it documents, plus
 * `no-transform`, which is the one instruction worth adding. It tells anything
 * between here and the shop not to re-encode the body on the way. A host that
 * helpfully gzips a reply is invisible to a modern browser and completely
 * opaque to a printer that will then parse nothing, run nothing, and report
 * nothing — which is exactly the silence we were chasing.
 */
const xml = (body: string, status = 200) => {
  const bytes = Buffer.from(body, "utf8");
  return new NextResponse(bytes, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
      /* The only header here beyond Epson's two. Its whole job is to tell
         anything in between not to re-encode the body — a gzipped reply is
         invisible to a browser and unreadable to this printer. */
      "Cache-Control": "no-transform",
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
    const verdict = done
      ? `reported a job ${done.ok ? "PRINTED" : "REFUSED"}`
      : report.includes("<response")
        ? "reported on a job we don't have"
        : "sent an empty report (nothing to say)";
    await notePrinterEvent(verdict).catch(() => {});
    await logPrinter(`${verdict} :: ${report.replace(/\s+/g, " ").slice(0, 200)}`).catch(() => {});
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

  /* NOT WHILE THE TILL IS CARRYING RECEIPTS.
     
     This printer's Server Direct Print fetches a job and never hands it to
     its own print engine — that was established the hard way. So if it is
     still switched on at the printer while the app is in direct mode, it sits
     there quietly taking receipts off the queue and swallowing them: the
     paper never comes out, the job is marked as handed over, and the till
     that could have printed it is told there is nothing to print. A receipt
     vanishing while its reprint prints is exactly what that looks like.
     
     So in direct mode the printer is answered politely and given nothing.
     Turning Server Direct Print off at the printer is still the right thing
     to do, but forgetting to can no longer cost anybody a receipt. */
  if ((await getPrintMode()) === "direct") {
    await notePrinterEvent("asked for work while the till is printing direct — sent none").catch(() => {});
    return xml("");
  }

  const version = await getSdpVersion();
  const devid = await getPrinterDeviceId();
  const style = await getSdpStyle();
  /* Answer at once, either way.
     There used to be a few seconds of holding the line here so a receipt rung
     during the wait could go out on a connection already standing open. It is
     a good trick and it is not in Epson's protocol, and while the printer was
     silent that was one unknown too many. The printer asks every three
     seconds; three seconds is a perfectly good wait for a receipt. */
  const jobs = await claim(1);
  if (jobs.length) {
    const doc = printRequestXml(jobs, 10_000, version, devid, style);
    await notePrinterEvent(`was handed ${jobs[0].label}`).catch(() => {});
    /* What kind of client is actually asking. The document is right and the
       printer reads our root tag and not our children, which a correct body
       does not allow — so the next thing worth knowing is whether it asked for
       a compressed reply, and what it says it is. */
    const asked =
      `ua=${req.headers.get("user-agent") || "?"} ` +
      `enc=${req.headers.get("accept-encoding") || "none"} ` +
      `accept=${req.headers.get("accept") || "none"} ` +
      `ctype=${req.headers.get("content-type") || "none"}`;
    await logPrinter(
      `handed over ${jobs[0].label} (${Buffer.byteLength(doc, "utf8")} bytes, v${version}, ${style}, devid ${devid}) :: ${asked}`
    ).catch(() => {});
    return xml(doc);
  }
  return xml("");
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

  /* ?peek=1 — the exact document the printer would be handed, as plain text,
     for looking at in a browser.
     
     This exists because there are only two things left it can be: what we
     send, or what happens to it on the way. Opening this on the tablet — the
     same wifi, the same route, the same host — answers that. Whole document
     on the screen means the bytes arrive intact and the fault is in what the
     printer makes of them. Anything garbled or short means it never had a
     chance. It claims nothing and changes nothing. */
  if (req.nextUrl.searchParams.get("peek")) {
    const next = await peek();
    const body = next
      ? printRequestXml([next], 10_000, await getSdpVersion(), await getPrinterDeviceId(), await getSdpStyle())
      : "Nothing waiting to print. Queue a test first, then reload this.";
    const bytes = Buffer.from(body, "utf8");
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(bytes.byteLength),
        /* The only header here beyond Epson's two. Its whole job is to tell
         anything in between not to re-encode the body — a gzipped reply is
         invisible to a browser and unreadable to this printer. */
      "Cache-Control": "no-transform",
      },
    });
  }

  return xml("");
}

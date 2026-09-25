import { NextResponse } from "next/server";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { db } from "@/lib/db";
import { claim, requeueStale } from "@/lib/printqueue";
import { getPrinterHost, getPrinterDeviceId, getPrintMode } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Work for whichever till is standing in front of the printer.
 *
 * In direct mode the tablet is the one that can reach the printer — this app
 * cannot, the printer being on the market's own wifi behind a router. So the
 * till asks for jobs every couple of seconds and sends them itself.
 *
 * The queue is unchanged by that. A receipt is still written down the moment a
 * sale is rung, still survives the tablet locking, and still comes out when a
 * till next opens. All that moves is who carries it the last few feet.
 */
export async function GET() {
  return runRoute("admin/print/next GET", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }

    const mode = await getPrintMode();
    const host = await getPrinterHost();
    if (mode !== "direct" || !host) {
      return NextResponse.json({ mode, host: "", jobs: [] });
    }

    /* A till that was carried off mid-job, or closed, leaves work claimed and
       unfinished. Put it back before handing anything else out. */
    await requeueStale().catch(() => {});

    /* ONE JOB IN FLIGHT ANYWHERE, not one per till.
       
       This printer serves one request at a time. A receipt with a logo takes
       it several seconds, and anything that arrives meanwhile is refused at
       the socket — which looks from the till like "the printer isn't there"
       and gets a perfectly good receipt marked as failed. Two tills open, or
       one till and the settings page, made that near-certain.
       
       So nothing is handed out while something is still out. The queue drains
       one receipt at a time, in order, and a busy printer simply means the
       next one waits a couple of seconds. */
    const inFlight = await db.printJob.count({ where: { status: "SENT" } });
    if (inFlight > 0) return NextResponse.json({ mode, host, jobs: [] });

    const jobs = await claim(1);

    return NextResponse.json({
      mode,
      host,
      devid: await getPrinterDeviceId(),
      jobs: jobs.map((j) => ({ id: j.id, label: j.label, body: j.body })),
    });
  });
}

import { NextResponse } from "next/server";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
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

    /* One at a time. Receipts have to come out in the order they were rung,
       and a till that walks away holding three of them is three receipts
       nobody gets until the sweep puts them back. */
    const jobs = await claim(1);

    return NextResponse.json({
      mode,
      host,
      devid: await getPrinterDeviceId(),
      jobs: jobs.map((j) => ({ id: j.id, label: j.label, body: j.body })),
    });
  });
}

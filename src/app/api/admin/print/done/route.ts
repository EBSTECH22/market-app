import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { complete } from "@/lib/printqueue";
import { notePrinterResponse, notePrinterEvent, logPrinter } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * POST { jobId, ok, raw }
 *
 * The till reporting back on a job it carried to the printer. Exactly the same
 * bookkeeping as the printer's own report in collect mode — the job is done,
 * or it goes back on the pile with a reason somebody can act on — so a receipt
 * is never quietly lost whichever way it travelled.
 */
export async function POST(req: NextRequest) {
  return runRoute("admin/print/done POST", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const jobId = String(body.jobId || "");
    if (!jobId) return NextResponse.json({ error: "Which job?" }, { status: 400 });

    const raw = String(body.raw || "");
    await notePrinterResponse(raw).catch(() => {});

    /* The printer's own words when we have them. When the till couldn't reach
       it at all there are none, so a failure is synthesised — complete() reads
       success="false" and puts the job back exactly as it would for a refusal
       the printer reported itself. */
    const report = raw.includes("<response")
      ? raw
      : `<response success="false" code="${body.ok ? "" : "EX_BADPORT"}"/>`;

    const done = await complete(body.ok && raw.includes("<response") ? raw : report).catch(() => null);

    const verdict = done?.ok ? "printed a job" : "couldn't print a job";
    await notePrinterEvent(`the till ${verdict}`).catch(() => {});
    await logPrinter(`till ${verdict} :: ${raw.replace(/\s+/g, " ").slice(0, 200) || "(no reply from the printer)"}`).catch(() => {});

    /* A job that failed because the till couldn't reach the printer is worth
       counting: several in a row means the printer is off, not that one
       receipt went wrong. */
    if (!done?.ok) {
      await db.printJob.updateMany({
        where: { id: jobId, status: "QUEUED", error: "" },
        data: { error: "The till couldn't reach the printer." },
      });
    }

    return NextResponse.json({ ok: true, printed: !!done?.ok });
  });
}

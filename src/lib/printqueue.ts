import { db } from "@/lib/db";
import { readPrintResponse } from "@/lib/epos";

/**
 * The pile of paper waiting to come out of the printer.
 *
 * The printer asks this app for work on a timer and prints whatever it is
 * given. That inversion is what makes it work at all — the printer sits on the
 * market's wifi behind a router, and nothing on the internet can start a
 * conversation with it — but it also means every job has three lives: queued,
 * handed over, confirmed. A job is only finished when the printer says it
 * printed, not when we handed it over.
 *
 * The rule that matters: a handed-over job that goes quiet comes BACK. A
 * printer that loses power mid-receipt, a tablet that drops the wifi, a job
 * that arrives while the paper is out — all of them end the same way, with the
 * receipt printing late rather than never.
 */

/** How long a handed-over job is given to report back before it's re-queued. */
const SENT_GRACE_MS = 90_000;

/** Give up after this many goes, so one poisoned job can't block the roll. */
const MAX_ATTEMPTS = 5;

export type NewJob = {
  kind?: string;
  label: string;
  body: string;
  saleId?: string;
  createdBy?: string;
};

export async function enqueue(job: NewJob): Promise<string> {
  const row = await db.printJob.create({
    data: {
      kind: job.kind || "RECEIPT",
      label: job.label.slice(0, 120),
      body: job.body,
      saleId: job.saleId || "",
      createdBy: (job.createdBy || "").slice(0, 60),
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Put back anything handed over that never reported in.
 *
 * Runs on every poll rather than on a timer: the printer asking for work is
 * the only moment this matters, and a sweep that depends on a cron job is a
 * sweep that stops the week the cron job breaks.
 */
export async function requeueStale(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SENT_GRACE_MS);
  const stale = await db.printJob.findMany({
    where: { status: "SENT", sentAt: { lt: cutoff } },
    select: { id: true, attempts: true },
  });
  for (const j of stale) {
    if (j.attempts >= MAX_ATTEMPTS) {
      await db.printJob.update({
        where: { id: j.id },
        data: { status: "FAILED", error: `Gave up after ${j.attempts} tries — the printer never confirmed it.` },
      });
    } else {
      await db.printJob.update({ where: { id: j.id }, data: { status: "QUEUED", sentAt: null } });
    }
  }
  return stale.length;
}

/**
 * Hand the oldest waiting jobs to the printer.
 *
 * Oldest first, always: receipts must come out in the order they were rung, or
 * two customers at one till end up holding each other's paper. The limit is
 * small on purpose — a printer that dies halfway through should have as little
 * in its hands as possible.
 */
export async function claim(limit = 3): Promise<{ id: string; body: string; label: string }[]> {
  const jobs = await db.printJob.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(10, limit)),
    select: { id: true, body: true, label: true, attempts: true },
  });
  if (jobs.length === 0) return [];

  const now = new Date();
  const taken: { id: string; body: string; label: string }[] = [];
  for (const j of jobs) {
    /* Conditional update, not a plain one. Two polls can overlap — the printer
       retrying while the first request is still open — and whichever loses
       here simply gets nothing rather than printing the same receipt twice. */
    const got = await db.printJob.updateMany({
      where: { id: j.id, status: "QUEUED" },
      data: { status: "SENT", sentAt: now, attempts: j.attempts + 1 },
    });
    if (got.count === 1) taken.push({ id: j.id, body: j.body, label: j.label });
  }
  return taken;
}

/**
 * The printer's report on a job it was given.
 *
 * Version 2.00 of the protocol puts the job's id in the report, so there is no
 * doubt which one it is about. Version 1.00 — which is what most firmware
 * actually speaks — puts nothing, so the report has to be matched to the
 * oldest job still outstanding. That is correct as long as jobs go out in
 * order and one at a time, which is exactly how they are handed over.
 */
export async function complete(responseXml: string): Promise<{ jobId: string; ok: boolean } | null> {
  const { jobId: reportedId, ok, code, reported } = readPrintResponse(responseXml);

  /* AN EMPTY REPORT IS NOT A VERDICT. The printer sends one of these after a
     cycle where it had nothing to do, and it names no job because there was
     no job. Applying it to whatever happened to be outstanding is how a
     receipt that printed perfectly well gets marked as refused — and, worse,
     gets printed again. A report that mentions no job changes no job. */
  if (!reported) return null;

  const job = reportedId
    ? await db.printJob.findUnique({ where: { id: reportedId }, select: { id: true, attempts: true } })
    : await db.printJob.findFirst({
        where: { status: "SENT" },
        orderBy: { sentAt: "asc" },
        select: { id: true, attempts: true },
      });
  if (!job) return null;
  const jobId = job.id;

  if (ok) {
    await db.printJob.update({ where: { id: jobId }, data: { status: "DONE", doneAt: new Date(), error: "" } });
    return { jobId, ok: true };
  }

  /* A failure with a reason usually means paper, cover or drawer — all things
     somebody fixes in ten seconds. Put it back and let it print when they do,
     rather than making them find a reprint button. */
  const dead = job.attempts >= MAX_ATTEMPTS;
  await db.printJob.update({
    where: { id: jobId },
    data: {
      status: dead ? "FAILED" : "QUEUED",
      sentAt: null,
      /* An empty report is not a refusal, it is the printer saying it had
         nothing to run — which means the device name it was given is not one
         it has. Saying that plainly saves an afternoon. */
      error: reported
        ? describe(code)
        : "The printer didn't recognise the device name. Check the Device ID on its own Device Admin \u2192 Printer page and set it below.",
    },
  });
  return { jobId, ok: false };
}

/**
 * Epson's error codes, in words a person at a till can act on.
 *
 * The codes are the printer's, and there are dozens; these are the ones that
 * actually happen in a shop. Anything else is passed through rather than
 * flattened into "an error occurred", because the code is what Epson's manual
 * is indexed by.
 */
export function describe(code: string): string {
  const c = String(code || "").trim();
  const known: Record<string, string> = {
    EPTR_COVER_OPEN: "The printer cover is open — close it and it'll print.",
    EPTR_REC_EMPTY: "The printer is out of paper.",
    EPTR_AUTOMATICAL: "The printer stopped with an error — switch it off and on.",
    EPTR_UNRECOVERABLE: "The printer needs switching off and on.",
    EPTR_CUTTER: "The cutter is jammed — clear it and switch off and on.",
    EPTR_MECHANICAL: "The printer is jammed.",
    SchemaError: "The receipt itself was malformed — this one's on us, not the printer.",
    DeviceNotFound: "The printer couldn't find itself — check its settings.",
    PrintSystemError: "The printer reported a system error.",
    EX_BADPORT: "The printer couldn't reach its own port.",
    EX_TIMEOUT: "The printer timed out mid-job.",
  };
  if (known[c]) return known[c];
  return c ? `The printer refused the job (${c}).` : "The printer refused the job.";
}

/** Last time the printer asked for work — the "is it on?" answer. */
export async function noteSeen(now = new Date()): Promise<void> {
  await db.setting.upsert({
    where: { key: "printerLastSeen" },
    create: { key: "printerLastSeen", value: now.toISOString() },
    update: { value: now.toISOString() },
  });
}

export async function lastSeen(): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: "printerLastSeen" } });
  if (!row) return null;
  const d = new Date(row.value);
  return Number.isNaN(d.getTime()) ? null : d;
}

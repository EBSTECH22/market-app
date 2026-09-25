import { db } from "@/lib/db";
import { readPrintResponse, troubleText, isFixableByHand } from "@/lib/epos";

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

/**
 * How long a handed-over job is given to report back before it's re-queued.
 *
 * Nothing else prints while a job is out (see api/admin/print/next), so this
 * doubles as how long a stuck job blocks the queue. Long enough for the
 * slowest receipt this printer produces — a full-width logo takes it several
 * seconds — and short enough that a till carried out of range doesn't hold
 * the next customer's receipt hostage.
 */
const SENT_GRACE_MS = 25_000;

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
export async function complete(
  responseXml: string,
  carriedBy = ""
): Promise<{ jobId: string; ok: boolean } | null> {
  const { jobId: reportedId, ok, code, reported } = readPrintResponse(responseXml);

  /* AN EMPTY REPORT IS NOT A VERDICT. The printer sends one of these after a
     cycle where it had nothing to do, and it names no job because there was
     no job. Applying it to whatever happened to be outstanding is how a
     receipt that printed perfectly well gets marked as refused — and, worse,
     gets printed again. A report that mentions no job changes no job. */
  if (!reported) return null;

  /* WHICH JOB THIS REPORT IS ABOUT, in order of how sure we are.

     1. The printer named it (protocol 2.00). Unambiguous.
     2. The till named it. The till carried this exact job to the printer and
        is telling us how it went, so it knows better than any guess we could
        make here.
     3. Nobody named it, so it belongs to the oldest job still out.

     Step 2 is not a nicety. Without it, a report always landed on the oldest
     outstanding job — so with two receipts in flight, the second one's
     "printed fine" marked the FIRST one done. The first never came out of the
     printer and the queue said it had. That is exactly the shape of one
     receipt vanishing while its reprint prints. */
  const job = reportedId
    ? await db.printJob.findUnique({ where: { id: reportedId }, select: { id: true, attempts: true } })
    : carriedBy
      ? await db.printJob.findUnique({ where: { id: carriedBy }, select: { id: true, attempts: true } })
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

  /* A failure with a reason usually means paper or the cover — things
     somebody fixes in ten seconds. Those go back on the pile WITHOUT using up
     one of the tries: before, five quick retries burned through in about
     fifteen seconds of an empty roll, and the receipt was marked failed and
     never printed once the paper was changed. Anything else counts. */
  const fixable = isFixableByHand(code);
  const dead = !fixable && job.attempts >= MAX_ATTEMPTS;
  await db.printJob.update({
    where: { id: jobId },
    data: {
      status: dead ? "FAILED" : "QUEUED",
      sentAt: null,
      error: describe(code),
      ...(fixable && job.attempts > 0 ? { attempts: { decrement: 1 } } : {}),
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
  return troubleText(code);
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

/** The next job, looked at without taking it. For the peek view only. */
export async function peek(): Promise<{ id: string; body: string; label: string } | null> {
  const j = await db.printJob.findFirst({
    where: { status: { in: ["QUEUED", "SENT"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, body: true, label: true },
  });
  return j || null;
}

/** A job handed straight back to the till that asked, to carry to the printer now. */
export type PrintNow = { job: { id: string; body: string }; host: string; devid: string } | null;

/**
 * Hand one freshly queued job to the till that is standing in front of the
 * printer, instead of making it wait for its next poll.
 *
 * Only when that till ASKED (printHere) — the kiosk register does, the admin
 * register tab and the offline sync don't. Before, every sale was marked
 * handed-over whoever rang it, so a sale from the admin screen or a synced
 * offline sale sat "in flight" with nobody carrying it, and blocked every
 * receipt behind it for 25 seconds.
 *
 * And only when nothing else is out: the printer takes one job at a time, and
 * jumping the queue would refuse this one at the socket anyway.
 */
export async function handOff(
  jobId: string,
  body: string,
  cfg: { printMode: string; printerHost: string; printerDeviceId: string }
): Promise<PrintNow> {
  if (cfg.printMode !== "direct" || !cfg.printerHost) return null;
  const busy = await db.printJob.count({ where: { status: "SENT" } });
  if (busy > 0) return null;
  const got = await db.printJob.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: { status: "SENT", sentAt: new Date(), attempts: 1 },
  });
  if (got.count !== 1) return null;
  return { job: { id: jobId, body }, host: cfg.printerHost, devid: cfg.printerDeviceId };
}

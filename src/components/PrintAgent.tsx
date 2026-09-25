"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { soapEnvelope, directPrintUrl } from "@/lib/epos";

/**
 * The till, carrying receipts the last few feet to the printer.
 *
 * This app runs on the internet and the printer sits on the market's own wifi
 * behind a router, so nothing out there can reach it. The tablet at the
 * counter can. So the tablet does it: it asks for queued work every couple of
 * seconds, posts each job straight to the printer, and reports back how it
 * went.
 *
 * Nothing about the queue changes. A receipt is written down the moment a sale
 * is rung and stays written down until it comes out of the printer. If the
 * tablet is locked, or on the wrong wifi, or across the road, the receipt
 * waits — and prints when a till is next open in front of the printer. What
 * this component must never do is lose one, which is why a job it can't print
 * is reported as failed rather than dropped.
 *
 * Mounted wherever a till is used. Two tills open at once is fine: each job is
 * claimed by exactly one of them.
 */

/**
 * Only one tab on a device carries receipts, even though several mount this.
 *
 * The register and the till hardware page are both tills, so both run an
 * agent, and on one tablet that means two of them posting to the printer
 * within a second of each other. This printer takes one connection at a time
 * and refuses the rest at the socket, which reads from here as "the printer
 * isn't there" — a perfectly good receipt marked failed while the next one
 * sails through.
 *
 * So the tabs take turns by leaving a note in the browser's own storage. A
 * tab writes its name and the time; any other tab that sees a fresh note
 * belonging to someone else simply skips its turn. If the holder is closed or
 * put to sleep the note goes stale within a few seconds and the next tab
 * picks it up, so nothing depends on a tab shutting down tidily.
 */
const LEASE_KEY = "marketPrintAgentLease";
const LEASE_STALE_MS = 9_000;

function holdsLease(me: string): boolean {
  try {
    const raw = window.localStorage.getItem(LEASE_KEY);
    const held = raw ? (JSON.parse(raw) as { id?: string; at?: number }) : null;
    const fresh = !!held?.at && Date.now() - held.at < LEASE_STALE_MS;
    if (fresh && held?.id !== me) return false;
    window.localStorage.setItem(LEASE_KEY, JSON.stringify({ id: me, at: Date.now() }));
    return true;
  } catch {
    /* Private browsing, storage full, an odd tablet — all end up here, and
       the right answer is to print. The server hands out one job at a time
       regardless, so the worst case is the old behaviour, not a lost
       receipt. */
    return true;
  }
}

export type PrintAgentStatus = {
  /** True while a job is actually being sent. */
  busy: boolean;
  /** Set when the printer, or the route to it, is refusing. */
  trouble: string;
  /** How many have gone out since this page was opened. */
  printed: number;
};

export function PrintAgent({
  active,
  everySeconds = 3,
  onStatus,
}: {
  active: boolean;
  everySeconds?: number;
  onStatus?: (s: PrintAgentStatus) => void;
}) {
  const [printed, setPrinted] = useState(0);
  const [trouble, setTrouble] = useState("");
  /* One job at a time, always. Two overlapping ticks would take two jobs and
     print them in whichever order the wifi felt like. */
  const runningRef = useRef(false);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  /* This tab's name for the turn-taking note. Generated once, per tab. */
  const meRef = useRef("");
  if (!meRef.current) meRef.current = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const report = useCallback(async (jobId: string, ok: boolean, raw: string) => {
    try {
      await fetch("/api/admin/print/done", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, ok, raw }),
      });
    } catch {
      /* The job stays claimed and the sweep puts it back in a minute. Losing
         the report is survivable; losing the receipt is not. */
    }
  }, []);

  const tick = useCallback(async () => {
    if (runningRef.current) return;
    if (!holdsLease(meRef.current)) return;
    runningRef.current = true;
    try {
      const r = await fetch("/api/admin/print/next");
      if (!r.ok) return;
      const d = (await r.json()) as {
        mode?: string;
        host?: string;
        devid?: string;
        jobs?: { id: string; label: string; body: string }[];
      };
      if (d.mode !== "direct" || !d.host || !d.jobs?.length) return;

      for (const job of d.jobs) {
        let raw = "";
        let ok = false;
        try {
          const res = await fetch(directPrintUrl(d.host, d.devid), {
            method: "POST",
            headers: { "Content-Type": "text/xml; charset=utf-8" },
            body: soapEnvelope(job.body),
          });
          raw = await res.text().catch(() => "");
          ok = /success\s*=\s*"(true|1)"/i.test(raw);
          setTrouble(
            ok
              ? ""
              : raw
                ? "The printer refused a receipt — check paper and the cover."
                : "The printer answered oddly."
          );
        } catch {
          /* Almost always one of two things: the printer is off, or this
             device hasn't been told to trust its certificate yet. Both look
             identical from here, so the wording covers both. */
          ok = false;
          setTrouble("Can't reach the printer from this device.");
        }
        await report(job.id, ok, raw);
        if (ok) setPrinted((n) => n + 1);
      }
    } catch {
      /* A failed poll is nothing — the next one is three seconds away. */
    } finally {
      runningRef.current = false;
    }
  }, [report]);

  useEffect(() => {
    if (!active) return;
    void tick();
    const t = window.setInterval(() => void tick(), Math.max(1, everySeconds) * 1000);

    /* Android suspends timers in a tab that isn't on screen, so a receipt rung
       just before the tablet was locked can sit waiting. Coming back to the
       page goes and gets it immediately rather than waiting for the timer to
       start ticking again. */
    const wake = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", wake);

    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", wake);
      /* Hand the turn straight over rather than making the next tab wait for
         the note to go stale. */
      try {
        const raw = window.localStorage.getItem(LEASE_KEY);
        const held = raw ? (JSON.parse(raw) as { id?: string }) : null;
        if (held?.id === meRef.current) window.localStorage.removeItem(LEASE_KEY);
      } catch {
        /* Nothing to do — the note expires by itself. */
      }
    };
  }, [active, everySeconds, tick]);

  useEffect(() => {
    statusRef.current?.({ busy: runningRef.current, trouble, printed });
  }, [trouble, printed]);

  return null;
}

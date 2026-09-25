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
    return () => window.clearInterval(t);
  }, [active, everySeconds, tick]);

  useEffect(() => {
    statusRef.current?.({ busy: runningRef.current, trouble, printed });
  }, [trouble, printed]);

  return null;
}

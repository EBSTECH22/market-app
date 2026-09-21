"use client";

import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { Button, Card, Checkbox, Field, Input, Badge, Note, EmptyState, useDialog, useToast } from "@/components/ui";
import { money, fmtDateTime, fmtPhone, plural } from "@/lib/format";
import { deadlineLabel, deadlinePassed, firstName, payUrl, smsBody, smsHref, smsNumber } from "@/lib/nonpayment";

/**
 * Non-Payment Notice — warn vendors who are behind on rent.
 *
 * Two channels, on purpose:
 *   EMAIL — sent by the app. This is the written notice the agreement
 *     requires (Section 13), so it's the one that's recorded and relied on.
 *   TEXT  — opened in Messages on the owner's phone, from her own number,
 *     already filled in. She presses send. The app never texts on its own; a
 *     phone won't let it, and a notice about someone's money is worth a glance
 *     before it goes.
 *
 * One at a time for texts, never a group: a group text shows every vendor's
 * number to every other vendor and turns an overdue notice into a public
 * callout.
 */

export type NoticeRow = {
  contractId: string;
  businessName: string;
  contactName: string;
  email: string;
  phone: string;
  boothLabel: string;
  signToken: string;
  outstandingCents: number;
  notice: { emailedAt: string | null; textedAt: string | null; deadline: string };
};

/** Today plus `n` days, as YYYY-MM-DD in Central time. */
function centralYmd(plusDays: number): string {
  const d = new Date(Date.now() + plusDays * 86_400_000);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export function NonPaymentNotice({
  rows, signer, onChanged,
}: {
  rows: NoticeRow[];
  signer: string;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const toast = useToast();

  const [deadline, setDeadline] = useState(() => centralYmd(2));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState<{ mobile: boolean; apple: boolean }>({ mobile: false, apple: false });

  useEffect(() => {
    const ua = navigator.userAgent;
    const iPadOS = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
    setPlatform({
      mobile: /Android|iPhone|iPad|iPod/i.test(ua) || iPadOS,
      apple: /iPhone|iPad|iPod|Macintosh/i.test(ua),
    });
  }, []);

  /* Coming back from Messages is the moment the list is stale — the text was
     just logged — so refresh when the page is shown again. */
  useEffect(() => {
    const onShow = () => { if (document.visibilityState === "visible") onChanged(); };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [onChanged]);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const me = firstName(signer, "Kalie");
  const pastDue = deadlinePassed(deadline);

  const textFor = (r: NoticeRow) =>
    smsBody({
      contactName: r.contactName,
      businessName: r.businessName,
      amountCents: r.outstandingCents,
      deadline,
      link: payUrl(origin, r.signToken),
      signer: me,
    });

  /* Emailed for THIS deadline. An email about last month's deadline doesn't
     count as notice of this one, so it doesn't turn the row green. */
  const emailedNow = (r: NoticeRow) => !!r.notice.emailedAt && r.notice.deadline === deadline;

  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.contractId));
  const pickedRows = useMemo(() => rows.filter((r) => picked.has(r.contractId)), [rows, picked]);

  const post = (channel: "email" | "text", ids: string[], keepalive = false) =>
    fetch("/api/admin/nonpayment-notice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, contractIds: ids, deadline }),
      /* keepalive so the "text opened" record survives the page going to the
         background the instant Messages opens. */
      keepalive,
    });

  const emailSelected = async () => {
    if (pickedRows.length === 0 || pastDue) return;
    const yes = await dialog.confirm({
      title: `Email a Non-Payment Notice to ${plural(pickedRows.length, "vendor")}?`,
      body: (
        <div className="stack g-3">
          <p>
            Each gets their own email with what they owe, their pay link, and a deadline of{" "}
            <b>{deadlineLabel(deadline)}</b>. It says their space goes to the waiting list if
            it isn&rsquo;t paid by then.
          </p>
          <p className="t-sm t-muted">
            This is the written notice your agreement requires. Texts are next — one tap each.
          </p>
        </div>
      ),
      confirmLabel: `Send ${plural(pickedRows.length, "email")}`,
      tone: "warn",
    });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await post("email", pickedRows.map((x) => x.contractId));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Nothing sent", String(d.error || "")); return; }
      const failed = (d.results || []).filter((x: { ok: boolean }) => !x.ok) as { businessName: string; reason?: string }[];
      if (failed.length === 0) {
        toast.success(`${plural(d.sent, "notice")} emailed`, "Now send the texts — tap Text on each row.");
      } else {
        toast.error(
          `${d.sent} sent, ${failed.length} not sent`,
          failed.map((f) => `${f.businessName || "Unknown"}: ${f.reason}`).join(" · ")
        );
      }
      setPicked(new Set());
      onChanged();
    } finally { setBusy(false); }
  };

  /** Log the text, then hand over to Messages — or copy it, on a computer. */
  const openText = async (r: NoticeRow, e?: MouseEvent) => {
    const num = smsNumber(r.phone);
    const body = textFor(r);
    if (!platform.mobile) {
      e?.preventDefault();
      let copied = false;
      try { await navigator.clipboard.writeText(body); copied = true; } catch { /* clipboard blocked */ }
      toast.info(
        copied ? "Text copied" : "Couldn't copy the text",
        copied
          ? `Paste it into a message to ${fmtPhone(r.phone)}. On your phone, this opens straight in Messages.`
          : "Use the app on your phone for texts — it opens Messages with everything filled in."
      );
      void post("text", [r.contractId]).then(() => onChanged());
      return;
    }
    // Fire and don't wait — the page backgrounds as soon as Messages opens.
    void post("text", [r.contractId], true);
    if (!e) window.location.href = smsHref(num, body, platform.apple);
  };

  /** The per-vendor button: email now, then straight into the text. */
  const noticeOne = async (r: NoticeRow) => {
    if (pastDue) return;
    const num = smsNumber(r.phone);
    const body = textFor(r);
    // Start the email first so it's on its way before the app backgrounds.
    const emailReq = post("email", [r.contractId], true);
    if (num && platform.mobile) {
      void post("text", [r.contractId], true);
      window.location.href = smsHref(num, body, platform.apple);
      void emailReq.then(() => onChanged());
      setOpen(null);
      return;
    }
    setBusy(true);
    try {
      const res = await emailReq;
      const d = await res.json().catch(() => ({}));
      const failed = (d.results || []).find((x: { ok: boolean }) => !x.ok) as { reason?: string } | undefined;
      if (!res.ok || failed) {
        toast.error("Email not sent", String(d.error || failed?.reason || ""));
      } else if (num) {
        let copied = false;
        try { await navigator.clipboard.writeText(body); copied = true; } catch { /* clipboard blocked */ }
        toast.success(
          "Notice emailed",
          copied ? `Text copied — paste it to ${fmtPhone(r.phone)}.` : "Now tap Text on your phone to send the text."
        );
      } else {
        toast.success("Notice emailed", "No phone number on file, so no text.");
      }
      setOpen(null);
      onChanged();
    } finally { setBusy(false); }
  };

  if (rows.length === 0) {
    return (
      <Card title="Non-Payment Notice">
        <EmptyState icon="checkCircle" title="Nobody to warn" body="Every signed vendor is paid up." />
      </Card>
    );
  }

  return (
    <Card
      title="Non-Payment Notice"
      subtitle="Warn signed vendors who haven't paid. Each gets an email — the notice your agreement requires — and a text from your phone."
    >
      <div className="stack g-4">
        <div className="row wrap g-3" style={{ alignItems: "flex-end" }}>
          <Field label="Pay by">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={deadline}
                min={centralYmd(0)}
                style={{ width: 170 }}
                onChange={(e) => setDeadline(e.target.value)}
              />
            )}
          </Field>
          <span className="t-sm" style={{ paddingBottom: 10 }}>
            {pastDue ? <span className="t-danger">That date has passed.</span> : <>Deadline: <b>{deadlineLabel(deadline)}</b></>}
          </span>
        </div>

        <div className="row between wrap g-2">
          <Checkbox
            checked={allPicked}
            onCheckedChange={(v) => setPicked(v ? new Set(rows.map((r) => r.contractId)) : new Set())}
            label={<b>Select all {rows.length}</b>}
          />
          <Button
            variant="danger"
            icon="mail"
            disabled={busy || pickedRows.length === 0 || pastDue}
            loading={busy}
            onClick={() => void emailSelected()}
          >
            {pickedRows.length > 0 ? `Email Non-Payment Notice to ${pickedRows.length}` : "Email Non-Payment Notice"}
          </Button>
        </div>

        <div className="stack g-2">
          {rows.map((r) => {
            const num = smsNumber(r.phone);
            const done = emailedNow(r);
            const isOpen = open === r.contractId;
            return (
              <div key={r.contractId} className="card" style={{ padding: 12 }}>
                <div className="row between wrap g-2" style={{ alignItems: "center" }}>
                  <div className="row g-3" style={{ alignItems: "center", minWidth: 0 }}>
                    <Checkbox
                      checked={picked.has(r.contractId)}
                      onCheckedChange={(v) => {
                        const next = new Set(picked);
                        if (v) next.add(r.contractId); else next.delete(r.contractId);
                        setPicked(next);
                      }}
                      label={
                        <span className="stack g-1">
                          <span style={{ fontWeight: 600 }}>{r.businessName}</span>
                          <span className="t-xs t-muted">
                            Booth {r.boothLabel} · owes <span className="t-danger num">{money(r.outstandingCents)}</span>
                            {r.phone ? ` · ${fmtPhone(r.phone)}` : " · no phone"}
                          </span>
                        </span>
                      }
                    />
                  </div>
                  <div className="row wrap g-2" style={{ alignItems: "center" }}>
                    {done ? <Badge tone="success" icon="mail">Emailed {fmtDateTime(r.notice.emailedAt || "")}</Badge> : null}
                    {r.notice.textedAt ? <Badge tone="info" icon="message">Text opened {fmtDateTime(r.notice.textedAt)}</Badge> : null}

                    {/* After a bulk email, the only thing left is the text. */}
                    {done && num ? (
                      <a
                        className="btn btn-secondary btn-sm"
                        href={smsHref(num, textFor(r), platform.apple)}
                        onClick={(e) => void openText(r, e)}
                      >
                        {r.notice.textedAt ? "Text again" : "Text"}
                      </a>
                    ) : null}
                    {!done ? (
                      <Button size="sm" variant="danger" disabled={busy || pastDue} onClick={() => setOpen(isOpen ? null : r.contractId)}>
                        Non-Payment Notice
                      </Button>
                    ) : null}
                  </div>
                </div>

                {isOpen ? (
                  <div className="stack g-3" style={{ marginTop: 12 }}>
                    <Note tone="warn" title="What they'll get">
                      <span className="stack g-2">
                        <span>
                          <b>Email</b> to {r.email || "— no email on file —"}: {money(r.outstandingCents)} due by {deadlineLabel(deadline)},
                          their pay link, and that the space goes to the waiting list after that.
                        </span>
                        {num ? (
                          <span><b>Text</b> to {fmtPhone(r.phone)}: &ldquo;{textFor(r)}&rdquo;</span>
                        ) : (
                          <span>No phone number on file, so email only.</span>
                        )}
                      </span>
                    </Note>
                    <div className="row wrap g-2 end">
                      <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
                      <Button size="sm" variant="danger" icon="mail" disabled={busy || !r.email} loading={busy} onClick={() => void noticeOne(r)}>
                        {num
                          ? platform.mobile ? "Send email & open text" : "Send email & copy text"
                          : "Send email"}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="t-xs t-muted">
          Texts open in Messages with everything filled in — you press send. Each is logged when it opens.
          The email is the notice your agreement counts; the text makes sure it&rsquo;s seen.
        </p>
      </div>
    </Card>
  );
}

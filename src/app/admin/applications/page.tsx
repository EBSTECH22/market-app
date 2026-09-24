"use client";

// Standalone applications workspace — same admin session, same pipeline actions
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePulse } from "@/lib/usePulse";
import {
  Icon, Button, LinkButton, Field, Input, MoneyInput, Textarea, Segmented,
  DataTable, Badge, Card, EmptyState, Note, Stat, SkeletonCard, SkeletonStats,
  PageHeader, useDialog, useToast, type Column, type BadgeTone,
} from "@/components/ui";
import { fmtDate, fmtPhone, money, plural, relTime } from "@/lib/format";
import { PHASE_LABEL, type Phase, type DeliveryState } from "@/lib/agreement";

/* ------------------------------------------------------------------ types -- */

/** Serialised `Delivery` from /api/admin/applications — dates arrive as strings. */
type Delivery = {
  state: DeliveryState;
  label: string;
  sentAt: string | null;
  viewedAt: string | null;
  daysSinceSent: number | null;
  daysSinceOpened: number | null;
  stale: boolean;
};

type Agreement = {
  id: string;
  boothLabel: string;
  monthlyRentCents: number;
  startDate: string;
  status: string;
  /** Stamped when they back out — the authoritative withdrawal date. */
  endDate: string | null;
  vendorSignedAt: string | null;
  marketSignedAt: string | null;
  viewedAt: string | null;
  /** Set when the hold on their space was released over an unpaid invoice. */
  spaceReleasedAt?: string | null;
  spaceKey?: string;
  delivery: Delivery | null;
};

/** One line, used wherever this applicant appears, so it reads the same everywhere. */
function HoldReleasedNote({ ag }: { ag: Agreement | null }) {
  if (!ag?.spaceReleasedAt) return null;
  return (
    <Note tone="error" title={`Hold released on ${ag.boothLabel} — ${fmtDate(ag.spaceReleasedAt)}`}>
      Their space went back on offer to the waiting list over the unpaid invoice. They can still pay and
      take it back while one is free; once the last one is let, their invoice closes.
    </Note>
  );
}

type Vendor = { id: string; code: string; businessName: string; active: boolean };

type App = {
  id: string; status: string; stage?: string; viewingAt?: string; adminNotes?: string;
  businessName: string; contactName: string; email: string; phone: string;
  category: string; products: string; boothRequest: string; phoneType?: string;
  notes: string; createdAt: string; decidedAt?: string | null; vendorId?: string;
  /** Added by the API — see the route's doc comment. */
  vendor: Vendor | null;
  agreement: Agreement | null;
  balanceCents: number;
  owesCents: number;
  phase: Phase;
  /** Already computed server-side. Display it; never re-derive it here. */
  nextStep: string;
  /** Which space they applied for, and their place in that queue (0 = not waiting). */
  spaceName?: string;
  waitPosition?: number;
};

type Counts = Record<Phase, number>;
const ZERO_COUNTS: Counts = { NEW: 0, WAITLIST: 0, IN_PROGRESS: 0, LIVE: 0, WITHDRAWN: 0, DECLINED: 0 };

/* Backed out sits between the people who are selling and the people we turned
   down, because that's what it is: someone we said yes to who said no. */
const PHASES: Phase[] = ["NEW", "WAITLIST", "IN_PROGRESS", "LIVE", "WITHDRAWN", "DECLINED"];

/** Short enough to sit in a segmented control on a phone. */
const PHASE_SHORT: Record<Phase, string> = {
  NEW: "New",
  WAITLIST: "Waiting list",
  IN_PROGRESS: "In progress",
  LIVE: "Selling",
  WITHDRAWN: "Backed out",
  DECLINED: "Declined",
};

/* Stage is the pipeline position of a still-pending application. */
const STAGE_BADGE: Record<string, { label: string; tone: BadgeTone }> = {
  NEW: { label: "New", tone: "info" },
  CALLED: { label: "Called", tone: "warn" },
  VIEWING: { label: "Viewing booked", tone: "warn" },
  CONTRACT: { label: "Agreement sent", tone: "success" },
  VENDOR: { label: "Vendor added", tone: "success" },
  DONE: { label: "Closed", tone: "neutral" },
};

const stageBadge = (stage?: string) =>
  STAGE_BADGE[stage || "NEW"] ?? { label: stage || "New", tone: "neutral" as BadgeTone };

/* ------------------------------------------------- agreement delivery -- */

/**
 * At-a-glance delivery status for an agreement. Always a word plus a dot or an
 * icon — never colour alone. `stale` gets its own second badge so "sent a while
 * ago and still nothing back" can't hide inside the calm blue "Sent" badge.
 *
 * The whole object comes from `deliveryFor()` in @/lib/agreement via the API, so
 * this screen, the agreements table and the onboarding list say the same thing.
 * (This page used to guess the state from the application's `stage`, which could
 * only ever produce DRAFT or SENT — OPENED, SIGNED and EXECUTED were invisible.)
 */
function DeliveryBadges({ delivery }: { delivery: Delivery | null }) {
  if (!delivery) return null;
  const { state, sentAt, daysSinceSent, stale } = delivery;
  return (
    <>
      {state === "DRAFT" ? <Badge tone="neutral" dot>Not sent</Badge> : null}
      {state === "SENT" ? (
        <Badge tone="info" icon="mail">{sentAt ? `Sent ${relTime(sentAt)}` : "Sent"}</Badge>
      ) : null}
      {state === "OPENED" ? <Badge tone="warn" icon="eye">Opened, not signed</Badge> : null}
      {state === "SIGNED" ? <Badge tone="info" icon="check">Awaiting your signature</Badge> : null}
      {state === "EXECUTED" ? <Badge tone="success" icon="checkCircle">Fully signed</Badge> : null}
      {stale && daysSinceSent !== null ? (
        <Badge tone="danger" icon="warning">Sitting {plural(daysSinceSent, "day")}</Badge>
      ) : null}
    </>
  );
}

/* ------------------------------------------------ spaces & waiting list -- */

type OfferRow = {
  id: string; key: string; name: string; blurb: string;
  priceCents: number; priceMaxCents: number; commissionPercent: number;
  available: number; waitlistOnly: boolean; active: boolean;
  waitlist: boolean; availability: string; terms: string; waitingCount: number;
};

/**
 * What the apply page offers, and how many are left.
 *
 * Lives here rather than in Settings because it is the same conversation as
 * the applications underneath it: a booth frees up, you change the number, and
 * the next person on the list gets a call. Editing a count or flicking
 * "waiting list only" changes the public page immediately.
 */
function SpacesCard() {
  const toast = useToast();
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/spaces");
    if (r.ok) setOffers((await r.json()).offers || []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const patch = async (id: string, body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/spaces", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't save that", String(d.error || "")); return; }
      toast.success(okMsg);
      await load();
    } finally { setBusy(false); }
  };

  const dollars = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, "");

  return (
    <Card
      title="Spaces &amp; waiting list"
      subtitle="What the apply page offers, what it costs, and how many are left."
      actions={
        <Button size="sm" variant="ghost" icon={open ? "chevronUp" : "chevronDown"} onClick={() => setOpen((v) => !v)}>
          {open ? "Done" : "Edit"}
        </Button>
      }
    >
      <div className="stack g-3">
        {offers.length === 0 ? (
          <span className="t-sm t-muted">Loading…</span>
        ) : null}

        {offers.map((o) => (
          <div key={o.id} className="stack g-2" style={{ paddingBottom: open ? "var(--sp-3)" : 0, borderBottom: open ? "1px solid var(--border)" : "none" }}>
            <div className="row between wrap g-2" style={{ alignItems: "center" }}>
              <span className="stack g-1" style={{ minWidth: 0 }}>
                <span className="row g-2 wrap" style={{ alignItems: "center" }}>
                  <b>{o.name}</b>
                  {!o.active ? <Badge tone="neutral">Hidden</Badge>
                    : o.waitlist ? <Badge tone="warn">Waiting list</Badge>
                    : <Badge tone="success" dot>{o.availability}</Badge>}
                  {o.waitingCount > 0 ? (
                    <Badge tone="info">{plural(o.waitingCount, "person")} waiting</Badge>
                  ) : null}
                </span>
                <span className="t-xs t-muted">{o.terms}</span>
              </span>

              {!open ? null : (
                <div className="row wrap g-2">
                  <Button
                    size="sm"
                    variant={o.waitlistOnly ? "primary" : "secondary"}
                    disabled={busy}
                    onClick={() => void patch(o.id, { waitlistOnly: !o.waitlistOnly }, o.waitlistOnly ? `${o.name} is open again` : `${o.name} is waiting list only`)}
                  >
                    {o.waitlistOnly ? "Waiting list only" : "Put on waiting list"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void patch(o.id, { active: !o.active }, o.active ? `${o.name} hidden` : `${o.name} shown`)}
                  >
                    {o.active ? "Hide" : "Show"}
                  </Button>
                </div>
              )}
            </div>

            {open ? (
              <div className="row wrap g-3" style={{ alignItems: "flex-end" }}>
                <Field label="Name">
                  {(p) => (
                    <Input {...p} key={`n${o.id}${o.name}`} defaultValue={o.name} style={{ width: 170 }}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== o.name) void patch(o.id, { name: v }, "Name saved"); }} />
                  )}
                </Field>
                <Field label="Price / month" hint="Leave the second box empty unless it's a range">
                  {(p) => (
                    <MoneyInput {...p} key={`p${o.id}${o.priceCents}`} defaultValue={dollars(o.priceCents)} style={{ width: 110 }}
                      onBlur={(e) => {
                        const cents = Math.round(Number(String(e.target.value).replace(/[^0-9.]/g, "")) * 100);
                        if (Number.isFinite(cents) && cents !== o.priceCents) void patch(o.id, { priceCents: cents }, "Price saved");
                      }} />
                  )}
                </Field>
                <Field label="Up to">
                  {(p) => (
                    <MoneyInput {...p} key={`pm${o.id}${o.priceMaxCents}`} defaultValue={o.priceMaxCents ? dollars(o.priceMaxCents) : ""} style={{ width: 110 }}
                      onBlur={(e) => {
                        const raw = String(e.target.value).replace(/[^0-9.]/g, "");
                        const cents = raw ? Math.round(Number(raw) * 100) : 0;
                        if (Number.isFinite(cents) && cents !== o.priceMaxCents) void patch(o.id, { priceMaxCents: cents }, "Price range saved");
                      }} />
                  )}
                </Field>
                <Field label="Commission %">
                  {(p) => (
                    <Input {...p} key={`c${o.id}${o.commissionPercent}`} type="number" min="0" max="90" step="1"
                      defaultValue={String(o.commissionPercent)} style={{ width: 100 }}
                      onBlur={(e) => {
                        const pct = Number(e.target.value);
                        if (Number.isFinite(pct) && pct !== o.commissionPercent) void patch(o.id, { commissionPercent: pct }, "Commission saved");
                      }} />
                  )}
                </Field>
                <Field label="How many left" hint="-1 for no limit">
                  {(p) => (
                    <Input {...p} key={`a${o.id}${o.available}`} type="number" min="-1" step="1"
                      defaultValue={String(o.available)} style={{ width: 110 }}
                      onBlur={(e) => {
                        const n = Math.round(Number(e.target.value));
                        if (Number.isFinite(n) && n !== o.available) void patch(o.id, { available: n }, "Availability saved");
                      }} />
                  )}
                </Field>
              </div>
            ) : null}
          </div>
        ))}

        {open ? (
          <span className="t-xs t-muted">
            Anything on the waiting list still takes applications — they queue in the order they arrive, and
            you&rsquo;ll see the queue position on each one below.
          </span>
        ) : null}
      </div>
    </Card>
  );
}

const statusTone = (s: string): BadgeTone =>
  s === "ACCEPTED" ? "success" : s === "DECLINED" ? "danger" : s === "WAITLIST" ? "warn" : "neutral";

const statusLabel = (s: string) => (s === "WAITLIST" ? "Waiting list" : s ? s.charAt(0) + s.slice(1).toLowerCase() : "—");

/* ------------------------------------------------------ contact actions -- */

/** Comfortable thumb target on a phone; the kit's default button is shorter. */
const TAP = { minHeight: 40 } as const;

/**
 * Reach someone without leaving the row. `tel:` and `sms:` both want bare
 * digits — a formatted number with brackets and dashes is what makes these
 * links silently fail on some Android dialers, so format for the eye only.
 */
function ContactActions({ email, phone }: { email: string; phone: string }) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits && !email) {
    return <span className="t-xs t-muted">No phone or email on the application.</span>;
  }
  return (
    <div className="row wrap g-2">
      {digits ? (
        <LinkButton href={`tel:${digits}`} variant="secondary" icon="phone" style={TAP}>
          Call {fmtPhone(phone)}
        </LinkButton>
      ) : null}
      {digits ? (
        <LinkButton href={`sms:${digits}`} variant="secondary" icon="message" style={TAP}>
          Text
        </LinkButton>
      ) : null}
      {email ? (
        <LinkButton href={`mailto:${email}`} variant="secondary" icon="mail" style={TAP}>
          Email
        </LinkButton>
      ) : null}
    </div>
  );
}

/** How long they've been sitting where they are, in words. */
function waitingText(a: App): string {
  const days = a.agreement?.delivery?.daysSinceSent ?? null;
  if (days === null) return `Applied ${relTime(a.createdAt)}.`;
  return days === 0
    ? "Their agreement went out today."
    : `Their agreement has been with them ${plural(days, "day")}.`;
}

/**
 * When they backed out, and why.
 *
 * The date comes from the agreement's `endDate`, which the backend stamps at
 * the moment of withdrawal — authoritative, and present whether or not anyone
 * typed a reason. Someone who pulled out before any agreement existed has no
 * agreement to read, so we fall back to `decidedAt`, which the withdraw action
 * stamps for exactly this case. The reason is pulled from the line the backend
 * appends to their application notes, e.g. `[9/16/2026] Backed out: went with
 * another market`; no line simply means no reason was given.
 */
function backedOut(a: App): { at: Date | null; reason: string } {
  const raw = a.agreement?.endDate || a.decidedAt;
  const at = raw ? new Date(raw) : null;
  let reason = "";
  const lines = String(a.adminNotes || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\[([^\]]+)\]\s*Backed out:\s*(.*)$/.exec(lines[i].trim());
    if (m) { reason = m[2].trim(); break; }
  }
  return { at: at && !Number.isNaN(at.getTime()) ? at : null, reason };
}

/** One labelled block inside the expanded detail area. */
function Detail({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="stack g-1">
      <span className="t-label">{label}</span>
      <span className="t-sm" style={{ whiteSpace: "pre-wrap" }}>{value}</span>
    </div>
  );
}

export default function ApplicationsPage() {
  const dialog = useDialog();
  const toast = useToast();

  const [apps, setApps] = useState<App[]>([]);
  const [counts, setCounts] = useState<Counts>(ZERO_COUNTS);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [form, setForm] = useState<{ id: string; booth: string; rent: string; start: string } | null>(null);
  const [phase, setPhase] = useState<Phase>("NEW");

  /* Land on the list that actually has someone in it, preferring the new
     applications. Only on the first successful load — the 4s pulse must never
     yank the operator off the list they're working. */
  const pickedDefault = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/applications");
      if (r.status === 401) { window.location.href = "/admin"; return; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "The applications list didn't come back. Try again.");
        return;
      }
      const c: Counts = { ...ZERO_COUNTS, ...(d.counts ?? {}) };
      setApps(d.applications ?? []);
      setCounts(c);
      setErr("");
      if (!pickedDefault.current) {
        pickedDefault.current = true;
        setPhase(c.NEW > 0 ? "NEW" : c.IN_PROGRESS > 0 ? "IN_PROGRESS" : "NEW");
      }
    } catch {
      setErr("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  usePulse(load);

  const act = async (id: string, payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/applications/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't update the application", d.error || "Please try again."); return null; }
      load();
      return d;
    } finally { setBusy(false); }
  };

  /* The old prompt() came prefilled with "Tuesday Sep 22, 10:00 AM" — a fake
     example that got emailed verbatim to the applicant whenever the operator
     just pressed OK. The example now lives in the placeholder, where it can't
     be submitted by accident. */
  const scheduleViewing = async (a: App) => {
    const when = await dialog.prompt({
      title: "Schedule a viewing",
      body: <>This goes straight to {a.contactName || a.businessName} in an email.</>,
      label: "Viewing date & time",
      hint: "Emailed exactly as typed — nothing is reformatted. e.g. Tuesday, September 22 at 10:00 AM.",
      placeholder: "Tuesday, September 22 at 10:00 AM",
      defaultValue: "",
      required: true,
      confirmLabel: "Send the invite",
      validate: (v) => (v.trim().length < 4 ? "Write out the day and the time." : null),
    });
    if (!when) return;
    await act(a.id, { action: "schedule_viewing", when: when.trim() });
  };

  /* Said out loud every time, because a count quietly going down is exactly
     the kind of thing you want to have been told about. */
  const claimLine = (d: unknown): string => {
    const c = (d as { claim?: { claimed?: boolean; offerName?: string; left?: number | null } } | null)?.claim;
    if (!c?.claimed || !c.offerName) return "";
    return typeof c.left === "number"
      ? ` One ${c.offerName.toLowerCase()} taken — ${c.left} left on the apply page.`
      : ` Counted against ${c.offerName}.`;
  };

  const addAsVendor = async (a: App) => {
    const ok = await dialog.confirm({
      title: `Add ${a.businessName} as a vendor?`,
      body: "The application files onto their new vendor profile. Their portal stays locked until the agreement is fully signed and first rent is paid.",
      confirmLabel: "Add as vendor",
      cancelLabel: "Not yet",
    });
    if (!ok) return;
    const d = await act(a.id, { action: "add_vendor" });
    if (d) {
      toast.success(
        `${a.businessName} added as a vendor`,
        `Vendor ${d.vendor.code}. They've moved to Agreement in progress — the portal stays locked until the agreement is signed and first rent is paid.${claimLine(d)}`,
      );
    }
  };

  const decline = async (a: App) => {
    const reason = await dialog.prompt({
      title: `Decline ${a.businessName}?`,
      body: "They're emailed the decision right away. Anything you write here is included in that email.",
      label: "Note for the decline email",
      hint: "Optional — leave it empty to send the standard wording.",
      placeholder: "We're full on bakers this season…",
      multiline: true,
      tone: "warn",
      confirmLabel: "Send the decline",
    });
    // null means the operator backed out; an empty string is a deliberate
    // "decline with the standard wording".
    if (reason === null) return;
    await act(a.id, { action: "decline", reason });
  };

  /* Them withdrawing, not us declining. No email — they already know, and
     "we've received your decision" from us would land as a rejection. */
  const withdraw = async (a: App) => {
    const reason = await dialog.prompt({
      title: `${a.businessName} backed out?`,
      body: "For when they tell you the market isn't what they need. Nobody is emailed. They move to the Backed out list, with whatever you write here, so you can answer “whatever happened to them?” later.",
      label: "Why did they back out?",
      hint: "Optional, but worth a line — patterns show up over a season.",
      placeholder: "Decided the booth was too small for her setup",
      multiline: true,
      tone: "warn",
      confirmLabel: "Mark as backed out",
    });
    if (reason === null) return;
    const d = await act(a.id, { action: "withdraw", reason });
    if (d) toast.success(`${a.businessName} marked as backed out`, "They're in the Backed out list now.");
  };

  /* Undo. Misclicks happen, and so do people changing their minds back. */
  const reopen = async (a: App) => {
    const yes = await dialog.confirm({
      title: `Put ${a.businessName} back in the pipeline?`,
      body: "They return to New applications. The note about backing out stays on their record.",
      confirmLabel: "Reopen",
    });
    if (!yes) return;
    const d = await act(a.id, { action: "reopen" });
    if (d) toast.success(`${a.businessName} reopened`, "Back in New applications.");
  };

  const submitContract = async (a: App) => {
    if (!form || form.id !== a.id) return;
    const d = await act(a.id, {
      action: "create_contract",
      boothLabel: form.booth,
      rentDollars: Number(form.rent),
      startDate: form.start,
    });
    if (!d) return;
    setForm(null);
    if (d.emailErrors && d.emailErrors.length > 0) {
      // The signing link is the only copy — it used to be dumped into an
      // alert() the operator couldn't select, let alone copy.
      await dialog.alert({
        title: "Agreement created — but the email didn't send",
        tone: "warn",
        body: (
          <>
            Send this signing link to <b>{a.email}</b> yourself.
            {d.emailErrors.length ? <> The mailer said: {d.emailErrors.join(" · ")}</> : null}
          </>
        ),
        copyable: d.signUrl,
        confirmLabel: "Done",
      });
    } else {
      toast.success(
        "Agreement created",
        `Signing link emailed to ${a.email} — vendor ${d.vendor.code}. They're now under Agreement in progress.${claimLine(d)}`,
      );
    }
  };

  /* Nudge one applicant who hasn't signed. The email spells out that the booth
     isn't held for them yet, so the confirm has to say that too — otherwise the
     operator doesn't know what they're about to send. */
  const sendReminder = async (a: App) => {
    const ag = a.agreement;
    if (!ag) return;
    /* On a DRAFT the API mints a signing token on the fly, so this is really
       their FIRST email, not a reminder. Say so rather than telling the owner
       they're nudging someone who has never heard from them. */
    const firstSend = ag.delivery?.state === "DRAFT";
    const yes = await dialog.confirm({
      title: firstSend
        ? `Send ${a.businessName} their agreement?`
        : `Remind ${a.businessName} to sign?`,
      body: firstSend
        ? "This emails them their signing link for the first time, along with a note that the booth isn't reserved until the agreement is signed and the first month's rent is paid."
        : "They get their signing link again, in an email that says plainly the booth isn't reserved until the agreement is signed and the first month's rent is paid.",
      confirmLabel: firstSend ? "Send it" : "Send the reminder",
      cancelLabel: "Not now",
    });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/contracts/${ag.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send_reminder" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(firstSend ? "Couldn't send it" : "Couldn't send the reminder", d.error || "Please try again."); return; }
      toast.success(firstSend ? "Agreement sent" : "Reminder sent", `Emailed to ${d.sentTo || a.email}.`);
      load();
    } finally { setBusy(false); }
  };

  /* --------------------------------------------------------------- lists -- */

  const rows = useMemo(() => apps.filter((a) => a.phase === phase), [apps, phase]);

  const inProgress = useMemo(() => apps.filter((a) => a.phase === "IN_PROGRESS"), [apps]);

  /* Three numbers that name whose move it is. Rows with no agreement (or an
     unsent draft) are waiting on the operator to send one — their nextStep says
     so on the row itself, so they don't need a tile of their own. */
  const progressStats = useMemo(() => {
    let awaitingSignature = 0;
    let stale = 0;
    let awaitingCountersign = 0;
    let awaitingRent = 0;
    let owedCents = 0;
    for (const a of inProgress) {
      const s = a.agreement?.delivery?.state;
      if (s === "SENT" || s === "OPENED") {
        awaitingSignature += 1;
        if (a.agreement?.delivery?.stale) stale += 1;
      }
      if (s === "SIGNED") awaitingCountersign += 1;
      if (s === "EXECUTED" && a.owesCents > 0) { awaitingRent += 1; owedCents += a.owesCents; }
    }
    return { awaitingSignature, stale, awaitingCountersign, awaitingRent, owedCents };
  }, [inProgress]);

  const liveColumns: Column<App>[] = [
    {
      key: "business",
      header: "Business",
      cell: (a) => a.vendor?.businessName || a.businessName,
      sortBy: (a) => a.vendor?.businessName || a.businessName,
      primary: true,
    },
    {
      key: "code",
      header: "Vendor",
      cell: (a) => (a.vendor ? <span className="mono">{a.vendor.code}</span> : "—"),
      sortBy: (a) => a.vendor?.code ?? "",
    },
    {
      key: "booth",
      header: "Booth",
      cell: (a) => a.agreement?.boothLabel || "—",
      sortBy: (a) => a.agreement?.boothLabel ?? "",
    },
    {
      key: "openVendor",
      header: <span className="sr-only">Vendor record</span>,
      align: "right",
      mobileLabel: "Vendor record",
      cell: () => (
        <LinkButton href="/admin#vendors" variant="ghost" size="sm" iconRight="chevronRight">
          Open in vendors
        </LinkButton>
      ),
    },
  ];

  /* Deliberately thin — this is a record, not a worklist. If they come back,
     the work happens on the agreement in Admin → Agreements, not here. */
  const withdrawnColumns: Column<App>[] = [
    {
      key: "business",
      header: "Business",
      cell: (a) => a.vendor?.businessName || a.businessName,
      sortBy: (a) => a.vendor?.businessName || a.businessName,
      primary: true,
    },
    {
      key: "booth",
      header: "Booth",
      cell: (a) =>
        a.agreement?.boothLabel
          ? `Booth ${a.agreement.boothLabel}`
          : <span className="t-muted">No booth was allocated</span>,
      sortBy: (a) => a.agreement?.boothLabel ?? "",
    },
    {
      key: "when",
      header: "Backed out",
      sortBy: (a) => backedOut(a).at?.getTime() ?? 0,
      cell: (a) => {
        const { at } = backedOut(a);
        return at ? fmtDate(at) : <span className="t-muted">Date not recorded</span>;
      },
    },
    {
      key: "why",
      header: "Why",
      mobileLabel: "Why they backed out",
      cell: (a) => {
        const { reason } = backedOut(a);
        if (reason) return <span className="clamp-2">{reason}</span>;
        if (a.adminNotes) {
          return <span className="t-sm clamp-2" style={{ whiteSpace: "pre-wrap" }}>{a.adminNotes}</span>;
        }
        return <span className="t-muted">No reason recorded</span>;
      },
    },
    {
      key: "reopen",
      header: "",
      align: "right",
      cell: (a) => (
        <Button size="sm" variant="ghost" icon="refresh" disabled={busy} onClick={() => reopen(a)}>
          Reopen
        </Button>
      ),
    },
  ];

  const declinedColumns: Column<App>[] = [
    {
      key: "business",
      header: "Business",
      cell: (a) => a.businessName,
      sortBy: (a) => a.businessName,
      primary: true,
    },
    {
      key: "email",
      header: "Email",
      cell: (a) => <span className="truncate" style={{ display: "block" }}>{a.email}</span>,
      sortBy: (a) => a.email,
    },
    {
      key: "applied",
      header: "Applied",
      cell: (a) => fmtDate(a.createdAt),
      sortBy: (a) => a.createdAt,
    },
    {
      key: "status",
      header: "Decided",
      align: "right",
      sortBy: (a) => a.decidedAt ?? "",
      cell: (a) => (
        <span className="row g-2 end wrap">
          <Badge tone={statusTone(a.status)} dot>{statusLabel(a.status)}</Badge>
          {a.decidedAt ? <span className="t-xs t-muted">{fmtDate(a.decidedAt)}</span> : null}
        </span>
      ),
    },
  ];

  /* The queue, in the order it was promised. Contact details on the row,
     because the only thing you do from this screen is ring the next person. */
  const waitlistColumns: Column<App>[] = [
    {
      key: "pos",
      header: "#",
      cell: (a) => <b className="num">{a.waitPosition || "—"}</b>,
      sortBy: (a) => a.waitPosition || 0,
    },
    {
      key: "business",
      header: "Business",
      primary: true,
      sortBy: (a) => a.businessName,
      cell: (a) => (
        <span className="stack g-1">
          <b>{a.businessName}</b>
          <span className="t-xs t-muted">{a.contactName}</span>
        </span>
      ),
    },
    {
      key: "applied",
      header: "Waiting since",
      sortBy: (a) => a.createdAt,
      cell: (a) => (
        <span className="stack g-1">
          <span>{fmtDate(a.createdAt)}</span>
          <span className="t-xs t-muted">{relTime(a.createdAt)}</span>
        </span>
      ),
    },
    {
      key: "products",
      header: "Sells",
      hideBelow: 900,
      cell: (a) => <span className="truncate" style={{ display: "block", maxWidth: 260 }}>{a.products}</span>,
    },
    {
      key: "reach",
      header: "",
      align: "right",
      cell: (a) => (
        <span className="row g-2 end wrap">
          {a.phone ? (
            <a className="btn btn-secondary btn-sm" href={`tel:${a.phone.replace(/\D/g, "")}`}>
              <Icon name="phone" size={14} /> Call
            </a>
          ) : null}
          <a className="btn btn-ghost btn-sm" href={`mailto:${a.email}`}>
            <Icon name="mail" size={14} /> Email
          </a>
        </span>
      ),
    },
  ];

  /* ----------------------------------------------------------- new cards -- */

  const renderNew = (a: App) => {
    const sb = stageBadge(a.stage);
    return (
      <Card
        key={a.id}
        title={a.businessName}
        subtitle={[a.contactName, a.category].filter(Boolean).join(" · ") || undefined}
        actions={
          <>
            {a.stage === "VIEWING" && a.viewingAt ? (
              <span className="t-xs t-muted row g-1">
                <Icon name="calendar" size={12} />{a.viewingAt}
              </span>
            ) : null}
            {/* Agreement delivery first — it's the thing that stalls. */}
            {a.agreement?.spaceReleasedAt ? <Badge tone="danger" icon="alert">Hold released</Badge> : null}
            <DeliveryBadges delivery={a.agreement?.delivery ?? null} />
            {a.stage === "CONTRACT" ? null : <Badge tone={sb.tone} dot>{sb.label}</Badge>}
          </>
        }
      >
        <div className="stack g-4">
          <HoldReleasedNote ag={a.agreement} />

          <div className="stack g-1">
            <a className="row g-2 t-sm" href={`mailto:${a.email}`} style={{ minHeight: 32 }}>
              <Icon name="mail" size={14} />
              <span className="truncate">{a.email}</span>
            </a>
            {a.phone ? (
              <a className="row g-2 t-sm" href={`tel:${a.phone}`} style={{ minHeight: 32 }}>
                <Icon name="phone" size={14} />{fmtPhone(a.phone)}
              </a>
            ) : null}
            <span className="row g-2 t-sm t-muted" style={{ minHeight: 32 }}>
              <Icon name="clock" size={14} />Applied {fmtDate(a.createdAt)}
            </span>
            {/* What they asked for, and where they sit in that queue — the two
                things you need before picking up the phone. */}
            {a.spaceName || a.waitPosition ? (
              <span className="row g-2 wrap" style={{ minHeight: 32, alignItems: "center" }}>
                {a.spaceName ? <Badge tone="neutral">{a.spaceName}</Badge> : null}
                {a.waitPosition ? (
                  <Badge tone="warn" icon="clock">
                    #{a.waitPosition} on the waiting list
                  </Badge>
                ) : null}
              </span>
            ) : null}
          </div>

          <div className="row wrap g-2">
            <Button
              icon={open === a.id ? "chevronUp" : "chevronDown"}
              aria-expanded={open === a.id}
              onClick={() => setOpen(open === a.id ? null : a.id)}
            >
              {open === a.id ? "Hide details" : "Details"}
            </Button>

            {(!a.stage || a.stage === "NEW") && (
              <Button variant="primary" icon="phone" disabled={busy} onClick={() => act(a.id, { action: "mark_called" })}>
                Mark as called
              </Button>
            )}

            {a.stage === "CALLED" && (
              <Button icon="calendar" disabled={busy} onClick={() => scheduleViewing(a)}>
                Schedule viewing
              </Button>
            )}

            {/* No stage gate. This used to require CALLED or VIEWING, which hid
                the button on a brand-new application — so the one thing you
                most often want to do from an application was invisible until
                you'd clicked through two other steps first. These cards are all
                pre-agreement by definition (the NEW phase), so there is nothing
                here to protect against. */}
            <Button
              variant="primary"
              icon="contract"
              disabled={busy}
              onClick={() => setForm(form?.id === a.id ? null : { id: a.id, booth: a.boothRequest || "", rent: "", start: new Date().toISOString().slice(0, 10) })}
            >
              Create agreement
            </Button>

            <Button icon="user" disabled={busy} onClick={() => addAsVendor(a)}>
              Add as vendor
            </Button>

            {/* Two different endings, kept visibly apart. "Decline" is our
                decision and emails them; "They backed out" is theirs and
                emails nobody. Filing one under the other loses the reason
                you'd want months later. */}
            <Button icon="arrowLeft" disabled={busy} onClick={() => withdraw(a)}>
              They backed out
            </Button>

            <Button variant="dangerSoft" icon="close" disabled={busy} onClick={() => decline(a)}>
              Decline
            </Button>
          </div>

          {open === a.id && (
            <div
              className="stack g-4"
              style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--sp-4)" }}
            >
              <Detail label="Products" value={a.products} />
              <Detail label="Booth requested" value={a.boothRequest} />
              <Detail label="Phone" value={a.phoneType} />
              <Detail label="Their notes" value={a.notes} />

              <div>
                <LinkButton
                  href={`/admin/applications/${a.id}/print`}
                  variant="secondary"
                  size="sm"
                  icon="print"
                  external
                >
                  Print full application
                </LinkButton>
              </div>

              <Field label="Call & review notes" hint="Internal only — the applicant never sees this.">
                {(p) => (
                  <Textarea
                    {...p}
                    rows={3}
                    value={notes[a.id] ?? a.adminNotes ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                  />
                )}
              </Field>
              <div>
                <Button
                  icon="check"
                  disabled={busy}
                  onClick={() => act(a.id, { action: "save_notes", notes: notes[a.id] ?? a.adminNotes ?? "" })}
                >
                  Save notes
                </Button>
              </div>
            </div>
          )}

          {form?.id === a.id && (
            <div className="card card-pad-sm stack g-4" style={{ background: "var(--bg-inset)" }}>
              <div>
                <h3 className="t-card">Create agreement</h3>
                <p className="t-xs t-muted">First month is full rent; month two prorates.</p>
              </div>

              <Field label="Booth label" required>
                {(p) => (
                  <Input
                    {...p}
                    value={form.booth}
                    placeholder="A3"
                    onChange={(e) => setForm((f) => f && ({ ...f, booth: e.target.value }))}
                  />
                )}
              </Field>

              <Field label="Monthly rent" hint="Dollars. Billed on the first of each month." required>
                {(p) => (
                  <MoneyInput
                    {...p}
                    value={form.rent}
                    placeholder="96"
                    onChange={(e) => setForm((f) => f && ({ ...f, rent: e.target.value }))}
                  />
                )}
              </Field>

              <Field label="Start date" required>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    value={form.start}
                    onChange={(e) => setForm((f) => f && ({ ...f, start: e.target.value }))}
                  />
                )}
              </Field>

              <div className="row wrap g-2">
                <Button
                  variant="primary"
                  icon="mail"
                  loading={busy}
                  disabled={!form.booth.trim() || !(Number(form.rent) > 0) || !form.start}
                  onClick={() => submitContract(a)}
                >
                  Create &amp; send for signature
                </Button>
                <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      </Card>
    );
  };

  /* --------------------------------------------------- in-progress cards -- */

  const renderInProgress = (a: App) => {
    const ag = a.agreement;
    const del = ag?.delivery ?? null;
    const canRemind =
      !!ag && (del?.state === "DRAFT" || del?.state === "SENT" || del?.state === "OPENED");
    return (
      <Card
        key={a.id}
        title={a.vendor?.businessName || a.businessName}
        subtitle={
          ag
            ? `Booth ${ag.boothLabel} · ${money(ag.monthlyRentCents)} a month`
            : "No agreement raised yet"
        }
        actions={
          <>
            {ag?.spaceReleasedAt ? <Badge tone="danger" icon="alert">Hold released</Badge> : null}
            <DeliveryBadges delivery={del} />
            {a.vendor ? <Badge tone="neutral" dot>{a.vendor.code}</Badge> : null}
          </>
        }
      >
        <div className="stack g-4">
          <HoldReleasedNote ag={ag} />

          <Note tone={del?.stale ? "warn" : "info"} title={a.nextStep}>
            {waitingText(a)}
            {a.owesCents > 0 ? ` They owe ${money(a.owesCents)}.` : ""}
          </Note>

          <ContactActions email={a.email} phone={a.phone} />

          <div className="row wrap g-2">
            {canRemind && ag ? (
              <Button variant="primary" icon="mail" disabled={busy} onClick={() => sendReminder(a)}>
                {del?.state === "DRAFT" ? "Send the agreement" : "Send reminder"}
              </Button>
            ) : null}
            <Button
              icon={open === a.id ? "chevronUp" : "chevronDown"}
              aria-expanded={open === a.id}
              onClick={() => setOpen(open === a.id ? null : a.id)}
            >
              {open === a.id ? "Hide details" : "Details"}
            </Button>
          </div>

          {open === a.id && (
            <div
              className="stack g-4"
              style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--sp-4)" }}
            >
              <Detail label="Contact" value={a.contactName} />
              <Detail label="Products" value={a.products} />
              <Detail label="Booth requested" value={a.boothRequest} />
              <Detail label="Their notes" value={a.notes} />
              <Detail label="Applied" value={fmtDate(a.createdAt)} />
              {ag ? <Detail label="Agreement starts" value={fmtDate(ag.startDate)} /> : null}
              <div className="row wrap g-2">
                <LinkButton
                  href={`/admin/applications/${a.id}/print`}
                  variant="secondary"
                  size="sm"
                  icon="print"
                  external
                >
                  Print full application
                </LinkButton>
                {ag ? (
                  <LinkButton
                    href={`/admin/contracts/${ag.id}/print`}
                    variant="secondary"
                    size="sm"
                    icon="contract"
                    external
                  >
                    Print agreement
                  </LinkButton>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </Card>
    );
  };

  /* ----------------------------------------------------- backed-out list -- */

  /** Kept so you can answer "whatever happened to them?" months later. */
  const renderWithdrawn = () => (
    <Card title={PHASE_LABEL.WITHDRAWN} subtitle={plural(rows.length, "person")} flush>
      <DataTable
        rows={rows}
        columns={withdrawnColumns}
        rowKey={(a) => a.id}
        mobileCards
        defaultSort={{ key: "when", dir: "desc" }}
        caption="Applicants and vendors who pulled out before they started selling"
        empty={
          <EmptyState
            icon="checkCircle"
            title="Nobody has backed out"
            body="Everyone still with you. Anyone you mark as backed out is kept here, with the reason, so the record survives."
          />
        }
      />
    </Card>
  );

  /* ---------------------------------------------------------------- view -- */

  const phaseOptions = PHASES.map((p) => ({
    value: p,
    label: `${PHASE_SHORT[p]} (${counts[p]})`,
  }));

  return (
    <main className="content content-narrow">
      <div className="mb-3">
        <LinkButton href="/admin" variant="ghost" size="sm" icon="arrowLeft">Admin</LinkButton>
      </div>

      <PageHeader
        title="Vendor applications"
        subtitle="Review and call (save your notes) → book a viewing or skip it → create the agreement → chase the signature. Portal access opens itself only once the agreement is fully signed and first rent is paid."
      />

      {err ? (
        <div className="mb-4">
          <Note
            tone="error"
            title="Couldn't load the applications"
            action={<Button size="sm" icon="refresh" onClick={() => load()}>Try again</Button>}
          >
            {err}
          </Note>
        </div>
      ) : null}

      {loading ? (
        <div className="stack g-4">
          <SkeletonStats count={3} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
        </div>
      ) : (
        <div className="stack g-4">
          <SpacesCard />

          <Segmented
            value={phase}
            onChange={setPhase}
            options={phaseOptions}
            label="Which applicants to show"
          />

          {/* ------------------------------------------------ new ------- */}
          {phase === "NEW" ? (
            rows.length === 0 ? (
              <Card>
                <EmptyState
                  icon="inbox"
                  title="No new applications"
                  body="Everything that's come in has been picked up. New applications land here the moment they're submitted."
                />
              </Card>
            ) : (
              <div className="stack g-4">{rows.map(renderNew)}</div>
            )
          ) : null}

          {/* ------------------------------------------ waiting list ---- */}
          {phase === "WAITLIST" ? (
            rows.length === 0 ? (
              <Card>
                <EmptyState
                  icon="clock"
                  title="Nobody is waiting"
                  body="When a space is full, applications for it come here in the order they arrive instead of being turned away."
                />
              </Card>
            ) : (
              <div className="stack g-4">
                {/* Grouped by what they're waiting for, oldest first inside
                    each group — that order IS the promise made to them, so it
                    is the order the screen shows and never a sort you picked. */}
                {[...new Set(rows.map((a) => a.spaceName || "Space not recorded"))].map((space) => {
                  const queue = rows
                    .filter((a) => (a.spaceName || "Space not recorded") === space)
                    .sort((x, y) => (x.waitPosition || 0) - (y.waitPosition || 0));
                  return (
                    <Card
                      key={space}
                      title={space}
                      subtitle={`${plural(queue.length, "person")} waiting — first in line at the top`}
                      flush
                    >
                      <DataTable
                        rows={queue}
                        columns={waitlistColumns}
                        rowKey={(a) => a.id}
                        mobileCards
                        caption={`Waiting list for ${space}`}
                      />
                    </Card>
                  );
                })}
              </div>
            )
          ) : null}

          {/* ---------------------------------------- in progress ------- */}
          {phase === "IN_PROGRESS" ? (
            rows.length === 0 ? (
              <Card>
                <EmptyState
                  icon="contract"
                  title="Nobody is mid-agreement"
                  body="Applicants show up here from the moment you add them as a vendor or raise their agreement, and stay until they're signed, paid and selling."
                />
              </Card>
            ) : (
              <div className="stack g-4">
                <div className="grid-auto" style={{ ["--min" as string]: "180px" }}>
                  <Stat
                    icon="mail"
                    label="Awaiting signature"
                    value={progressStats.awaitingSignature}
                    sub={
                      progressStats.stale > 0
                        ? `${progressStats.stale} sitting over a week`
                        : "Waiting on them"
                    }
                  />
                  <Stat
                    icon="contract"
                    label="Awaiting your countersignature"
                    value={progressStats.awaitingCountersign}
                    sub="Signed by them, waiting on you"
                  />
                  <Stat
                    icon="dollar"
                    label="Awaiting first rent"
                    value={progressStats.awaitingRent}
                    sub={
                      progressStats.owedCents > 0
                        ? `${money(progressStats.owedCents)} outstanding`
                        : "Nothing outstanding"
                    }
                  />
                </div>
                {rows.map(renderInProgress)}
              </div>
            )
          ) : null}

          {/* ----------------------------------------------- live ------- */}
          {phase === "LIVE" ? (
            <Card
              title={PHASE_LABEL.LIVE}
              subtitle={`${plural(rows.length, "vendor")} — nothing left to do here`}
              flush
            >
              <DataTable
                rows={rows}
                columns={liveColumns}
                rowKey={(a) => a.id}
                mobileCards
                defaultSort={{ key: "business", dir: "asc" }}
                caption="Applicants who are now selling at the market"
                empty={
                  <EmptyState
                    icon="store"
                    title="Nobody is selling yet"
                    body="Applicants move here once their agreement is fully signed, the first month is paid and their portal unlocks."
                  />
                }
              />
            </Card>
          ) : null}

          {/* -------------------------------------- backed out ---------- */}
          {phase === "WITHDRAWN" ? renderWithdrawn() : null}

          {/* ------------------------------------------- declined ------- */}
          {phase === "DECLINED" ? (
            <Card title={PHASE_LABEL.DECLINED} subtitle={plural(rows.length, "application")} flush>
              <DataTable
                rows={rows}
                columns={declinedColumns}
                rowKey={(a) => a.id}
                mobileCards
                defaultSort={{ key: "applied", dir: "desc" }}
                caption="Applications that were declined"
                empty={
                  <EmptyState
                    icon="inbox"
                    title="Nothing declined"
                    body="Applications you turn down are kept here so you have the record."
                  />
                }
              />
            </Card>
          ) : null}
        </div>
      )}
    </main>
  );
}

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
  vendorSignedAt: string | null;
  marketSignedAt: string | null;
  viewedAt: string | null;
  delivery: Delivery | null;
};

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
};

type Counts = Record<Phase, number>;
const ZERO_COUNTS: Counts = { NEW: 0, IN_PROGRESS: 0, LIVE: 0, DECLINED: 0 };

const PHASES: Phase[] = ["NEW", "IN_PROGRESS", "LIVE", "DECLINED"];

/** Short enough to sit in a segmented control on a phone. */
const PHASE_SHORT: Record<Phase, string> = {
  NEW: "New",
  IN_PROGRESS: "In progress",
  LIVE: "Selling",
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

const statusTone = (s: string): BadgeTone =>
  s === "ACCEPTED" ? "success" : s === "DECLINED" ? "danger" : "neutral";

const statusLabel = (s: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : "—");

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
        `Vendor ${d.vendor.code}. They've moved to Agreement in progress — the portal stays locked until the agreement is signed and first rent is paid.`,
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
        `Signing link emailed to ${a.email} — vendor ${d.vendor.code}. They're now under Agreement in progress.`,
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
            <DeliveryBadges delivery={a.agreement?.delivery ?? null} />
            {a.stage === "CONTRACT" ? null : <Badge tone={sb.tone} dot>{sb.label}</Badge>}
          </>
        }
      >
        <div className="stack g-4">
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

            {(a.stage === "CALLED" || a.stage === "VIEWING") && (
              <Button
                variant="primary"
                icon="contract"
                disabled={busy}
                onClick={() => setForm(form?.id === a.id ? null : { id: a.id, booth: a.boothRequest || "", rent: "", start: new Date().toISOString().slice(0, 10) })}
              >
                Create agreement
              </Button>
            )}

            <Button icon="user" disabled={busy} onClick={() => addAsVendor(a)}>
              Add as vendor
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
            <DeliveryBadges delivery={del} />
            {a.vendor ? <Badge tone="neutral" dot>{a.vendor.code}</Badge> : null}
          </>
        }
      >
        <div className="stack g-4">
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

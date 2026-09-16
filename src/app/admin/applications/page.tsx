"use client";

// Standalone applications workspace — same admin session, same pipeline actions
import { useCallback, useEffect, useState } from "react";
import { usePulse } from "@/lib/usePulse";
import {
  Icon, Button, LinkButton, Field, Input, MoneyInput, Textarea,
  DataTable, Badge, Card, EmptyState, SkeletonCard, PageHeader,
  useDialog, useToast, type Column, type BadgeTone,
} from "@/components/ui";
import { fmtDate, fmtPhone, plural, relTime } from "@/lib/format";

type App = { id: string; status: string; stage?: string; viewingAt?: string; adminNotes?: string; businessName: string; contactName: string; email: string; phone: string; category: string; products: string; boothRequest: string; phoneType?: string; notes: string; createdAt: string; decidedAt?: string | null };

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

type DeliveryState = "DRAFT" | "SENT" | "OPENED" | "SIGNED" | "EXECUTED";

const DAY_MS = 86_400_000;
/** Matches the threshold /api/admin/contracts uses for its `stale` flag. */
const STALE_DAYS = 7;

/**
 * At-a-glance delivery status for an agreement. Always a word plus a dot or an
 * icon — never colour alone. `stale` gets its own second badge so "sent a while
 * ago and still nothing back" can't hide inside the calm blue "Sent" badge.
 */
function DeliveryBadges({ state, sentAt }: { state: DeliveryState; sentAt?: string | null }) {
  const days = sentAt ? Math.floor((Date.now() - new Date(sentAt).getTime()) / DAY_MS) : null;
  const stale = (state === "SENT" || state === "OPENED") && days !== null && days >= STALE_DAYS;
  return (
    <>
      {state === "DRAFT" ? <Badge tone="neutral" dot>Not sent</Badge> : null}
      {state === "SENT" ? (
        <Badge tone="info" icon="mail">{sentAt ? `Sent ${relTime(sentAt)}` : "Sent"}</Badge>
      ) : null}
      {state === "OPENED" ? <Badge tone="warn" icon="eye">Opened, not signed</Badge> : null}
      {state === "SIGNED" ? <Badge tone="info" icon="check">Awaiting your signature</Badge> : null}
      {state === "EXECUTED" ? <Badge tone="success" icon="checkCircle">Fully signed</Badge> : null}
      {stale && days !== null ? (
        <Badge tone="danger" icon="warning">Sitting {plural(days, "day")}</Badge>
      ) : null}
    </>
  );
}

/**
 * What this page can HONESTLY say about an application's agreement.
 *
 * /api/admin/applications returns VendorApplication rows only — no Contract —
 * so there is no viewedAt / vendorSignedAt / marketSignedAt here and OPENED,
 * SIGNED and EXECUTED can never be derived on this screen; the admin agreements
 * screen reads /api/admin/contracts, which now serves a ready-made `delivery`
 * object with all five. DeliveryBadges still renders all five so both screens
 * speak with one vocabulary.
 *
 * SENT is trustworthy where it does appear: the same request that sets stage
 * CONTRACT creates the contract, emails the signing link and stamps decidedAt,
 * so decidedAt is the real send time for that path (not a proxy). An agreement
 * raised from the agreements screen never touches the application's stage, so
 * it shows nothing here.
 *
 * In practice CONTRACT and VENDOR are rare on this screen: /api/admin/appl-
 * ications lists only rows with `vendorId: ""`, and both of those stages stamp
 * a vendorId, which drops the row from this list. The branches stay so the
 * badges are right if that row is ever shown (the old inline "Agreement sent"
 * badge in the decided table had the same blind spot). Returns null where a
 * badge would be noise: NEW is too early to ask about an agreement, DONE means
 * declined.
 */
function agreementFor(a: App): { state: DeliveryState; sentAt: string | null } | null {
  if (a.stage === "CONTRACT") return { state: "SENT", sentAt: a.decidedAt ?? null };
  if (a.stage === "CALLED" || a.stage === "VIEWING" || a.stage === "VENDOR") {
    return { state: "DRAFT", sentAt: null };
  }
  return null;
}

const statusTone = (s: string): BadgeTone =>
  s === "ACCEPTED" ? "success" : s === "DECLINED" ? "danger" : "neutral";

const statusLabel = (s: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : "—");

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
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [form, setForm] = useState<{ id: string; booth: string; rent: string; start: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/applications");
    if (r.status === 401) { window.location.href = "/admin"; return; }
    if (r.ok) setApps((await r.json()).applications);
    setLoading(false);
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
        `Vendor ${d.vendor.code}. The portal stays locked until the agreement is signed and first rent is paid.`,
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
      toast.success("Agreement created", `Signing link emailed to ${a.email} — vendor ${d.vendor.code}.`);
    }
  };

  const pending = apps.filter((a) => a.status === "PENDING");
  const decided = apps.filter((a) => a.status !== "PENDING");

  const decidedColumns: Column<App>[] = [
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
      header: "Status",
      align: "right",
      sortBy: (a) => a.status,
      cell: (a) => {
        const del = agreementFor(a);
        return (
          <span className="row g-2 end wrap">
            <Badge tone={statusTone(a.status)} dot>{statusLabel(a.status)}</Badge>
            {del ? <DeliveryBadges state={del.state} sentAt={del.sentAt} /> : null}
          </span>
        );
      },
    },
  ];

  return (
    <main className="content content-narrow">
      <div className="mb-3">
        <LinkButton href="/admin" variant="ghost" size="sm" icon="arrowLeft">Admin</LinkButton>
      </div>

      <PageHeader
        title="Vendor applications"
        subtitle="Review and call (save your notes) → book a viewing or skip it → create the agreement. Portal access opens itself only once the agreement is fully signed and first rent is paid."
      />

      {loading ? (
        <div className="stack g-4">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
        </div>
      ) : pending.length === 0 ? (
        <Card>
          <EmptyState
            icon="inbox"
            title="No pending applications"
            body="Everything that's come in has been decided. New applications land here the moment they're submitted."
          />
        </Card>
      ) : (
        <div className="stack g-4">
          {pending.map((a) => {
            const sb = stageBadge(a.stage);
            const del = agreementFor(a);
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
                    {del ? <DeliveryBadges state={del.state} sentAt={del.sentAt} /> : null}
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
          })}
        </div>
      )}

      {decided.length > 0 && (
        <div className="mt-6">
          <Card title="Decided" subtitle={plural(decided.length, "application")}>
            <DataTable
              rows={decided}
              columns={decidedColumns}
              rowKey={(a) => a.id}
              mobileCards
              defaultSort={{ key: "applied", dir: "desc" }}
              caption="Applications that have already been accepted or declined"
            />
          </Card>
        </div>
      )}
    </main>
  );
}

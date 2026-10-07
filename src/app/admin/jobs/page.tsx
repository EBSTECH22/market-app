"use client";

/**
 * Job applicants — cashier applications from the public /jobs page.
 *
 * Newest first. Each one opens to everything they wrote, with call / text /
 * email buttons, a status to move them along, and private notes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge, Button, Card, EmptyState, LinkButton, Note, PageHeader, Segmented, Select, Textarea, useDialog, useToast,
} from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { usePulse } from "@/lib/usePulse";
import { shiftsLabel } from "@/lib/jobs";

type App = {
  id: string; position: string; name: string; email: string; phone: string; over18: string;
  days: string; hours: string; startDate: string; experience: string; history: string; why: string;
  references: string; resumeUrl: string; heardFrom: string; notes: string;
  status: string; adminNotes: string; createdAt: string;
};

const STATUS: Record<string, { label: string; tone: "info" | "warn" | "success" | "neutral" | "danger" }> = {
  NEW: { label: "New", tone: "info" },
  CONTACTED: { label: "Contacted", tone: "warn" },
  INTERVIEW: { label: "Interview", tone: "warn" },
  HIRED: { label: "Hired", tone: "success" },
  DECLINED: { label: "Declined", tone: "neutral" },
};

function Line({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="stack g-1">
      <span className="t-xs t-muted" style={{ textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>{label}</span>
      <span style={{ whiteSpace: "pre-wrap" }}>{value}</span>
    </div>
  );
}

export default function JobsAdminPage() {
  const toast = useToast();
  const dialog = useDialog();
  const [apps, setApps] = useState<App[] | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<"OPEN" | "HIRED" | "DECLINED" | "ALL">("OPEN");
  const [openId, setOpenId] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/jobs");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(String(d.error || "Couldn't load applicants.")); return; }
    setErr("");
    setApps(d.applications || []);
  }, []);
  useEffect(() => { void load(); }, [load]);
  usePulse(() => { void load(); });

  const patch = async (id: string, body: object, ok?: string) => {
    const r = await fetch("/api/admin/jobs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...body }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error("Didn't save", String(d.error || "")); return; }
    if (ok) toast.success(ok);
    await load();
  };

  const shown = useMemo(() => (apps || []).filter((a) =>
    filter === "ALL" ? true : filter === "OPEN" ? !["HIRED", "DECLINED"].includes(a.status) : a.status === filter
  ), [apps, filter]);
  const openCount = (apps || []).filter((a) => !["HIRED", "DECLINED"].includes(a.status)).length;

  return (
    <main className="content" style={{ maxWidth: 900 }}>
      <div className="mb-3">
        <LinkButton href="/admin" variant="ghost" size="sm" icon="arrowLeft">Admin</LinkButton>
      </div>
      <PageHeader
        title="Job applicants"
        subtitle="Cashier applications from your public jobs page."
        actions={<LinkButton href="/jobs" variant="secondary" size="sm" icon="link" external>Open the jobs page</LinkButton>}
      />
      {err ? <Note tone="error">{err}</Note> : null}

      <div className="mb-3">
        <Segmented<"OPEN" | "HIRED" | "DECLINED" | "ALL">
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "OPEN", label: `Open (${openCount})` },
            { value: "HIRED", label: "Hired" },
            { value: "DECLINED", label: "Declined" },
            { value: "ALL", label: "All" },
          ]}
        />
      </div>

      {!apps ? (
        <p className="t-muted">Loading…</p>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon="users"
            title={filter === "OPEN" ? "No open applications" : "Nothing here"}
            body="Share the jobs page — market.dailybreadbaked.com/jobs — and applications land here."
          />
        </Card>
      ) : (
        <div className="stack g-3">
          {shown.map((a) => {
            const open = openId === a.id;
            const st = STATUS[a.status] || STATUS.NEW;
            const dayList = a.days ? shiftsLabel(a.days) : "";
            const tel = a.phone.replace(/[^\d+]/g, "");
            return (
              <Card key={a.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(open ? "" : a.id)}
                  style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}
                  aria-expanded={open}
                >
                  <div className="row between wrap g-2" style={{ alignItems: "center" }}>
                    <div className="stack g-1" style={{ minWidth: 0 }}>
                      <b>{a.name}</b>
                      <span className="t-sm t-muted">{a.position} · {dayList || "No shifts given"}</span>
                    </div>
                    <div className="row g-2" style={{ alignItems: "center" }}>
                      {a.over18 === "NO" ? <Badge tone="warn">Under 18</Badge> : null}
                      <Badge tone={st.tone} dot>{st.label}</Badge>
                      <span className="t-xs t-muted">{fmtDateTime(a.createdAt)}</span>
                    </div>
                  </div>
                </button>

                {open ? (
                  <div className="stack g-4 mt-4">
                    <div className="row wrap g-2">
                      <a className="btn btn-primary btn-sm" href={`tel:${tel}`}>Call {a.phone}</a>
                      <a className="btn btn-secondary btn-sm" href={`sms:${tel}`}>Text</a>
                      <a className="btn btn-secondary btn-sm" href={`mailto:${a.email}?subject=${encodeURIComponent("Your Community Harvest application")}`}>Email</a>
                      {a.resumeUrl ? <a className="btn btn-secondary btn-sm" href={a.resumeUrl} target="_blank" rel="noopener noreferrer">Resume</a> : null}
                    </div>
                    <div className="grid-auto" style={{ ["--min" as string]: "220px" }}>
                      <Line label="Email" value={a.email} />
                      <Line label="18 or older" value={a.over18 === "YES" ? "Yes" : a.over18 === "NO" ? "No" : ""} />
                      <Line label="Shifts they can work" value={dayList} />
                      <Line label="Schedule notes" value={a.hours} />
                      <Line label="Can start" value={a.startDate} />
                      <Line label="Heard about us" value={a.heardFrom} />
                    </div>
                    <Line label="Register / customer service experience" value={a.experience} />
                    <Line label="Recent jobs" value={a.history} />
                    <Line label="Why here" value={a.why} />
                    <Line label="References" value={a.references} />
                    <Line label="Anything else" value={a.notes} />

                    <div className="row wrap g-3" style={{ alignItems: "flex-end" }}>
                      <label className="stack g-1">
                        <span className="t-xs t-muted">Status</span>
                        <Select value={a.status} onChange={(e) => void patch(a.id, { status: e.target.value }, "Status updated")} style={{ width: 170 }}>
                          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </Select>
                      </label>
                    </div>
                    <div className="stack g-2">
                      <span className="t-xs t-muted">Your notes (only staff see these)</span>
                      <Textarea
                        rows={3}
                        value={notes[a.id] ?? a.adminNotes}
                        onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                        placeholder="Called Tue, interview Sat at 10…"
                      />
                      <div className="row g-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={(notes[a.id] ?? a.adminNotes) === a.adminNotes}
                          onClick={() => void patch(a.id, { adminNotes: notes[a.id] ?? "" }, "Notes saved")}
                        >
                          Save notes
                        </Button>
                        <span className="grow" />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          onClick={async () => {
                            const yes = await dialog.confirm({ title: `Delete ${a.name}'s application?`, body: "It's removed for good.", confirmLabel: "Delete", tone: "danger" });
                            if (!yes) return;
                            await fetch(`/api/admin/jobs?id=${encodeURIComponent(a.id)}`, { method: "DELETE" });
                            await load();
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}

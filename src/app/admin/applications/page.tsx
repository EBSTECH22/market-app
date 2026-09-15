"use client";

// Standalone applications workspace — same admin session, same pipeline actions
import { useCallback, useEffect, useState } from "react";
import { usePulse } from "@/lib/usePulse";

type App = { id: string; status: string; stage?: string; viewingAt?: string; adminNotes?: string; businessName: string; contactName: string; email: string; phone: string; category: string; products: string; boothRequest: string; phoneType?: string; notes: string; createdAt: string };

export default function ApplicationsPage() {
  const [apps, setApps] = useState<App[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [form, setForm] = useState<{ id: string; booth: string; rent: string; start: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/applications");
    if (r.status === 401) { window.location.href = "/admin"; return; }
    if (r.ok) setApps((await r.json()).applications);
  }, []);
  useEffect(() => { load(); }, [load]);
  usePulse(load);

  const act = async (id: string, payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/applications/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { alert(d.error || "Couldn't update."); return null; }
      load();
      return d;
    } finally { setBusy(false); }
  };

  const pending = apps.filter((a) => a.status === "PENDING");
  const decided = apps.filter((a) => a.status !== "PENDING");

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "22px 16px 60px" }}>
      <a className="btn small ghost" href="/admin">← ADMIN</a>
      <h1 className="display" style={{ fontSize: 22, margin: "12px 0 2px" }}>VENDOR APPLICATIONS 📋</h1>
      <p style={{ fontSize: 12.5, color: "var(--ash)", marginBottom: 14 }}>
        Pipeline: review &amp; call (save notes) → viewing or skip → create the contract. Portal access opens itself only when the contract is fully signed AND first rent is paid.
      </p>
      {pending.length === 0 && <div className="card"><p className="ok">No pending applications. 🎉</p></div>}
      {pending.map((a) => (
        <div className="card" key={a.id} style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>
              <b>{a.businessName}</b> <span style={{ fontSize: 12, color: "var(--ash)" }}>· {a.contactName} · {a.category}</span><br />
              <span style={{ fontSize: 12 }}>{a.email} · {a.phone}</span>
            </span>
            <b style={{ fontSize: 11, color: "var(--ash)" }}>{a.stage === "VIEWING" ? `📍 ${a.viewingAt}` : a.stage || "NEW"}</b>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            <button className="btn small ghost" onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? "HIDE" : "DETAILS"}</button>
            {(!a.stage || a.stage === "NEW") && <button className="btn small" disabled={busy} onClick={() => act(a.id, { action: "mark_called" })}>📞 CALLED</button>}
            {(a.stage === "CALLED" || a.stage === "VIEWING") && (
              <>
                {a.stage === "CALLED" && <button className="btn small ghost" disabled={busy} onClick={() => {
                  const when = prompt("Viewing date & time (emailed exactly as typed):", "Tuesday Sep 22, 10:00 AM");
                  if (when && when.trim()) act(a.id, { action: "schedule_viewing", when: when.trim() });
                }}>📅 SCHEDULE VIEWING</button>}
                <button className="btn small" disabled={busy} onClick={() => setForm(form?.id === a.id ? null : { id: a.id, booth: a.boothRequest || "", rent: "", start: new Date().toISOString().slice(0, 10) })}>📝 CREATE CONTRACT</button>
              </>
            )}
            <button className="btn small ghost" disabled={busy} onClick={async () => {
              if (!confirm(`Add ${a.businessName} as a vendor now? The application files onto their vendor profile; portal stays locked until contract + first rent.`)) return;
              const d = await act(a.id, { action: "add_vendor" });
              if (d) alert(`Added as vendor ${d.vendor.code} ✓`);
            }}>👤 ADD AS VENDOR</button>
            <button className="btn small ghost" disabled={busy} onClick={() => {
              const reason = prompt("Optional note for the decline email:") || "";
              act(a.id, { action: "decline", reason });
            }}>❌ DECLINE</button>
          </div>
          {open === a.id && (
            <div style={{ fontSize: 13, marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <b>Products:</b> {a.products}<br />
              {a.boothRequest && <><b>Booth requested:</b> {a.boothRequest}<br /></>}
              {a.phoneType && <><b>Phone:</b> {a.phoneType}<br /></>}
              {a.notes && <><b>Their notes:</b> {a.notes}<br /></>}
              <a href={`/admin/applications/${a.id}/print`} target="_blank" rel="noopener">🖨 print full application</a>
              <div style={{ marginTop: 8 }}>
                <label style={{ fontSize: 11 }}>📞 Call &amp; review notes</label>
                <textarea rows={3} value={notes[a.id] ?? a.adminNotes ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))} />
                <button className="btn small ghost" disabled={busy} style={{ marginTop: 4 }} onClick={() => act(a.id, { action: "save_notes", notes: notes[a.id] ?? a.adminNotes ?? "" })}>SAVE NOTES</button>
              </div>
            </div>
          )}
          {form?.id === a.id && (
            <div style={{ border: "1px solid var(--border)", borderRadius: 12, background: "#fafafa", padding: "10px 12px", marginTop: 8 }}>
              <b style={{ fontSize: 12.5 }}>📝 CREATE CONTRACT — first month is FULL rent; month two prorates</b>
              <label>Booth label</label>
              <input value={form.booth} onChange={(e) => setForm((f) => f && ({ ...f, booth: e.target.value }))} placeholder="A3" />
              <label>Monthly rent (dollars)</label>
              <input type="number" min="1" step="1" value={form.rent} onChange={(e) => setForm((f) => f && ({ ...f, rent: e.target.value }))} placeholder="96" />
              <label>Start date</label>
              <input type="date" value={form.start} onChange={(e) => setForm((f) => f && ({ ...f, start: e.target.value }))} />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn small" disabled={busy} onClick={async () => {
                  const d = await act(a.id, { action: "create_contract", boothLabel: form.booth, rentDollars: Number(form.rent), startDate: form.start });
                  if (d) {
                    setForm(null);
                    if (d.emailErrors && d.emailErrors.length > 0) alert(`Contract created BUT email failed:\n${d.emailErrors.join("\n")}\n\nSigning link:\n${d.signUrl}`);
                    else alert(`Contract created & signing link emailed ✓ — vendor ${d.vendor.code}.`);
                  }
                }}>CREATE &amp; SEND FOR SIGNATURE</button>
                <button className="btn small ghost" onClick={() => setForm(null)}>CANCEL</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {decided.length > 0 && (
        <div className="card" style={{ marginTop: 6 }}>
          <b style={{ fontSize: 12 }}>DECIDED</b>
          {decided.map((a) => (
            <div key={a.id} style={{ fontSize: 12.5, borderTop: "1px solid var(--border)", padding: "6px 0", display: "flex", justifyContent: "space-between" }}>
              <span>{a.businessName} · {a.email}</span>
              <b style={{ color: a.status === "ACCEPTED" ? "var(--green)" : "var(--red)" }}>{a.status}{a.stage === "CONTRACT" ? " · 📝 CONTRACT SENT" : ""}</b>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

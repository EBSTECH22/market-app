"use client";

// Payroll tab — the merged, per-person replacement for the old Team +
// Paystubs tabs. One card per employee holds everything: live clock status,
// pending timesheet review, any-period entry browsing/editing, manual
// entries, rep invoices, and their paystubs.

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveTimesheet,
  rejectTimeEntry,
  addTimeEntryForUser,
  adminEditTimeEntry,
  deleteTimeEntry,
  getUserPeriodEntries,
} from "@/actions/timeclock";
import {
  getAllRepInvoices,
  approveRepInvoice,
  rejectRepInvoice,
  markRepInvoicePaid,
  editRepInvoiceAmount,
} from "@/actions/rep-invoices";
import PaystubSection from "@/components/paystub-section";
import { markPaystubPaid, generatePaystub } from "@/actions/paystubs";
import PayrollSummary from "@/components/payroll-summary";

const TZ = "America/Chicago";
const fmtT = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const fmtD = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
const fmtDY = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" });
const hrs = (i: string, o: string | null) => (o ? (new Date(o).getTime() - new Date(i).getTime()) / 3600000 : 0);
const INVOICE_LABELS: Record<string, string> = {
  REIMBURSEMENT: "Reimbursement",
  BONUS_COMMISSION: "Bonus commission",
  COMMISSION_DRAW: "50% draw",
  COMMISSION_FINAL: "Final commission",
};

function ctInputToUTC(val: string): string {
  // datetime-local value interpreted as Central Time
  const [d, t] = val.split("T");
  const [y, mo, day] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, day, h, mi));
  const ctStr = guess.toLocaleString("en-US", { timeZone: TZ, hour12: false });
  const asCT = new Date(ctStr);
  const offset = guess.getTime() - asCT.getTime() + guess.getTimezoneOffset() * 60000;
  return new Date(Date.UTC(y, mo - 1, day, h, mi) + offset).toISOString();
}

function utcToCTInput(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find(p => p.type === t)?.value || "";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

const STATUS_CHIP: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  SUBMITTED: "bg-blue-100 text-blue-700",
  APPROVED: "bg-green-100 text-green-700",
  REJECTED: "bg-red-100 text-red-700",
};

// ── One entry row: inline editable, deletable ─────────────────────────────
function PayrollEntryRow({ entry, onChanged }: { entry: any; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [addr, setAddr] = useState(entry.propertyAddress || "");
  const [ci, setCi] = useState(utcToCTInput(entry.clockIn));
  const [co, setCo] = useState(entry.clockOut ? utcToCTInput(entry.clockOut) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true); setErr("");
    try {
      await adminEditTimeEntry(entry.id, {
        propertyAddress: addr,
        clockIn: ctInputToUTC(ci),
        clockOut: co ? ctInputToUTC(co) : undefined,
      });
      setEditing(false);
      onChanged();
    } catch (e: any) { setErr(e.message || "Save failed"); } finally { setBusy(false); }
  }

  async function del() {
    if (!confirm("Delete this time entry?")) return;
    setBusy(true);
    try { await deleteTimeEntry(entry.id); onChanged(); } catch (e: any) { setErr(e.message || "Delete failed"); setBusy(false); }
  }

  if (editing) {
    return (
      <div className="px-4 py-2.5 bg-amber-50/60 space-y-2">
        <input value={addr} onChange={e => setAddr(e.target.value)} placeholder="Property / description"
          className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
        <div className="flex gap-2 items-center flex-wrap">
          <input type="datetime-local" value={ci} onChange={e => setCi(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
          <span className="text-xs text-gray-400">→</span>
          <input type="datetime-local" value={co} onChange={e => setCo(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
          <button disabled={busy} onClick={save} className="px-3 py-1.5 bg-gray-900 text-white text-xs font-bold rounded-lg disabled:opacity-50">Save</button>
          <button onClick={() => setEditing(false)} className="text-xs text-gray-500">Cancel</button>
        </div>
        {err && <p className="text-[11px] text-red-600">{err}</p>}
      </div>
    );
  }

  return (
    <div className="px-4 py-2.5 flex items-center justify-between gap-2 hover:bg-gray-50/60">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-gray-900 truncate">{fmtD(entry.clockIn)} · {fmtT(entry.clockIn)} – {entry.clockOut ? fmtT(entry.clockOut) : "…"}</p>
        <p className="text-[11px] text-gray-500 truncate">{entry.propertyAddress}</p>
        {entry.status === "REJECTED" && entry.rejectReason && <p className="text-[11px] text-red-600">Rejected: {entry.rejectReason}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs font-bold text-gray-900">{entry.clockOut ? `${hrs(entry.clockIn, entry.clockOut).toFixed(2)}h` : "live"}</span>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${STATUS_CHIP[entry.status] || "bg-gray-100 text-gray-500"}`}>{entry.status}</span>
        <button onClick={() => setEditing(true)} className="text-[11px] font-semibold text-blue-600 hover:underline">Edit</button>
        <button onClick={del} className="text-[11px] font-semibold text-red-500 hover:underline">Del</button>
      </div>
    </div>
  );
}

// ── Add entry inline form ─────────────────────────────────────────────────
function AddEntryForm({ userId, defaultDate, onDone }: { userId: string; defaultDate?: string; onDone: () => void }) {
  const base = defaultDate ? defaultDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const [addr, setAddr] = useState("");
  const [ci, setCi] = useState(`${base}T08:00`);
  const [co, setCo] = useState(`${base}T17:00`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function add() {
    setBusy(true); setErr("");
    try {
      await addTimeEntryForUser({ userId, propertyAddress: addr || "Manual entry", clockIn: ctInputToUTC(ci), clockOut: ctInputToUTC(co) });
      onDone();
    } catch (e: any) { setErr(e.message || "Failed"); setBusy(false); }
  }

  return (
    <div className="px-4 py-3 bg-blue-50/60 border-t border-blue-100 space-y-2">
      <p className="text-[11px] font-bold text-blue-800">New time entry (times are Central)</p>
      <input value={addr} onChange={e => setAddr(e.target.value)} placeholder="Property / description"
        className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
      <div className="flex gap-2 items-center flex-wrap">
        <input type="datetime-local" value={ci} onChange={e => setCi(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
        <span className="text-xs text-gray-400">→</span>
        <input type="datetime-local" value={co} onChange={e => setCo(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
        <button disabled={busy} onClick={add} className="px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded-lg disabled:opacity-50">Add Entry</button>
      </div>
      {err && <p className="text-[11px] text-red-600">{err}</p>}
    </div>
  );
}

// ── Rep invoice rows inside a person card ─────────────────────────────────
function PersonInvoices({ invoices, onChanged }: { invoices: any[]; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [amt, setAmt] = useState("");
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");

  async function run(id: string, fn: () => Promise<any>) {
    setBusyId(id); setErr("");
    try { await fn(); setEditingId(null); setRejectingId(null); setReason(""); onChanged(); }
    catch (e: any) { setErr(e.message || "Failed"); } finally { setBusyId(null); }
  }

  if (invoices.length === 0) return null;
  return (
    <div className="border-t border-gray-100">
      <p className="px-4 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">Invoices from this rep</p>
      {err && <p className="px-4 text-[11px] text-red-600">{err}</p>}
      {invoices.map(inv => (
        <div key={inv.id} className="px-4 py-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-900">{INVOICE_LABELS[inv.type] || inv.type}{inv.job?.customerName ? ` · ${inv.job.customerName}` : ""}</p>
            <p className="text-[11px] text-gray-500 truncate">{inv.description}</p>
          </div>
          <div className="shrink-0 text-right space-y-1">
            {editingId === inv.id ? (
              <div className="flex items-center gap-1 justify-end">
                <input type="number" step="0.01" value={amt} onChange={e => setAmt(e.target.value)} className="w-20 rounded border border-gray-300 px-1.5 py-1 text-xs text-right" />
                <button disabled={busyId === inv.id} onClick={() => run(inv.id, () => editRepInvoiceAmount(inv.id, parseFloat(amt)))} className="text-[11px] font-bold text-gray-900">Save</button>
                <button onClick={() => setEditingId(null)} className="text-[11px] text-gray-500">✕</button>
              </div>
            ) : rejectingId === inv.id ? (
              <div className="flex items-center gap-1 justify-end">
                <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason" className="w-32 rounded border border-gray-300 px-1.5 py-1 text-[11px]" />
                <button disabled={busyId === inv.id} onClick={() => run(inv.id, () => rejectRepInvoice(inv.id, reason))} className="text-[11px] font-bold text-red-600">Reject</button>
                <button onClick={() => setRejectingId(null)} className="text-[11px] text-gray-500">✕</button>
              </div>
            ) : (
              <>
                <p className="text-xs font-extrabold text-gray-900">${Number(inv.amount).toFixed(2)}</p>
                <div className="flex gap-1.5 justify-end">
                  {inv.status === "SUBMITTED" && (
                    <button disabled={busyId === inv.id} onClick={() => run(inv.id, () => approveRepInvoice(inv.id))} className="text-[11px] font-bold text-green-600 hover:underline">Approve</button>
                  )}
                  {inv.status === "APPROVED" && (
                    <button disabled={busyId === inv.id} onClick={() => run(inv.id, () => markRepInvoicePaid(inv.id))} className="text-[11px] font-bold text-green-600 hover:underline">Mark Paid</button>
                  )}
                  <button onClick={() => { setEditingId(inv.id); setAmt(Number(inv.amount).toFixed(2)); }} className="text-[11px] font-semibold text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => setRejectingId(inv.id)} className="text-[11px] font-semibold text-red-500 hover:underline">Reject</button>
                </div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────
export default function PayrollTab({ timesheets, activeClockIns, draftEntries, users, allPaystubs }: {
  timesheets: any[];
  activeClockIns: any[];
  draftEntries: any[];
  users: any[];
  allPaystubs: any[];
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [periodData, setPeriodData] = useState<Record<string, any>>({});
  const [rejectingEntry, setRejectingEntry] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function loadInvoices() {
    try { setInvoices(await getAllRepInvoices()); } catch {}
  }
  useEffect(() => { loadInvoices(); }, []);

  async function loadPeriod(userId: string, anchorISO?: string) {
    try {
      const data = await getUserPeriodEntries(userId, anchorISO);
      setPeriodData(p => ({ ...p, [userId]: data }));
    } catch {}
  }

  function openCard(userId: string) {
    const next = openId === userId ? null : userId;
    setOpenId(next);
    setAddingFor(null);
    if (next && !periodData[next]) loadPeriod(next);
  }

  function refresh(userId: string) {
    const anchor = periodData[userId]?.period?.start;
    loadPeriod(userId, anchor ? new Date(new Date(anchor).getTime() + 12 * 3600000).toISOString() : undefined);
    loadInvoices();
    router.refresh();
  }

  async function handleApprove(timesheetId: string, userId: string) {
    setBusy(true); setErr("");
    try { await approveTimesheet(timesheetId); refresh(userId); }
    catch (e: any) { setErr(e.message || "Approve failed"); } finally { setBusy(false); }
  }

  async function handleRejectEntry(entryId: string, userId: string) {
    setBusy(true); setErr("");
    try { await rejectTimeEntry(entryId, rejectReason); setRejectingEntry(null); setRejectReason(""); refresh(userId); }
    catch (e: any) { setErr(e.message || "Reject failed"); } finally { setBusy(false); }
  }

  // Per-user rollups
  const pendingByUser = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const t of timesheets) if (t.status === "PENDING") { if (!m.has(t.user.id)) m.set(t.user.id, []); m.get(t.user.id)!.push(t); }
    return m;
  }, [timesheets]);
  const activeByUser = useMemo(() => new Map(activeClockIns.map((e: any) => [e.user.id, e])), [activeClockIns]);
  const draftsByUser = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const d of draftEntries) { if (!m.has(d.user.id)) m.set(d.user.id, []); m.get(d.user.id)!.push(d); }
    return m;
  }, [draftEntries]);
  const stubsByUser = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const p of allPaystubs) { const id = p.employee?.id; if (!id) continue; if (!m.has(id)) m.set(id, []); m.get(id)!.push(p); }
    return m;
  }, [allPaystubs]);
  const openInvoicesByUser = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const i of invoices) if (i.status === "SUBMITTED" || i.status === "APPROVED") { if (!m.has(i.repId)) m.set(i.repId, []); m.get(i.repId)!.push(i); }
    return m;
  }, [invoices]);

  const needsReview = timesheets.filter(t => t.status === "PENDING").length;
  const needsInvoiceReview = invoices.filter(i => i.status === "SUBMITTED").length;
  const unpaidStubs = allPaystubs.filter((s: any) => s.status !== "PAID" && s.status !== "VOIDED");
  const stublessApproved = timesheets.filter((t: any) =>
    (t.status === "APPROVED" || t.status === "PARTIAL") && !t.hasPaystub &&
    // Hours-only admins (no rate) never get paystubs — don't flag them as missing one
    !(t.user?.role === "ADMIN" && !(Number(t.user?.hourlyRate || 0) > 0)));
  const [payingStub, setPayingStub] = useState<string | null>(null);

  async function payStub(id: string) {
    setPayingStub(id);
    try { await markPaystubPaid(id); router.refresh(); } catch (e: any) { setErr(e.message || "Failed"); } finally { setPayingStub(null); }
  }

  return (
    <div className="space-y-4">
      {/* Attention strip */}
      {(needsReview > 0 || needsInvoiceReview > 0 || activeClockIns.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {needsReview > 0 && <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">{needsReview} timesheet{needsReview > 1 ? "s" : ""} to review</span>}
          {needsInvoiceReview > 0 && <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">{needsInvoiceReview} invoice{needsInvoiceReview > 1 ? "s" : ""} to review</span>}
          {activeClockIns.length > 0 && <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-green-100 text-green-700">{activeClockIns.length} clocked in now</span>}
          {unpaidStubs.length > 0 && <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">{unpaidStubs.length} paystub{unpaidStubs.length > 1 ? "s" : ""} awaiting payment</span>}
        </div>
      )}
      {err && <p className="text-xs text-red-600 font-medium">{err}</p>}

      {/* Approved timesheets that never got a paystub (generation failed or predates paystubs) */}
      {stublessApproved.length > 0 && (
        <div className="bg-white rounded-xl border border-red-200 overflow-hidden">
          <p className="px-4 py-2.5 bg-red-50 text-xs font-bold text-red-800 border-b border-red-100">Approved hours with no paystub yet — generate to move them into the payment queue</p>
          {stublessApproved.map((ts: any) => (
            <div key={ts.id} className="px-4 py-2.5 flex items-center justify-between gap-3 border-t border-gray-50 first:border-t-0">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-gray-900">{ts.user?.fullName || "Employee"}</p>
                <p className="text-[11px] text-gray-500">{fmtD(ts.periodStart)} – {fmtD(ts.periodEnd)} · {ts.entries.filter((e: any) => e.status === "APPROVED").reduce((s: number, e: any) => s + hrs(e.clockIn, e.clockOut), 0).toFixed(2)} approved hrs</p>
              </div>
              <button disabled={payingStub === ts.id} onClick={async () => {
                setPayingStub(ts.id); setErr("");
                try { await generatePaystub(ts.id); router.refresh(); }
                catch (e: any) { setErr(`${ts.user?.fullName || "Employee"}: ${e.message || "Paystub generation failed"}`); }
                finally { setPayingStub(null); }
              }} className="px-3 py-1.5 bg-red-600 text-white text-[11px] font-bold rounded-lg hover:bg-red-700 disabled:opacity-50 shrink-0">
                {payingStub === ts.id ? "…" : "Generate Paystub"}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Unpaid paystubs — the payment queue */}
      {unpaidStubs.length > 0 && (
        <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
          <p className="px-4 py-2.5 bg-amber-50 text-xs font-bold text-amber-800 border-b border-amber-100">Paystubs awaiting payment</p>
          {unpaidStubs.map((s: any) => (
            <div key={s.id} className="px-4 py-2.5 flex items-center justify-between gap-3 border-t border-gray-50 first:border-t-0">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-gray-900">{s.employee?.fullName || "Employee"}</p>
                <p className="text-[11px] text-gray-500">{fmtD(s.payPeriodStart)} – {fmtD(s.payPeriodEnd)} · pay date {fmtD(s.payDate)}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <p className="text-sm font-extrabold text-gray-900">${Number(s.netPay).toFixed(2)}</p>
                <button disabled={payingStub === s.id} onClick={() => payStub(s.id)}
                  className="px-3 py-1.5 bg-green-600 text-white text-[11px] font-bold rounded-lg hover:bg-green-700 disabled:opacity-50">
                  {payingStub === s.id ? "…" : "Mark Paid"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {users.map((user: any) => {
        const isOpen = openId === user.id;
        const pending = pendingByUser.get(user.id) || [];
        const active = activeByUser.get(user.id);
        const drafts = draftsByUser.get(user.id) || [];
        const stubs = stubsByUser.get(user.id) || [];
        const openInv = openInvoicesByUser.get(user.id) || [];
        const userUnpaidStubs = unpaidStubs.filter((s: any) => s.employee?.id === user.id);
        const pd = periodData[user.id];
        const attention = pending.length + openInv.filter((i: any) => i.status === "SUBMITTED").length;

        return (
          <div key={user.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {/* Header — Add Entry always visible here */}
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <button onClick={() => openCard(user.id)} className="flex items-center gap-3 text-left flex-1 min-w-0">
                <div className="relative w-9 h-9 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                  <span className="text-sm font-bold text-red-600">{(user.fullName || "?").charAt(0)}</span>
                  {active && <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-green-500 rounded-full border-2 border-white animate-pulse" />}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-gray-900 truncate">{user.fullName}</p>
                  <p className="text-[11px] text-gray-500">
                    {user.role === "OFFICE_MANAGER" ? "Office Manager · W-2" : user.role === "ADMIN" ? "Admin" : `${user.role.charAt(0) + user.role.slice(1).toLowerCase()} · 1099`}
                    {user.hourlyRate ? ` · $${Number(user.hourlyRate).toFixed(2)}/hr` : ""}
                    {active ? ` · clocked in ${fmtT(active.clockIn)}` : ""}
                  </p>
                </div>
              </button>
              <div className="flex items-center gap-2 shrink-0">
                {attention > 0 && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-600 text-white">{attention}</span>}
                {userUnpaidStubs.length > 0 && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">${userUnpaidStubs.reduce((s: number, x: any) => s + Number(x.netPay), 0).toFixed(0)} due</span>}
                <button onClick={() => { setOpenId(user.id); setAddingFor(addingFor === user.id ? null : user.id); if (!periodData[user.id]) loadPeriod(user.id); }}
                  className="px-2.5 py-1.5 bg-blue-600 text-white text-[11px] font-bold rounded-lg hover:bg-blue-700">+ Add Entry</button>
                <svg onClick={() => openCard(user.id)} className={`w-4 h-4 text-gray-400 cursor-pointer transition-transform ${isOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
              </div>
            </div>

            {isOpen && (
              <div>
                {addingFor === user.id && (
                  <AddEntryForm userId={user.id} defaultDate={pd?.period?.start} onDone={() => { setAddingFor(null); refresh(user.id); }} />
                )}

                {/* Pending timesheet review */}
                {pending.map((ts: any) => (
                  <div key={ts.id} className="border-t border-blue-100 bg-blue-50/50">
                    <div className="px-4 py-2 flex items-center justify-between">
                      <p className="text-[11px] font-bold text-blue-800">
                        Submitted {fmtDY(ts.submittedAt)} · {fmtD(ts.periodStart)} – {fmtD(ts.periodEnd)} · {ts.entries.reduce((s: number, e: any) => s + hrs(e.clockIn, e.clockOut), 0).toFixed(2)} hrs
                      </p>
                      <button disabled={busy} onClick={() => handleApprove(ts.id, user.id)}
                        className="px-3 py-1.5 bg-green-600 text-white text-[11px] font-bold rounded-lg hover:bg-green-700 disabled:opacity-50">Approve All → Paystub</button>
                    </div>
                    {ts.entries.map((e: any) => (
                      <div key={e.id}>
                        <div className="px-4 py-1.5 flex items-center justify-between text-xs">
                          <span className="text-gray-700">{fmtD(e.clockIn)} · {fmtT(e.clockIn)}–{e.clockOut ? fmtT(e.clockOut) : "…"} · {e.propertyAddress}</span>
                          <span className="flex items-center gap-2">
                            <span className="font-bold">{hrs(e.clockIn, e.clockOut).toFixed(2)}h</span>
                            {e.status === "REJECTED" ? <span className="text-red-600 text-[10px] font-bold">REJECTED</span> : (
                              <button onClick={() => { setRejectingEntry(e.id); setRejectReason(""); }} className="text-[11px] text-red-500 hover:underline">Reject</button>
                            )}
                          </span>
                        </div>
                        {rejectingEntry === e.id && (
                          <div className="px-4 pb-2 flex gap-2 items-center">
                            <input value={rejectReason} onChange={ev => setRejectReason(ev.target.value)} placeholder="Reason (required, sent to employee)"
                              className="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
                            <button disabled={busy || !rejectReason.trim()} onClick={() => handleRejectEntry(e.id, user.id)}
                              className="px-3 py-1.5 bg-red-600 text-white text-[11px] font-bold rounded-lg disabled:opacity-50">Confirm</button>
                            <button onClick={() => setRejectingEntry(null)} className="text-[11px] text-gray-500">Cancel</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}

                {/* Unsubmitted drafts (any period) */}
                {drafts.length > 0 && (
                  <div className="border-t border-gray-100">
                    <p className="px-4 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">Unsubmitted drafts · {drafts.length}</p>
                    {drafts.map((d: any) => <PayrollEntryRow key={d.id} entry={d} onChanged={() => refresh(user.id)} />)}
                  </div>
                )}

                {/* Rep invoices */}
                <PersonInvoices invoices={openInv} onChanged={() => refresh(user.id)} />

                {/* Period browser */}
                <div className="border-t border-gray-100">
                  <div className="px-4 py-2 flex items-center justify-between bg-gray-50">
                    <button onClick={() => pd && loadPeriod(user.id, pd.prevAnchor)} className="text-xs font-bold text-gray-600 hover:text-gray-900 px-2">‹ Prev</button>
                    <p className="text-[11px] font-bold text-gray-700">
                      {pd ? `${fmtD(pd.period.start)} – ${fmtD(pd.period.end)}${pd.isCurrent ? " · current period" : ""}` : "Loading…"}
                    </p>
                    <button onClick={() => pd?.nextAnchor && loadPeriod(user.id, pd.nextAnchor)} disabled={!pd?.nextAnchor}
                      className="text-xs font-bold text-gray-600 hover:text-gray-900 disabled:opacity-30 px-2">Next ›</button>
                  </div>
                  {pd && pd.entries.length === 0 && <p className="px-4 py-3 text-xs text-gray-400 text-center">No entries this period.</p>}
                  {pd && pd.entries.map((e: any) => <PayrollEntryRow key={e.id} entry={e} onChanged={() => refresh(user.id)} />)}
                  {pd && (
                    <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 flex justify-between text-[11px] font-bold text-gray-600">
                      <span>{pd.entries.filter((e: any) => e.clockOut).length} entries</span>
                      <span>{pd.entries.reduce((s: number, e: any) => s + hrs(e.clockIn, e.clockOut), 0).toFixed(2)} hrs</span>
                    </div>
                  )}
                </div>

                {/* Paystubs */}
                {stubs.length > 0 && (
                  <div className="border-t border-gray-100 px-4 py-3">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-2">Paystubs</p>
                    <PaystubSection paystubs={stubs} isAdmin />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Company-wide payroll summary (week/month/quarter/year) */}
      <PayrollSummary />
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createVendor, updateVendor, createApInvoice, editApInvoice, deleteApInvoice, recordApPayment } from "@/actions/accounting";
import { createAccount, updateAccount, deleteAccount, createAccountEntry, deleteAccountEntry, getAccountEntries, getProfitAndLoss, getBalanceSheet } from "@/actions/accounting-reports";
import { uploadFileDirect, buildStoragePath } from "@/lib/upload-helpers";
import PayrollTab from "@/components/timeclock-payroll";
import CreditAccountsManager from "@/components/credit-accounts-manager";
import CreditPaymentSchedule, { VendorCreditAccounts, useCreditAccounts } from "@/components/credit-payment-schedule";

type Tab = "payables" | "vendors" | "credit" | "accounts" | "reports" | "payroll";

const fmt = (n: number | string) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "—";
const CAT_LABEL: Record<string, string> = { CONTRACTOR: "Contractor", OVERHEAD: "Overhead", OTHER: "Other" };
const CAT_CHIP: Record<string, string> = { CONTRACTOR: "bg-purple-100 text-purple-700", OVERHEAD: "bg-sky-100 text-sky-700", OTHER: "bg-gray-100 text-gray-600" };

// ── New / edit vendor inline form ─────────────────────────────────────────
function VendorForm({ initial, onSaved, onCancel, accounts = [] }: { initial?: any; onSaved: (v?: any) => void; onCancel: () => void; accounts?: any[] }) {
  const [name, setName] = useState(initial?.name || "");
  const [category, setCategory] = useState(initial?.category || "OVERHEAD");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [email, setEmail] = useState(initial?.email || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [defaultAccountId, setDefaultAccountId] = useState(initial?.defaultAccountId || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true); setErr("");
    try {
      if (initial?.id) {
        await updateVendor(initial.id, { name, category, phone, email, notes, defaultAccountId: defaultAccountId || null });
        onSaved();
      } else {
        const v = await createVendor({ name, category, phone, email, notes, defaultAccountId: defaultAccountId || undefined });
        onSaved(v);
      }
    } catch (e: any) { setErr(e.message || "Save failed"); setBusy(false); }
  }

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Vendor name *" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <select value={category} onChange={e => setCategory(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
          <option value="CONTRACTOR">Contractor</option>
          <option value="OVERHEAD">Overhead</option>
          <option value="OTHER">Other</option>
        </select>
        <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      {accounts.length > 0 && (
        <select value={defaultAccountId} onChange={e => setDefaultAccountId(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
          <option value="">Default expense account (optional)…</option>
          {accounts.filter(a => ["COGS", "EXPENSE", "OTHER_EXPENSE"].includes(a.type) && a.active !== false).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      )}
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex gap-2">
        <button disabled={busy || !name.trim()} onClick={save} className="px-4 py-2 bg-gray-900 text-white text-xs font-bold rounded-lg disabled:opacity-50">{initial?.id ? "Save Vendor" : "Add Vendor"}</button>
        <button onClick={onCancel} className="px-4 py-2 text-xs font-semibold text-gray-500">Cancel</button>
      </div>
    </div>
  );
}

// ── Record payment form ───────────────────────────────────────────────────
function PaymentForm({ invoice, accounts = [], onDone, onCancel }: { invoice: any; accounts?: any[]; onDone: () => void; onCancel: () => void }) {
  const [amount, setAmount] = useState(invoice.balance.toFixed(2));
  const [refId, setRefId] = useState("");
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [surcharge, setSurcharge] = useState("");
  const [surchargeAccountId, setSurchargeAccountId] = useState("");
  const [surchargeRate, setSurchargeRate] = useState("3");

  async function save() {
    setBusy(true); setErr("");
    try {
      let receiptUrl: string | undefined;
      if (file) {
        const path = buildStoragePath(`ap-receipts/${invoice.id}`, file.name);
        receiptUrl = await uploadFileDirect(file, "crew-documents", path);
      }
      await recordApPayment(invoice.id, {
        amount: parseFloat(amount), referenceId: refId, method, notes, receiptUrl,
        surchargeAmount: surcharge ? parseFloat(surcharge) : undefined,
        surchargeAccountId: surcharge && surchargeAccountId ? surchargeAccountId : undefined,
      });
      onDone();
    } catch (e: any) { setErr(e.message || "Payment failed"); setBusy(false); }
  }

  const partial = parseFloat(amount || "0") < invoice.balance - 0.005;
  const surchargeNum = parseFloat(surcharge || "0") || 0;
  const cashOut = (parseFloat(amount || "0") || 0) + surchargeNum;
  const expenseAccounts = accounts.filter(a => ["EXPENSE", "OTHER_EXPENSE", "COGS"].includes(a.type) && a.active !== false);

  return (
    <div className="px-4 py-3 bg-green-50/70 border-t border-green-100 space-y-2.5">
      <p className="text-[11px] font-bold text-green-800">Record payment — balance {fmt(invoice.balance)}</p>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Amount *</label>
          <input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold" />
          {partial && <p className="text-[10px] text-amber-600 mt-0.5">Partial — {fmt(invoice.balance - parseFloat(amount || "0"))} will remain owed</p>}
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Method</label>
          <select value={method} onChange={e => setMethod(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            <option value="">Select…</option>
            <option>ACH / Bank Transfer</option>
            <option>Check</option>
            <option>Card</option>
            <option>Zelle</option>
            <option>Cash</option>
            <option>Other</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-[10px] text-gray-500 mb-0.5">Transaction ID / Confirmation #</label>
        <input value={refId} onChange={e => setRefId(e.target.value)} placeholder="e.g. ACH-8842019 or check #1044" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <div className="mb-2.5 rounded-lg border border-gray-200 bg-white p-2.5 space-y-2">
          <p className="text-[10px] font-bold text-gray-700">
            Card processing fee (optional)
            <span className="font-normal text-gray-500"> — booked as an expense, does not change what the vendor is owed</span>
          </p>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-[10px] text-gray-500 mb-0.5">Fee amount</label>
              <input type="number" step="0.01" min="0" value={surcharge} onChange={e => setSurcharge(e.target.value)}
                placeholder="0.00" className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-0.5">or calculate at %</label>
              <div className="flex gap-1">
                <input type="number" step="0.01" min="0" value={surchargeRate} onChange={e => setSurchargeRate(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                <button
                  onClick={() => {
                    const base = parseFloat(amount || "0") || 0;
                    const rate = parseFloat(surchargeRate || "0") || 0;
                    setSurcharge((Math.round(base * (rate / 100) * 100) / 100).toFixed(2));
                  }}
                  className="px-2 bg-gray-900 text-white text-[11px] font-bold rounded-lg whitespace-nowrap">Calc</button>
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-0.5">Expense account</label>
              <select value={surchargeAccountId} onChange={e => setSurchargeAccountId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm bg-white">
                <option value="">Uncategorized</option>
                {expenseAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          </div>
          {surchargeNum > 0 && (
            <p className="text-[11px] text-gray-600">
              Vendor receives <span className="font-bold">{fmt(parseFloat(amount || "0") || 0)}</span> ·
              fee <span className="font-bold">{fmt(surchargeNum)}</span> ·
              total out of the bank <span className="font-bold">{fmt(cashOut)}</span>
            </p>
          )}
        </div>
        <label className="block text-[10px] text-gray-500 mb-0.5">Receipt / confirmation screenshot (photo or PDF)</label>
        <input type="file" accept="image/*,application/pdf" onChange={e => setFile(e.target.files?.[0] || null)} className="block w-full text-xs text-gray-600 file:mr-2 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-gray-900 file:text-white file:text-xs file:font-bold" />
      </div>
      <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      {err && <p className="text-xs text-red-600 font-medium">{err}</p>}
      <div className="flex gap-2">
        <button disabled={busy || !amount} onClick={save} className="px-4 py-2 bg-green-600 text-white text-xs font-bold rounded-lg hover:bg-green-700 disabled:opacity-50">{busy ? "Saving…" : "Record Payment"}</button>
        <button onClick={onCancel} className="px-4 py-2 text-xs font-semibold text-gray-500">Cancel</button>
      </div>
    </div>
  );
}

// ── Line items ────────────────────────────────────────────────────────────
//
// A supplier invoice usually covers several jobs at once. Each line carries its
// own job and cost type, and the invoice total is their sum — the invoice-level
// job is ignored entirely once lines exist, so a cost can't be counted twice.

export interface ApLine {
  description: string;
  amount: string;
  jobId: string;
  jobCostType: string;
  accountId: string;
}

const blankLine = (): ApLine => ({ description: "", amount: "", jobId: "", jobCostType: "MATERIAL", accountId: "" });

function LineItemEditor({ lines, setLines, jobs, accounts }: {
  lines: ApLine[];
  setLines: (l: ApLine[]) => void;
  jobs: any[];
  accounts: any[];
}) {
  const [jobSearch, setJobSearch] = useState("");
  const total = lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  const expenseAccounts = accounts.filter(a => ["COGS", "EXPENSE", "OTHER_EXPENSE"].includes(a.type) && a.active !== false);

  const update = (i: number, patch: Partial<ApLine>) =>
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const filteredJobs = jobs
    .filter(j => !jobSearch.trim() || (j.customerName || "").toLowerCase().includes(jobSearch.toLowerCase()))
    .slice(0, 60);

  return (
    <div className="border border-gray-300 rounded-lg p-3 bg-white space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-bold text-gray-700">Line items</p>
        <input value={jobSearch} onChange={e => setJobSearch(e.target.value)} placeholder="Filter job list…"
          className="text-[11px] rounded border border-gray-300 px-2 py-1 w-40" />
      </div>

      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-12 gap-1.5 items-start">
          <input value={l.description} onChange={e => update(i, { description: e.target.value })}
            placeholder="Description" className="col-span-4 rounded border border-gray-300 px-2 py-1.5 text-xs" />
          <input type="number" step="0.01" value={l.amount} onChange={e => update(i, { amount: e.target.value })}
            placeholder="0.00" className="col-span-2 rounded border border-gray-300 px-2 py-1.5 text-xs font-semibold" />
          <select value={l.jobId} onChange={e => update(i, { jobId: e.target.value })}
            className="col-span-3 rounded border border-gray-300 px-2 py-1.5 text-xs bg-white">
            <option value="">No job</option>
            {filteredJobs.map(j => <option key={j.id} value={j.id}>{j.customerName}</option>)}
          </select>
          <select value={l.jobCostType} onChange={e => update(i, { jobCostType: e.target.value })}
            disabled={!l.jobId}
            className="col-span-2 rounded border border-gray-300 px-2 py-1.5 text-xs bg-white disabled:opacity-40">
            <option value="MATERIAL">Material</option>
            <option value="LABOR">Labor</option>
            <option value="OVERHEAD">Overhead</option>
            <option value="OTHER">Other</option>
          </select>
          <button onClick={() => setLines(lines.filter((_, idx) => idx !== i))}
            className="col-span-1 text-red-500 hover:text-red-700 text-sm py-1" title="Remove line">×</button>
          <select value={l.accountId} onChange={e => update(i, { accountId: e.target.value })}
            className="col-span-11 rounded border border-gray-200 px-2 py-1 text-[11px] bg-white text-gray-600">
            <option value="">Expense account — same as invoice</option>
            {expenseAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      ))}

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-gray-100">
        <button onClick={() => setLines([...lines, blankLine()])}
          className="px-2.5 py-1 bg-gray-900 text-white text-[11px] font-bold rounded">+ Add line item</button>
        <span className="text-xs font-bold text-gray-900">Total {fmt(total)}</span>
      </div>
    </div>
  );
}

// ── New invoice form ──────────────────────────────────────────────────────
function InvoiceForm({ vendors, accounts, jobs, onDone, onCancel }: { vendors: any[]; accounts: any[]; jobs: any[]; onDone: () => void; onCancel: () => void }) {
  const [vendorId, setVendorId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [jobId, setJobId] = useState("");
  const [jobSearch, setJobSearch] = useState("");
  const [jobCostType, setJobCostType] = useState("MATERIAL");
  const [showNewVendor, setShowNewVendor] = useState(false);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [recurring, setRecurring] = useState(false);
  const [recurDay, setRecurDay] = useState("1");
  const [localVendors, setLocalVendors] = useState(vendors);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [useLines, setUseLines] = useState(false);
  const [lines, setLines] = useState<ApLine[]>([blankLine()]);

  const validLines = lines.filter(l => l.description.trim() && parseFloat(l.amount));
  const linesTotal = validLines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);

  async function save() {
    setBusy(true); setErr("");
    try {
      await createApInvoice({
        vendorId,
        description,
        // With line items the header amount is ignored — the lines are the invoice.
        amount: useLines ? linesTotal : parseFloat(amount),
        invoiceNumber,
        dueDate: dueDate || undefined,
        recurrenceDay: recurring ? parseInt(recurDay) : undefined,
        accountId: accountId || undefined,
        jobId: useLines ? undefined : jobId || undefined,
        jobCostType: !useLines && jobId ? jobCostType : undefined,
        lineItems: useLines
          ? validLines.map(l => ({
              description: l.description,
              amount: parseFloat(l.amount),
              jobId: l.jobId || undefined,
              jobCostType: l.jobId ? l.jobCostType : undefined,
              accountId: l.accountId || undefined,
            }))
          : undefined,
      });
      onDone();
    } catch (e: any) { setErr(e.message || "Failed"); setBusy(false); }
  }

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-2.5">
      <p className="text-xs font-bold text-gray-700">New invoice</p>
      <div className="flex gap-2 items-center">
        <select value={vendorId} onChange={e => { setVendorId(e.target.value); const v = localVendors.find(x => x.id === e.target.value); if (v?.defaultAccountId) setAccountId(v.defaultAccountId); }} className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
          <option value="">Select vendor… *</option>
          {localVendors.filter(v => v.active !== false).map(v => <option key={v.id} value={v.id}>{v.name} ({CAT_LABEL[v.category] || v.category})</option>)}
        </select>
        <button onClick={() => setShowNewVendor(!showNewVendor)} className="px-3 py-2 text-xs font-bold text-blue-600 whitespace-nowrap">+ New Vendor</button>
      </div>
      {showNewVendor && (
        <VendorForm
          onSaved={(v) => { if (v) { setLocalVendors([...localVendors, v]); setVendorId(v.id); } setShowNewVendor(false); }}
          onCancel={() => setShowNewVendor(false)}
        />
      )}
      <input value={description} onChange={e => setDescription(e.target.value)} placeholder="What is this invoice for? *" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <div>
        <label className="block text-[10px] text-gray-500 mb-0.5">Expense account (for P&amp;L)</label>
        <select value={accountId} onChange={e => setAccountId(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
          <option value="">Uncategorized overhead</option>
          {accounts.filter(a => ["COGS", "EXPENSE", "OTHER_EXPENSE"].includes(a.type) && a.active !== false).map(a => <option key={a.id} value={a.id}>{a.name} ({a.type === "COGS" ? "COGS" : "Expense"})</option>)}
        </select>
      </div>
      <label className="flex items-center gap-2 cursor-pointer py-1">
        <input type="checkbox" checked={useLines} onChange={e => setUseLines(e.target.checked)} />
        <span className="text-xs font-semibold text-gray-700">Split into line items</span>
        <span className="text-[11px] text-gray-500">— for one invoice covering several jobs</span>
      </label>

      {useLines && <LineItemEditor lines={lines} setLines={setLines} jobs={jobs} accounts={accounts} />}

      {!useLines && (
      <div>
        <label className="block text-[10px] text-gray-500 mb-0.5">Link to a job (optional — shows as a cost on the job profile)</label>
        <input value={jobSearch} onChange={e => setJobSearch(e.target.value)} placeholder="Type to search jobs…" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-1.5" />
        <div className="flex gap-2 items-center">
          <select value={jobId} onChange={e => setJobId(e.target.value)} className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            <option value="">No job</option>
            {jobs.filter(j => !jobSearch.trim() || (j.customerName || "").toLowerCase().includes(jobSearch.toLowerCase())).slice(0, 40).map(j => (
              <option key={j.id} value={j.id}>{j.customerName}</option>
            ))}
          </select>
          {jobId && (
            <select value={jobCostType} onChange={e => setJobCostType(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
              <option value="MATERIAL">Material</option>
              <option value="LABOR">Labor</option>
              <option value="OVERHEAD">Overhead</option>
              <option value="OTHER">Other</option>
            </select>
          )}
        </div>
      </div>
      )}
      <div className="grid grid-cols-3 gap-2.5">
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Amount {useLines ? "(from lines)" : "*"}</label>
          <input type="number" step="0.01" min="0" value={useLines ? linesTotal.toFixed(2) : amount} disabled={useLines}
            onChange={e => setAmount(e.target.value)} placeholder="0.00"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold disabled:bg-gray-100 disabled:text-gray-600" />
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Invoice #</label>
          <input value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} placeholder="Optional" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Due date</label>
          <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={recurring} onChange={e => setRecurring(e.target.checked)} />
        <span className="text-xs text-gray-700">Recurring monthly</span>
        {recurring && (
          <span className="flex items-center gap-1.5 text-xs text-gray-700">
            on day
            <input type="number" min="1" max="31" value={recurDay} onChange={e => setRecurDay(e.target.value)} className="w-14 rounded-lg border border-gray-300 px-2 py-1 text-xs" />
            (next month&apos;s copy is created automatically when this one is paid in full)
          </span>
        )}
      </label>
      {err && <p className="text-xs text-red-600 font-medium">{err}</p>}
      <div className="flex gap-2">
        <button disabled={busy || !vendorId || !description.trim() || (useLines ? validLines.length === 0 : !amount)} onClick={save} className="px-4 py-2 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 disabled:opacity-50">Add Invoice</button>
        <button onClick={onCancel} className="px-4 py-2 text-xs font-semibold text-gray-500">Cancel</button>
      </div>
    </div>
  );
}

// ── Edit an existing invoice ──────────────────────────────────────────────
//
// Amounts and line items can both change after the fact. The one thing the
// server refuses is dropping an invoice below what's already been paid on it.

function EditInvoiceForm({ invoice, accounts, jobs, onDone, onCancel }: {
  invoice: any; accounts: any[]; jobs: any[]; onDone: () => void; onCancel: () => void;
}) {
  const existing: ApLine[] = (invoice.lineItems ?? []).map((li: any) => ({
    description: li.description ?? "",
    amount: String(li.amount ?? ""),
    jobId: li.jobId ?? "",
    jobCostType: li.jobCostType ?? "MATERIAL",
    accountId: li.accountId ?? "",
  }));

  const [description, setDescription] = useState(invoice.description ?? "");
  const [invoiceNumber, setInvoiceNumber] = useState(invoice.invoiceNumber ?? "");
  const [dueDate, setDueDate] = useState(invoice.dueDate ? String(invoice.dueDate).split("T")[0] : "");
  const [amount, setAmount] = useState(String(invoice.amount ?? ""));
  const [useLines, setUseLines] = useState(existing.length > 0);
  const [lines, setLines] = useState<ApLine[]>(existing.length ? existing : [blankLine()]);
  const [jobId, setJobId] = useState(invoice.jobId ?? "");
  const [jobCostType, setJobCostType] = useState(invoice.jobCostType ?? "MATERIAL");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const validLines = lines.filter(l => l.description.trim() && parseFloat(l.amount));
  const linesTotal = validLines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  const paid = Number(invoice.paid ?? 0);
  const newTotal = useLines ? linesTotal : parseFloat(amount || "0") || 0;
  const belowPaid = newTotal < paid - 0.009;

  async function save() {
    setBusy(true); setErr("");
    try {
      await editApInvoice(invoice.id, {
        description,
        invoiceNumber,
        dueDate: dueDate || undefined,
        amount: useLines ? undefined : parseFloat(amount),
        jobId: useLines ? undefined : jobId || null,
        jobCostType: useLines ? undefined : jobId ? jobCostType : null,
        lineItems: useLines
          ? validLines.map(l => ({
              description: l.description,
              amount: parseFloat(l.amount),
              jobId: l.jobId || undefined,
              jobCostType: l.jobId ? l.jobCostType : undefined,
              accountId: l.accountId || undefined,
            }))
          : [],
      });
      onDone();
    } catch (e: any) { setErr(e.message || "Failed"); setBusy(false); }
  }

  return (
    <div className="px-4 py-3 bg-blue-50/60 border-t border-blue-100 space-y-2.5">
      <p className="text-[11px] font-bold text-blue-800">
        Edit invoice{paid > 0 ? ` — ${fmt(paid)} already paid` : ""}
      </p>

      <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description"
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />

      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={useLines} onChange={e => setUseLines(e.target.checked)} />
        <span className="text-xs font-semibold text-gray-700">Split into line items</span>
      </label>

      {useLines ? (
        <LineItemEditor lines={lines} setLines={setLines} jobs={jobs} accounts={accounts} />
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Job</label>
            <select value={jobId} onChange={e => setJobId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
              <option value="">No job</option>
              {jobs.slice(0, 200).map((j: any) => <option key={j.id} value={j.id}>{j.customerName}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Cost type</label>
            <select value={jobCostType} onChange={e => setJobCostType(e.target.value)} disabled={!jobId}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white disabled:opacity-40">
              <option value="MATERIAL">Material</option>
              <option value="LABOR">Labor</option>
              <option value="OVERHEAD">Overhead</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2.5">
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Amount {useLines ? "(from lines)" : ""}</label>
          <input type="number" step="0.01" value={useLines ? linesTotal.toFixed(2) : amount} disabled={useLines}
            onChange={e => setAmount(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold disabled:bg-gray-100 disabled:text-gray-600" />
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Invoice #</label>
          <input value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Due date</label>
          <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
      </div>

      {belowPaid && (
        <p className="text-[11px] text-amber-700 font-medium">
          {fmt(newTotal)} is below the {fmt(paid)} already paid on this invoice — the server will reject it.
        </p>
      )}
      {err && <p className="text-xs text-red-600 font-medium">{err}</p>}

      <div className="flex gap-2">
        <button disabled={busy || belowPaid || (useLines && validLines.length === 0)} onClick={save}
          className="px-4 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50">
          Save changes
        </button>
        <button onClick={onCancel} className="px-4 py-2 text-xs font-semibold text-gray-500">Cancel</button>
      </div>
    </div>
  );
}

// ── Chart of Accounts tab ─────────────────────────────────────────────────
const TYPE_GROUPS: [string, string[]][] = [
  ["Income", ["INCOME"]],
  ["Cost of Goods Sold", ["COGS"]],
  ["Expenses", ["EXPENSE", "OTHER_EXPENSE"]],
  ["Bank & Assets", ["BANK", "ASSET", "OTHER_CURRENT_ASSET", "FIXED_ASSET"]],
  ["Liabilities", ["LIABILITY", "OTHER_CURRENT_LIABILITY", "LONG_TERM_LIABILITY", "CREDIT_CARD"]],
  ["Equity", ["EQUITY"]],
];
const TYPE_LABEL: Record<string, string> = {
  INCOME: "Income", COGS: "COGS", EXPENSE: "Expense", OTHER_EXPENSE: "Other Expense",
  BANK: "Bank", ASSET: "Asset", OTHER_CURRENT_ASSET: "Other Current Asset", FIXED_ASSET: "Fixed Asset",
  LIABILITY: "Liability", OTHER_CURRENT_LIABILITY: "Other Current Liability", LONG_TERM_LIABILITY: "Long Term Liability",
  CREDIT_CARD: "Credit Card", EQUITY: "Equity",
};

function AccountsTab({ accounts }: { accounts: any[] }) {
  const router = useRouter();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("EXPENSE");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState("");
  const [entriesFor, setEntriesFor] = useState<string | null>(null);
  const [entries, setEntries] = useState<any[]>([]);
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [entryAmt, setEntryAmt] = useState("");
  const [entryDir, setEntryDir] = useState("INCREASE");
  const [entryMemo, setEntryMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function run(fn: () => Promise<any>) {
    setBusy(true); setErr("");
    try { await fn(); router.refresh(); } catch (e: any) { setErr(e.message || "Failed"); } finally { setBusy(false); }
  }

  async function openEntries(id: string) {
    if (entriesFor === id) { setEntriesFor(null); return; }
    setEntriesFor(id);
    try { setEntries(await getAccountEntries(id)); } catch { setEntries([]); }
  }

  async function addEntry(accountId: string) {
    setBusy(true); setErr("");
    try {
      await createAccountEntry({ accountId, date: entryDate, amount: parseFloat(entryAmt), direction: entryDir, memo: entryMemo });
      setEntryAmt(""); setEntryMemo("");
      setEntries(await getAccountEntries(accountId));
      router.refresh();
    } catch (e: any) { setErr(e.message || "Failed"); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">Rename anything, add your own accounts, and record balances (loans, equipment, owner draws) with entries.</p>
        <button onClick={() => setShowNew(!showNew)} className="px-4 py-2 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 shrink-0">+ New Account</button>
      </div>
      {showNew && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 flex gap-2 items-end flex-wrap">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[10px] text-gray-500 mb-0.5">Account name</label>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Fuel, Truck Loan, Marketing" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Account type</label>
            <select value={newType} onChange={e => setNewType(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
              {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <button disabled={busy || !newName.trim()} onClick={() => run(async () => { await createAccount({ name: newName, type: newType }); setNewName(""); setShowNew(false); })}
            className="px-4 py-2 bg-gray-900 text-white text-xs font-bold rounded-lg disabled:opacity-50">Add</button>
        </div>
      )}
      {err && <p className="text-xs text-red-600 font-medium">{err}</p>}

      {TYPE_GROUPS.map(([group, types]) => {
        const rows = accounts.filter(a => types.includes(a.type));
        if (rows.length === 0) return null;
        return (
          <div key={group} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <p className="px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-gray-400 bg-gray-50">{group}</p>
            {rows.map(a => (
              <div key={a.id} className="border-t border-gray-100">
                <div className="px-4 py-2.5 flex items-center justify-between gap-2">
                  {editingId === a.id ? (
                    <div className="flex gap-2 items-center flex-1 flex-wrap">
                      <input value={editName} onChange={e => setEditName(e.target.value)} className="flex-1 min-w-[160px] rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                      {!a.systemKey && (
                        <select value={editType} onChange={e => setEditType(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs bg-white">
                          {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      )}
                      <button disabled={busy} onClick={() => run(async () => { await updateAccount(a.id, { name: editName, ...(a.systemKey ? {} : { type: editType }) }); setEditingId(null); })}
                        className="px-3 py-1.5 bg-gray-900 text-white text-[11px] font-bold rounded-lg">Save</button>
                      <button onClick={() => setEditingId(null)} className="text-[11px] text-gray-500">Cancel</button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 min-w-0">
                        <p className={`text-sm font-semibold truncate ${a.active === false ? "text-gray-400 line-through" : "text-gray-900"}`}>{a.name}</p>
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{TYPE_LABEL[a.type] || a.type}</span>
                        {a.systemKey && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600" title="Used automatically by reports">auto</span>}
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button onClick={() => openEntries(a.id)} className="text-[11px] font-semibold text-gray-600 hover:underline">Entries</button>
                        <button onClick={() => { setEditingId(a.id); setEditName(a.name); setEditType(a.type); }} className="text-[11px] font-semibold text-blue-600 hover:underline">Edit</button>
                        {!a.systemKey && (
                          a.active === false
                            ? <button disabled={busy} onClick={() => run(() => updateAccount(a.id, { active: true }))} className="text-[11px] font-semibold text-green-600 hover:underline">Reactivate</button>
                            : <button disabled={busy} onClick={() => run(async () => { try { await deleteAccount(a.id); } catch { await updateAccount(a.id, { active: false }); } })} className="text-[11px] font-semibold text-red-500 hover:underline">Remove</button>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {entriesFor === a.id && (
                  <div className="px-4 pb-3 bg-gray-50/60 border-t border-gray-100">
                    <div className="flex gap-2 items-end flex-wrap pt-2.5">
                      <div><label className="block text-[10px] text-gray-500 mb-0.5">Date</label>
                        <input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs" /></div>
                      <div><label className="block text-[10px] text-gray-500 mb-0.5">Amount</label>
                        <input type="number" step="0.01" value={entryAmt} onChange={e => setEntryAmt(e.target.value)} placeholder="0.00" className="w-24 rounded-lg border border-gray-300 px-2 py-1.5 text-xs" /></div>
                      <div><label className="block text-[10px] text-gray-500 mb-0.5">Direction</label>
                        <select value={entryDir} onChange={e => setEntryDir(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs bg-white">
                          <option value="INCREASE">Increase</option>
                          <option value="DECREASE">Decrease</option>
                        </select></div>
                      <input value={entryMemo} onChange={e => setEntryMemo(e.target.value)} placeholder="Memo" className="flex-1 min-w-[120px] rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
                      <button disabled={busy || !entryAmt} onClick={() => addEntry(a.id)} className="px-3 py-1.5 bg-gray-900 text-white text-[11px] font-bold rounded-lg disabled:opacity-50">Record</button>
                    </div>
                    {entries.length > 0 && entries.map(e => (
                      <div key={e.id} className="flex items-center justify-between text-[11px] text-gray-600 pt-1.5">
                        <span>{fmtDate(e.date)} · {e.direction === "DECREASE" ? "−" : "+"}{fmt(e.amount)}{e.memo ? ` · ${e.memo}` : ""}</span>
                        <button onClick={async () => { await deleteAccountEntry(e.id); setEntries(await getAccountEntries(a.id)); router.refresh(); }} className="text-red-400 hover:text-red-600">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── Reports tab: P&L + Balance Sheet ──────────────────────────────────────
function firstOfMonth(d = new Date()) { return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

function ReportsTab() {
  const [report, setReport] = useState<"pl" | "bs">("pl");
  const [start, setStart] = useState(firstOfMonth());
  const [end, setEnd] = useState(todayISO());
  const [asOf, setAsOf] = useState(todayISO());
  const [pl, setPl] = useState<any>(null);
  const [bs, setBs] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function preset(name: string) {
    const now = new Date();
    if (name === "month") { setStart(firstOfMonth()); setEnd(todayISO()); }
    if (name === "lastmonth") {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      setStart(s.toISOString().slice(0, 10)); setEnd(e.toISOString().slice(0, 10));
    }
    if (name === "quarter") { const q = Math.floor(now.getMonth() / 3); setStart(new Date(now.getFullYear(), q * 3, 1).toISOString().slice(0, 10)); setEnd(todayISO()); }
    if (name === "ytd") { setStart(`${now.getFullYear()}-01-01`); setEnd(todayISO()); }
  }

  async function runReport() {
    setBusy(true); setErr("");
    try {
      if (report === "pl") setPl(await getProfitAndLoss(start, end));
      else setBs(await getBalanceSheet(asOf));
    } catch (e: any) { setErr(e.message || "Report failed"); } finally { setBusy(false); }
  }

  const Row = ({ name, amount, bold = false, indent = true, negative = false }: any) => (
    <div className={`flex justify-between py-1 ${bold ? "font-extrabold text-gray-900 border-t border-gray-200 mt-1 pt-1.5" : "text-gray-700"} ${indent && !bold ? "pl-4" : ""}`}>
      <span className="text-sm">{name}</span>
      <span className={`text-sm tabular-nums ${negative && amount > 0 ? "text-red-600" : ""}`}>{amount < 0 ? `(${fmt(Math.abs(amount))})` : fmt(amount)}</span>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button onClick={() => setReport("pl")} className={`px-4 py-2 text-xs font-bold rounded-lg ${report === "pl" ? "bg-gray-900 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>Profit &amp; Loss</button>
        <button onClick={() => setReport("bs")} className={`px-4 py-2 text-xs font-bold rounded-lg ${report === "bs" ? "bg-gray-900 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>Balance Sheet</button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4 flex gap-2 items-end flex-wrap">
        {report === "pl" ? (
          <>
            <div className="flex gap-1.5">
              {[["month", "This Month"], ["lastmonth", "Last Month"], ["quarter", "This Quarter"], ["ytd", "YTD"]].map(([k, l]) => (
                <button key={k} onClick={() => preset(k)} className="px-2.5 py-1.5 bg-gray-100 text-gray-600 text-[11px] font-bold rounded-lg hover:bg-gray-200">{l}</button>
              ))}
            </div>
            <div><label className="block text-[10px] text-gray-500 mb-0.5">From</label>
              <input type="date" value={start} onChange={e => setStart(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs" /></div>
            <div><label className="block text-[10px] text-gray-500 mb-0.5">To</label>
              <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs" /></div>
          </>
        ) : (
          <div><label className="block text-[10px] text-gray-500 mb-0.5">As of</label>
            <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs" /></div>
        )}
        <button disabled={busy} onClick={runReport} className="px-4 py-2 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 disabled:opacity-50">{busy ? "Running…" : "Run Report"}</button>
        {(report === "pl" ? pl : bs) && <button onClick={() => window.print()} className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-xs font-bold rounded-lg">Print</button>}
      </div>
      {err && <p className="text-xs text-red-600 font-medium">{err}</p>}

      {report === "pl" && pl && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 max-w-xl">
          <p className="text-center font-extrabold text-gray-900">Lightfoot Roofing Inc, DBA Lightfoot Roofs</p>
          <p className="text-center text-sm font-bold text-gray-700">Profit &amp; Loss</p>
          <p className="text-center text-xs text-gray-500 mb-4">{fmtDate(pl.period.start)} — {fmtDate(pl.period.end)} · Cash basis</p>
          <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Income</p>
          {pl.income.map((l: any) => <Row key={l.accountId} name={l.name} amount={l.amount} />)}
          <Row name="Total Income" amount={pl.totalIncome} bold />
          {pl.cogs.length > 0 && <>
            <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mt-4">Cost of Goods Sold</p>
            {pl.cogs.map((l: any) => <Row key={l.accountId} name={l.name} amount={l.amount} />)}
            <Row name="Total COGS" amount={pl.totalCogs} bold />
          </>}
          <Row name="Gross Profit" amount={pl.grossProfit} bold indent={false} />
          {(pl.expenses.length > 0 || pl.otherExpenses.length > 0) && <>
            <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mt-4">Expenses</p>
            {[...pl.expenses, ...pl.otherExpenses].map((l: any) => <Row key={l.accountId} name={l.name} amount={l.amount} />)}
            <Row name="Total Expenses" amount={pl.totalExpenses} bold />
          </>}
          <div className={`mt-4 rounded-lg px-3 ${pl.netIncome >= 0 ? "bg-green-50" : "bg-red-50"}`}>
            <Row name="Net Income" amount={pl.netIncome} bold indent={false} />
          </div>
          <p className="text-[10px] text-gray-400 mt-3">Income = customer payments received. Payroll = paystubs paid (net). Commissions here = paid reimbursement/bonus invoices only — job commissions &amp; draws are inside paystubs.</p>
        </div>
      )}

      {report === "bs" && bs && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 max-w-xl">
          <p className="text-center font-extrabold text-gray-900">Lightfoot Roofing Inc, DBA Lightfoot Roofs</p>
          <p className="text-center text-sm font-bold text-gray-700">Balance Sheet</p>
          <p className="text-center text-xs text-gray-500 mb-4">As of {fmtDate(bs.asOf)} · Cash basis</p>
          <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Assets</p>
          {bs.assets.length === 0 && <p className="pl-4 py-1 text-sm text-gray-400">No asset balances recorded yet</p>}
          {bs.assets.map((l: any, i: number) => <Row key={i} name={l.name} amount={l.amount} />)}
          <Row name="Total Assets" amount={bs.totalAssets} bold />
          <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mt-4">Liabilities</p>
          {bs.liabilities.map((l: any, i: number) => <Row key={i} name={l.name} amount={l.amount} />)}
          <Row name="Total Liabilities" amount={bs.totalLiabilities} bold />
          <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mt-4">Equity</p>
          {bs.equity.map((l: any, i: number) => <Row key={i} name={l.name} amount={l.amount} />)}
          <Row name="Total Equity" amount={bs.totalEquity} bold />
          <div className="mt-4 border-t-2 border-gray-300 pt-2">
            <Row name="Liabilities + Equity" amount={bs.totalLiabilities + bs.totalEquity} bold indent={false} />
          </div>
          {Math.abs(bs.difference) >= 0.01 && (
            <p className="text-[10px] text-amber-600 mt-2">Assets are {bs.difference > 0 ? "over" : "under"} liabilities + equity by {fmt(Math.abs(bs.difference))} — usually a bank balance, loan, or equity entry that hasn't been recorded in the Accounts tab yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function AccountingClient({ invoices, vendors, accounts, jobs, timesheets, activeClockIns, draftEntries, users, allPaystubs }: {
  invoices: any[]; vendors: any[]; accounts: any[]; jobs: any[]; timesheets: any[]; activeClockIns: any[]; draftEntries: any[]; users: any[]; allPaystubs: any[];
}) {
  const [tab, setTab] = useState<Tab>("payables");
  const [showNewInvoice, setShowNewInvoice] = useState(false);
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null);
  const creditAccounts = useCreditAccounts();
  const [payingId, setPayingId] = useState<string | null>(null);
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [showPaidSection, setShowPaidSection] = useState(false);
  const [editingVendor, setEditingVendor] = useState<string | null>(null);
  const [showNewVendorTab, setShowNewVendorTab] = useState(false);
  const [vendorFilter, setVendorFilter] = useState<string | null>(null);
  const router = useRouter();

  const openInvoices = invoices.filter(i => i.status !== "PAID" && (!vendorFilter || i.vendorId === vendorFilter));
  const paidInvoices = invoices.filter(i => i.status === "PAID" && (!vendorFilter || i.vendorId === vendorFilter)).slice(0, 30);

  const totals = useMemo(() => {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const week = new Date(now); week.setDate(week.getDate() + 7);
    let owed = 0, overdue = 0, dueThisWeek = 0;
    for (const i of invoices) {
      if (i.status === "PAID") continue;
      owed += i.balance;
      if (i.dueDate) {
        const d = new Date(i.dueDate);
        if (d < now) overdue += i.balance;
        else if (d <= week) dueThisWeek += i.balance;
      }
    }
    return { owed, overdue, dueThisWeek };
  }, [invoices]);

  const pendingPayroll = timesheets.filter((t: any) => t.status === "PENDING").length;
  const done = () => { setShowNewInvoice(false); setPayingId(null); router.refresh(); };

  const dueBadge = (inv: any) => {
    if (!inv.dueDate) return null;
    const d = new Date(inv.dueDate); const now = new Date(); now.setHours(0,0,0,0);
    if (d < now) return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">OVERDUE</span>;
    return null;
  };

  return (
    <div className="space-y-5">
      {/* Tabs */}
      <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-xl w-full">
        {([["payables", "Payables", "🧾"], ["vendors", "Vendors", "🏢"], ["credit", "Credit", "💳"], ["accounts", "Accounts", "📒"], ["reports", "Reports", "📊"], ["payroll", "Payroll", "👥"]] as [Tab, string, string][]).map(([id, label, icon]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg transition-colors ${tab === id ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
            <span>{icon}</span><span>{label}</span>
            {id === "payables" && totals.owed > 0 && <span className="ml-1 text-[9px] font-bold text-red-600">{fmt(totals.owed)}</span>}
            {id === "payroll" && pendingPayroll > 0 && <span className="ml-1 bg-red-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{pendingPayroll}</span>}
          </button>
        ))}
      </div>

      {tab === "payables" && (
        <div className="space-y-4">
          {/* Credit lines coming due, alongside the bills */}
          <CreditPaymentSchedule onOpenCredit={() => setTab("credit")} />

          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Total Owed</p>
              <p className="text-xl font-extrabold text-gray-900 mt-0.5">{fmt(totals.owed)}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Overdue</p>
              <p className={`text-xl font-extrabold mt-0.5 ${totals.overdue > 0 ? "text-red-600" : "text-gray-900"}`}>{fmt(totals.overdue)}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Due in 7 Days</p>
              <p className="text-xl font-extrabold text-gray-900 mt-0.5">{fmt(totals.dueThisWeek)}</p>
            </div>
          </div>

          <div className="flex items-center justify-between">
            {vendorFilter ? (
              <button onClick={() => setVendorFilter(null)} className="text-xs font-semibold text-blue-600 hover:underline">
                ← All vendors (filtered: {vendors.find(v => v.id === vendorFilter)?.name})
              </button>
            ) : <span />}
            <button onClick={() => setShowNewInvoice(!showNewInvoice)} className="px-4 py-2 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700">+ New Invoice</button>
          </div>

          {showNewInvoice && <InvoiceForm vendors={vendors} accounts={accounts} jobs={jobs} onDone={done} onCancel={() => setShowNewInvoice(false)} />}

          {/* Open invoices */}
          <div className="space-y-3">
            {openInvoices.length === 0 && <p className="text-sm text-gray-400 text-center py-8 bg-white rounded-xl border border-gray-200">Nothing owed. 🎉</p>}
            {openInvoices.map(inv => (
              <div key={inv.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold text-gray-900">{inv.vendor?.name}</p>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${CAT_CHIP[inv.vendor?.category] || CAT_CHIP.OTHER}`}>{CAT_LABEL[inv.vendor?.category] || "Other"}</span>
                      {inv.account && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700">{inv.account.name}</span>}
                      {inv.job && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-700">🏠 {inv.job.customerName}{inv.jobCostType ? ` · ${inv.jobCostType.charAt(0) + inv.jobCostType.slice(1).toLowerCase()}` : ""}</span>}
                      {inv.recurrenceDay && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">↻ Monthly · day {inv.recurrenceDay}</span>}
                      {dueBadge(inv)}
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5">{inv.description}{inv.invoiceNumber ? ` · #${inv.invoiceNumber}` : ""}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">Due {fmtDate(inv.dueDate)}{inv.paidTotal > 0 ? ` · ${fmt(inv.paidTotal)} paid of ${fmt(inv.amount)}` : ""}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-base font-extrabold text-gray-900">{fmt(inv.balance)}</p>
                    <p className="text-[10px] text-gray-400">{inv.status === "PARTIAL" ? "remaining" : "owed"}</p>
                  </div>
                </div>

                {inv.paidTotal > 0 && (
                  <div className="px-4 pb-2">
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-green-500" style={{ width: `${Math.min(100, (inv.paidTotal / Number(inv.amount)) * 100)}%` }} />
                    </div>
                  </div>
                )}

                <div className="px-4 pb-3 flex gap-2 flex-wrap">
                  <button onClick={() => setPayingId(payingId === inv.id ? null : inv.id)}
                    className="px-3 py-1.5 bg-green-600 text-white text-[11px] font-bold rounded-lg hover:bg-green-700">Record Payment</button>
                  <button onClick={() => setEditingInvoiceId(editingInvoiceId === inv.id ? null : inv.id)}
                    className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-[11px] font-bold rounded-lg hover:bg-gray-50">Edit</button>
                  {inv.payments.length > 0 && (
                    <button onClick={() => setOpenHistory(openHistory === inv.id ? null : inv.id)}
                      className="px-3 py-1.5 bg-white border border-gray-300 text-gray-600 text-[11px] font-bold rounded-lg hover:bg-gray-50">{inv.payments.length} payment{inv.payments.length > 1 ? "s" : ""}</button>
                  )}
                  {inv.payments.length === 0 && (
                    <button onClick={async () => { if (confirm("Delete this invoice?")) { const { deleteApInvoice: del } = await import("@/actions/accounting"); try { await del(inv.id); router.refresh(); } catch (e: any) { alert(e.message); } } }}
                      className="px-3 py-1.5 bg-white border border-red-200 text-red-500 text-[11px] font-bold rounded-lg hover:bg-red-50">Delete</button>
                  )}
                </div>

                {payingId === inv.id && <PaymentForm invoice={inv} accounts={accounts} onDone={done} onCancel={() => setPayingId(null)} />}
                {inv.lineItems && inv.lineItems.length > 0 && (
                  <div className="px-4 py-2 border-t border-gray-100 bg-gray-50/60">
                    <table className="w-full text-[11px]">
                      <tbody>
                        {inv.lineItems.map((li: any) => (
                          <tr key={li.id} className="border-b border-gray-100 last:border-0">
                            <td className="py-1 text-gray-800">{li.description}</td>
                            <td className="py-1 text-gray-500">{li.job?.customerName ?? "—"}</td>
                            <td className="py-1 text-gray-400">{li.jobCostType ?? ""}</td>
                            <td className="py-1 text-right font-semibold text-gray-900">{fmt(Number(li.amount))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {editingInvoiceId === inv.id && (
                  <EditInvoiceForm invoice={inv} accounts={accounts} jobs={jobs}
                    onDone={() => { setEditingInvoiceId(null); done(); }}
                    onCancel={() => setEditingInvoiceId(null)} />
                )}

                {openHistory === inv.id && inv.payments.length > 0 && (
                  <div className="border-t border-gray-100 bg-gray-50/50">
                    {inv.payments.map((p: any) => (
                      <div key={p.id} className="px-4 py-2 flex items-center justify-between text-xs border-t border-gray-100 first:border-t-0">
                        <div>
                          <span className="font-semibold text-gray-800">{fmtDate(p.paidAt)}</span>
                          {p.method && <span className="text-gray-500"> · {p.method}</span>}
                          {p.referenceId && <span className="text-gray-500"> · Ref: {p.referenceId}</span>}
                          {p.receiptUrl && <a href={p.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 font-semibold hover:underline"> · Receipt ↗</a>}
                        </div>
                        <span className="font-bold text-gray-900">{fmt(p.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Paid history */}
          {paidInvoices.length > 0 && (
            <div>
              <button onClick={() => setShowPaidSection(!showPaidSection)} className="text-xs font-semibold text-gray-500 hover:text-gray-700">
                {showPaidSection ? "Hide" : "Show"} paid invoices ({paidInvoices.length})
              </button>
              {showPaidSection && (
                <div className="mt-2 space-y-1.5">
                  {paidInvoices.map(inv => (
                    <div key={inv.id} className="bg-white rounded-lg border border-gray-100 px-4 py-2 flex items-center justify-between">
                      <div className="text-xs">
                        <span className="font-semibold text-gray-700">{inv.vendor?.name}</span>
                        <span className="text-gray-400"> · {inv.description} · paid {fmtDate(inv.paidAt)}</span>
                        {inv.payments?.some((p: any) => p.receiptUrl) && (
                          <a href={inv.payments.find((p: any) => p.receiptUrl)?.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 font-semibold hover:underline"> · Receipt ↗</a>
                        )}
                      </div>
                      <span className="text-xs font-bold text-green-700">{fmt(inv.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "vendors" && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button onClick={() => setShowNewVendorTab(!showNewVendorTab)} className="px-4 py-2 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700">+ New Vendor</button>
          </div>
          {showNewVendorTab && <VendorForm accounts={accounts} onSaved={() => { setShowNewVendorTab(false); router.refresh(); }} onCancel={() => setShowNewVendorTab(false)} />}
          {vendors.length === 0 && <p className="text-sm text-gray-400 text-center py-8 bg-white rounded-xl border border-gray-200">No vendors yet — add one or create your first invoice.</p>}
          {vendors.map(v => (
            <div key={v.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold text-gray-900">{v.name}</p>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${CAT_CHIP[v.category] || CAT_CHIP.OTHER}`}>{CAT_LABEL[v.category] || "Other"}</span>
                    {v.active === false && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-500">INACTIVE</span>}
                  </div>
                  <VendorCreditAccounts vendorName={v.name} accounts={creditAccounts} />
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {v.invoiceCount} invoice{v.invoiceCount === 1 ? "" : "s"} · {fmt(v.totalPaid)} paid all-time
                    {v.phone ? ` · ${v.phone}` : ""}{v.email ? ` · ${v.email}` : ""}
                  </p>
                  {v.notes && <p className="text-[11px] text-gray-500 mt-0.5">{v.notes}</p>}
                </div>
                <div className="text-right shrink-0">
                  <p className={`text-base font-extrabold ${v.balance > 0 ? "text-red-600" : "text-gray-900"}`}>{fmt(v.balance)}</p>
                  <p className="text-[10px] text-gray-400">owed{v.openCount > 0 ? ` · ${v.openCount} open` : ""}</p>
                  <div className="flex gap-2 justify-end mt-1">
                    {v.balance > 0 && (
                      <button onClick={() => { setVendorFilter(v.id); setTab("payables"); }} className="text-[11px] font-semibold text-blue-600 hover:underline">View invoices</button>
                    )}
                    <button onClick={() => setEditingVendor(editingVendor === v.id ? null : v.id)} className="text-[11px] font-semibold text-gray-500 hover:underline">Edit</button>
                  </div>
                </div>
              </div>
              {editingVendor === v.id && (
                <div className="mt-3">
                  <VendorForm initial={v} accounts={accounts} onSaved={() => { setEditingVendor(null); router.refresh(); }} onCancel={() => setEditingVendor(null)} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "credit" && <CreditAccountsManager jobs={jobs} vendors={vendors} chartAccounts={accounts} />}
      {tab === "accounts" && <AccountsTab accounts={accounts} />}
      {tab === "reports" && <ReportsTab />}

      {tab === "payroll" && (
        <PayrollTab timesheets={timesheets} activeClockIns={activeClockIns} draftEntries={draftEntries} users={users} allPaystubs={allPaystubs} />
      )}
    </div>
  );
}

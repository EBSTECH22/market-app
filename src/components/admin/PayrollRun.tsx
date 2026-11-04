"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button, Badge, Card, Field, Input, MoneyInput, Note, Select, Skeleton,
  EmptyState, useDialog, useToast,
} from "@/components/ui";
import { money, plural, isoDate, relTime } from "@/lib/format";
import { recentPeriods, isComplete as periodDone, type PayPeriod } from "@/lib/payperiod";

/**
 * Running a week's payroll.
 *
 * ONE SCREEN, EVERY FIGURE EDITABLE. Hours come off the time clock by default
 * because that is the whole point of having a time clock — but every number on
 * every row can be typed over, because payroll is where reality and the clock
 * disagree: somebody forgot to punch out, somebody worked a shift off the
 * books, a bonus goes on, a withholding the tables don't cover has to be keyed
 * from the office's own figures. A payroll screen that can't be corrected gets
 * abandoned for a spreadsheet, and then the spreadsheet is the payroll system.
 *
 * Draft until paid. Nothing is frozen while the run is open, and paying it
 * stamps year-to-date and locks the stubs — a stub somebody has already been
 * handed has to still say the same thing next March.
 */

type Row = {
  id?: string;
  employeeId: string;
  employeeName: string;
  payType?: string;
  hourHundredths: number;
  rateCents: number;
  grossCents: number;
  ssCents: number;
  medicareCents: number;
  federalCents: number;
  stateCents: number;
  otherDedCents: number;
  netCents: number;
  manual: string[];
  missing: string[];
  deductions: { name: string; amountCents: number }[];
  hoursFromClock?: boolean;
  note?: string;
};

type RunState = {
  period: PayPeriod;
  taxYear: number;
  run: {
    id: string; status: string; payDate: string; taxYear: number;
    periodsPerYear: number; paidAt: string | null; paidBy: string; note: string;
  } | null;
  rows?: Row[];
  preview?: Row[];
  clockHundredths: Record<string, number>;
  openPunches: Record<string, number>;
  canPay?: boolean;
};

/** 825 → "8.25". Hours live as hundredths so nothing drifts. */
const hrs = (hundredths: number) => (hundredths / 100).toFixed(2);
const parseHrs = (s: string): number | null => {
  const n = Number(String(s).trim());
  if (!Number.isFinite(n) || n < 0 || n > 200) return null;
  return Math.round(n * 100);
};

export function PayrollRun({ allowed }: { allowed: boolean }) {
  const dialog = useDialog();
  const toast = useToast();

  const [from, setFrom] = useState(() => recentPeriods(isoDate(), 1)[0].from);
  const [state, setState] = useState<RunState | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  /* Which row is being edited, and the text in its boxes. Held per row rather
     than globally so typing in one person's hours can't blank another's. */
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});

  const load = useCallback(async (f: string) => {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch(`/api/admin/payrun?from=${encodeURIComponent(f)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(String(d.error || "Couldn't load that week.")); setState(null); return; }
      setState(d as RunState);
      setDraft({});
    } catch {
      setErr("Couldn't reach the server.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (allowed) void load(from); }, [allowed, from, load]);

  if (!allowed) return null;

  const rows: Row[] = state?.rows || state?.preview || [];
  const started = !!state?.run;
  const paid = state?.run?.status === "PAID";
  const totals = rows.reduce(
    (a, r) => ({
      hours: a.hours + r.hourHundredths, gross: a.gross + r.grossCents,
      withheld: a.withheld + r.ssCents + r.medicareCents + r.federalCents + r.stateCents + r.otherDedCents,
      net: a.net + r.netCents,
    }),
    { hours: 0, gross: 0, withheld: 0, net: 0 }
  );
  const unfinished = rows.filter((r) => r.missing.length > 0);

  const call = async (body: Record<string, unknown>, method: "POST" | "PATCH" = "PATCH") => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/payrun", {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("That didn't save", String(d.error || "")); return false; }
      await load(from);
      return true;
    } finally { setBusy(false); }
  };

  const saveField = async (row: Row, field: string, raw: string) => {
    if (!row.id) return;
    const blank = raw.trim() === "";
    if (field === "hourHundredths") {
      const v = blank ? null : parseHrs(raw);
      if (!blank && v === null) { toast.error("Check those hours", "Enter hours as a number, like 8.25."); return; }
      await call({ stubId: row.id, hourHundredths: v });
      return;
    }
    /* Money boxes are typed in dollars and stored in cents. Blank means "stop
       overriding it" rather than "zero" — zero is a figure somebody chose. */
    const v = blank ? null : Math.round(Number(raw.replace(/[^0-9.]/g, "")) * 100);
    if (!blank && (!Number.isFinite(v as number) || (v as number) < 0)) {
      toast.error("Check that amount", "Enter it as dollars, like 42.50.");
      return;
    }
    await call({ stubId: row.id, [field]: v });
  };

  const box = (row: Row, field: string, value: string, width = 92) => {
    const key = row.id || row.employeeId;
    const current = draft[key]?.[field];
    const isManual = row.manual.includes(
      field === "hourHundredths" ? "hours" : field.replace("Cents", "").replace("other", "other")
    );
    return (
      <Input
        value={current ?? value}
        disabled={paid || busy || !row.id}
        aria-label={`${row.employeeName} ${field}`}
        inputMode="decimal"
        style={{ width, textAlign: "right", fontVariantNumeric: "tabular-nums", ...(isManual ? { borderColor: "var(--accent)" } : {}) }}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: { ...(d[key] || {}), [field]: e.target.value } }))}
        onBlur={(e) => {
          const raw = e.target.value;
          setDraft((d) => { const c = { ...(d[key] || {}) }; delete c[field]; return { ...d, [key]: c }; });
          if (raw !== value) void saveField(row, field, raw);
        }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
    );
  };

  return (
    <Card
      className="mb-4"
      title="Payroll run"
      subtitle={
        state
          ? `${state.period.label} · ${state.period.payLabel}. Hours come off the time clock; every figure can be typed over.`
          : "Monday to Sunday, paid the following Friday."
      }
      actions={
        <Select
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="Pay period"
          style={{ maxWidth: 260 }}
        >
          {recentPeriods(isoDate(), 10).map((p) => (
            <option key={p.from} value={p.from}>
              {p.label}{periodDone(p, isoDate()) ? "" : " · still running"}
            </option>
          ))}
        </Select>
      }
    >
      <div className="stack g-4">
        {err ? <Note tone="error">{err}</Note> : null}

        {loading ? (
          <div className="stack g-2"><Skeleton height={44} /><Skeleton height={120} /></div>
        ) : !state ? null : (
          <>
            {paid ? (
              <Note tone="success" title={`Paid ${state.run?.paidAt ? relTime(state.run.paidAt) : ""}${state.run?.paidBy ? ` by ${state.run.paidBy}` : ""}`}>
                These paystubs are frozen. Reopen the run if something genuinely needs correcting — the figures
                and the year-to-date totals are recalculated when you pay it again.
              </Note>
            ) : started ? (
              <Note tone="info">
                This run is a draft. Nothing is final and nobody&rsquo;s year-to-date has moved until you mark it paid.
              </Note>
            ) : (
              <Note tone="info">
                Nothing started for this week yet — below is what a run WOULD come to, straight off the clock.
                Starting it writes the paystubs so you can correct them.
              </Note>
            )}

            {Object.keys(state.openPunches).length > 0 ? (
              <Note tone="warn" title="Somebody is still clocked in">
                An open punch counts as no hours at all until it&rsquo;s closed. Close it on the time clock, or type
                the hours in below.
              </Note>
            ) : null}

            {unfinished.length > 0 ? (
              <Note tone="warn" title={`${plural(unfinished.length, "paystub")} still need a figure`}>
                {unfinished.map((r) => r.employeeName).join(", ")} — the withholding tables for their filing status
                aren&rsquo;t loaded, so nothing has been worked out. <b>Type the amount into the box</b> and the row
                completes. The run can&rsquo;t be paid while any figure is missing, because the net on it would be
                too big by exactly that amount.
              </Note>
            ) : null}

            {rows.length === 0 ? (
              <EmptyState icon="users" title="Nobody on the roster" body="Add an employee first and set their pay rate." />
            ) : (
              <div className="table-wrap">
                <table className="table" style={{ minWidth: 980 }}>
                  <caption className="sr-only">Payroll for {state.period.label}</caption>
                  <thead>
                    <tr>
                      <th>Who</th>
                      <th className="right">Hours</th>
                      <th className="right">Rate</th>
                      <th className="right">Gross</th>
                      <th className="right">Federal</th>
                      <th className="right">Oklahoma</th>
                      <th className="right">Soc. Sec.</th>
                      <th className="right">Medicare</th>
                      <th className="right">Other</th>
                      <th className="right">Take-home</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.employeeId}>
                        <td>
                          <div className="stack g-0">
                            <b>{r.employeeName}</b>
                            <span className="row g-1 wrap">
                              {r.payType === "CONTRACTOR" ? <Badge tone="neutral">1099 — nothing withheld</Badge> : null}
                              {r.missing.length > 0 ? <Badge tone="warn">needs a figure</Badge> : null}
                              {r.hoursFromClock === false ? <Badge tone="info">hours typed in</Badge> : null}
                              {state.openPunches[r.employeeId] ? <Badge tone="warn">still clocked in</Badge> : null}
                            </span>
                            {r.deductions.length > 0 ? (
                              <span className="t-dim t-xs">
                                {r.deductions.map((d) => `${d.name} ${money(d.amountCents)}`).join(" · ")}
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="right">{box(r, "hourHundredths", hrs(r.hourHundredths), 78)}</td>
                        <td className="right">{box(r, "rateCents", (r.rateCents / 100).toFixed(2), 84)}</td>
                        <td className="right">{box(r, "grossCents", (r.grossCents / 100).toFixed(2))}</td>
                        <td className="right">
                          <div className="stack g-0" style={{ alignItems: "flex-end" }}>
                            {box(r, "federalCents", (r.federalCents / 100).toFixed(2))}
                            {r.missing.includes("federal") ? <span className="t-dim t-xs">no table</span> : null}
                          </div>
                        </td>
                        <td className="right">
                          <div className="stack g-0" style={{ alignItems: "flex-end" }}>
                            {box(r, "stateCents", (r.stateCents / 100).toFixed(2))}
                            {r.missing.includes("state") ? <span className="t-dim t-xs">no table</span> : null}
                          </div>
                        </td>
                        <td className="right">{box(r, "ssCents", (r.ssCents / 100).toFixed(2))}</td>
                        <td className="right">{box(r, "medicareCents", (r.medicareCents / 100).toFixed(2))}</td>
                        <td className="right">{box(r, "otherDedCents", (r.otherDedCents / 100).toFixed(2))}</td>
                        <td className="right"><b className="num">{money(r.netCents)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th>Totals — {plural(rows.length, "person", "people")}</th>
                      <th className="right num">{hrs(totals.hours)}</th>
                      <th />
                      <th className="right num">{money(totals.gross)}</th>
                      <th colSpan={5} className="right num">{money(totals.withheld)} withheld</th>
                      <th className="right num">{money(totals.net)}</th>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {started && !paid ? (
              <div className="stack g-2">
                <span className="t-label">Rows you&rsquo;ve changed</span>
                <div className="row wrap g-2">
                  {rows.filter((r) => r.manual.length > 0 || r.hoursFromClock === false).length === 0 ? (
                    <span className="t-dim t-sm">Nothing typed over — every figure came off the clock and the tables.</span>
                  ) : (
                    rows
                      .filter((r) => r.manual.length > 0 || r.hoursFromClock === false)
                      .map((r) => (
                        <Button
                          key={r.employeeId}
                          size="sm"
                          variant="ghost"
                          icon="refresh"
                          disabled={busy}
                          onClick={() => void call({ stubId: r.id, action: "reset" })}
                        >
                          Put {r.employeeName} back on the clock
                        </Button>
                      ))
                  )}
                </div>
              </div>
            ) : null}

            {/* ---- what happens to the run ---------------------------------- */}
            <div className="row wrap g-2" style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--sp-4)" }}>
              {!started ? (
                <Button
                  variant="primary"
                  icon="plus"
                  disabled={busy || rows.length === 0}
                  onClick={() => void call({ from }, "POST")}
                >
                  Start this run
                </Button>
              ) : paid ? (
                <>
                  <Button
                    variant="secondary"
                    icon="print"
                    onClick={() => window.open(`/admin/paystubs/${state.run?.id}`, "_blank")}
                  >
                    Print the paystubs
                  </Button>
                  <Button
                    variant="ghost"
                    icon="unlock"
                    disabled={busy}
                    onClick={async () => {
                      const yes = await dialog.confirm({
                        title: "Reopen this paid run?",
                        body: (
                          <>
                            <p>The paystubs go back to being editable and the year-to-date totals come back off.</p>
                            <p style={{ marginTop: 8 }}>
                              If you&rsquo;ve already handed these out or filed against them, reopening means the
                              copies people are holding no longer match. Only do it if the run is genuinely wrong.
                            </p>
                          </>
                        ),
                        confirmLabel: "Reopen it",
                        tone: "danger",
                      });
                      if (yes) await call({ runId: state.run?.id, action: "reopen" });
                    }}
                  >
                    Reopen
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="primary"
                    icon="check"
                    disabled={busy || unfinished.length > 0 || rows.length === 0}
                    onClick={async () => {
                      const yes = await dialog.confirm({
                        title: `Pay ${money(totals.net)} to ${plural(rows.length, "person", "people")}?`,
                        body: (
                          <>
                            <p>
                              {state.period.label}, {state.period.payLabel.toLowerCase()}. This freezes the paystubs and
                              adds this week to everybody&rsquo;s year-to-date.
                            </p>
                            <p style={{ marginTop: 8 }}>
                              It records the payroll — it doesn&rsquo;t move any money and it doesn&rsquo;t file
                              anything. Paying them and depositing the withholding are still yours to do.
                            </p>
                          </>
                        ),
                        confirmLabel: "Mark it paid",
                      });
                      if (yes) await call({ runId: state.run?.id, action: "pay" });
                    }}
                  >
                    Mark paid
                  </Button>
                  <Button
                    variant="secondary"
                    icon="print"
                    onClick={() => window.open(`/admin/paystubs/${state.run?.id}`, "_blank")}
                  >
                    Preview the paystubs
                  </Button>
                  <Button
                    variant="dangerSoft"
                    icon="trash"
                    disabled={busy}
                    onClick={async () => {
                      const yes = await dialog.confirm({
                        title: "Throw this draft away?",
                        body: "Every correction you've typed on it goes too. The time clock isn't touched.",
                        confirmLabel: "Discard the draft",
                        tone: "danger",
                      });
                      if (!yes) return;
                      setBusy(true);
                      try {
                        const r = await fetch(`/api/admin/payrun?runId=${encodeURIComponent(state.run?.id || "")}`, { method: "DELETE" });
                        if (!r.ok) { const d = await r.json().catch(() => ({})); toast.error("Couldn't discard it", String(d.error || "")); return; }
                        await load(from);
                      } finally { setBusy(false); }
                    }}
                  >
                    Discard
                  </Button>
                </>
              )}
            </div>

            <Note tone="neutral">
              Tax year <b>{state.taxYear}</b>. A box outlined in colour is one you typed rather than one worked out —
              clear it to go back to the calculation. Withholding is computed by the IRS percentage method
              (Publication 15-T, Worksheet 1A): the week is annualised, the standard-deduction amount comes off, the
              annual schedule is applied, and the result is divided back down.
            </Note>
          </>
        )}
      </div>
    </Card>
  );
}

/** Adding a shift for somebody who never clocked in. */
export function AddPunch({ employees, onAdded }: { employees: { id: string; name: string }[]; onAdded: () => void }) {
  const toast = useToast();
  const [who, setWho] = useState("");
  const [day, setDay] = useState(() => isoDate());
  const [inAt, setInAt] = useState("");
  const [outAt, setOutAt] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Card
      title="Add a shift by hand"
      subtitle="For somebody who forgot to clock in altogether — it goes on the clock like any other punch, so payroll picks it up."
    >
      <div className="row wrap g-3" style={{ alignItems: "flex-end" }}>
        <Field label="Who" className="grow">
          {(p) => (
            <Select {...p} value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Pick someone…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Day">
          {(p) => <Input {...p} type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 170 }} />}
        </Field>
        <Field label="Clocked in" hint="Market time.">
          {(p) => <Input {...p} type="time" value={inAt} onChange={(e) => setInAt(e.target.value)} style={{ width: 130 }} />}
        </Field>
        <Field label="Clocked out" hint="Leave blank to leave it open.">
          {(p) => <Input {...p} type="time" value={outAt} onChange={(e) => setOutAt(e.target.value)} style={{ width: 130 }} />}
        </Field>
        <Button
          icon="plus"
          disabled={busy || !who || !day || !inAt}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await fetch("/api/staff/time", {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ employeeId: who, day, inAt, outAt }),
              });
              const d = await r.json().catch(() => ({}));
              if (!r.ok) { toast.error("Couldn't add that shift", String(d.error || "")); return; }
              toast.success("Shift added", "It's on the clock and payroll will pick it up.");
              setInAt(""); setOutAt("");
              onAdded();
            } finally { setBusy(false); }
          }}
        >
          Add the shift
        </Button>
      </div>
    </Card>
  );
}

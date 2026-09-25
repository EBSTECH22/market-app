"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon, Button, Field, Input, Note } from "@/components/ui";
import { money } from "@/lib/format";
import {
  QUICK_BILLS_CENTS, tenderState, changeBreakdown, suggestedTenders, parseCashInput,
} from "@/lib/cash";

/**
 * Take cash, work out the change.
 *
 * Shared by the register tab and the kiosk so the two can't disagree about
 * somebody's change — the same class of split that left the applications
 * pipeline with two screens and different buttons.
 *
 * The bill buttons ADD rather than SET, because that's how the transaction
 * actually happens: a customer hands over a twenty and a five, not "twenty-five
 * dollars". Tapping $20 then $5 gives $25. "Exact" is the one-tap path for the
 * common case, so nobody pays a speed penalty for this panel existing.
 */
export function CashTender({
  totalCents,
  busy,
  onCancel,
  onConfirm,
  compact = false,
}: {
  totalCents: number;
  busy: boolean;
  /** The kiosk till: two columns, sized to fit a landscape tablet with no scrolling. */
  compact?: boolean;
  onCancel: () => void;
  /** Called with what they handed over and what goes back, both in cents. */
  onConfirm: (tenderedCents: number, changeCents: number) => void;
}) {
  const [tendered, setTendered] = useState(0);
  const [typed, setTyped] = useState("");

  const state = tenderState(totalCents, tendered);
  const parts = useMemo(() => changeBreakdown(state.changeCents), [state.changeCents]);
  const suggestions = useMemo(() => suggestedTenders(totalCents), [totalCents]);

  /* Reset when the sale total moves — a tender left over from the previous
     ticket would quietly compute change against the wrong number. */
  useEffect(() => { setTendered(0); setTyped(""); }, [totalCents]);

  const addBill = (cents: number) => {
    setTendered((t) => t + cents);
    setTyped("");
  };

  const setExactly = (cents: number) => {
    setTendered(cents);
    setTyped("");
  };

  const onTyped = (raw: string) => {
    setTyped(raw);
    const cents = parseCashInput(raw);
    // null means unparseable — leave the running total alone rather than
    // turning a half-typed "2." into a real number.
    if (cents !== null) setTendered(cents);
  };

  const confirm = () => {
    if (!state.sufficient || busy) return;
    onConfirm(tendered, state.changeCents);
  };

  if (compact) {
    return (
      <div className="ct-c">
        <style>{COMPACT_CSS}</style>
        <div className="ct-c-left">
          <span className="t-label">Tap each bill they hand you</span>
          <div className="ct-c-bills">
            {QUICK_BILLS_CENTS.map((c) => (
              <button key={c} type="button" className="ct-c-bill" disabled={busy} onClick={() => addBill(c)}>+{money(c)}</button>
            ))}
            <button type="button" className="ct-c-bill exact" disabled={busy} onClick={() => setExactly(totalCents)}>Exact</button>
          </div>
          {suggestions.filter((x) => x !== totalCents).length ? (
            <>
              <span className="t-label">Or they gave</span>
              <div className="ct-c-sugg">
                {suggestions.filter((x) => x !== totalCents).map((x) => (
                  <button key={x} type="button" className="ct-c-bill" disabled={busy} onClick={() => setExactly(x)}>{money(x)}</button>
                ))}
              </div>
            </>
          ) : null}
          <Input
            className="mono"
            inputMode="decimal"
            autoComplete="off"
            placeholder="Or type it: 20.00"
            aria-label="Amount they gave you"
            value={typed}
            style={{ height: 52, fontSize: "var(--fs-lg)" }}
            onChange={(e) => onTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirm(); }}
          />
        </div>

        <div className="ct-c-right">
          <div className="ct-c-row"><span>Due</span><b className="num">{money(totalCents)}</b></div>
          <div className="ct-c-row">
            <span>Given</span>
            <b className="num">{money(tendered)}</b>
            {tendered > 0 ? (
              <button type="button" className="ct-c-reset" disabled={busy} onClick={() => { setTendered(0); setTyped(""); }}>Reset</button>
            ) : null}
          </div>
          <div className={`ct-c-change${tendered > 0 && !state.sufficient ? " short" : ""}`}>
            {tendered === 0 ? (
              <span className="t-sm">Tap the bills, or Exact.</span>
            ) : !state.sufficient ? (
              <>
                <span className="t-label">Still short</span>
                <span className="ct-c-big num">{money(state.shortCents)}</span>
              </>
            ) : (
              <>
                <span className="t-label">Change</span>
                <span className="ct-c-big num">{money(state.changeCents)}</span>
                {state.changeCents > 0 ? (
                  <span className="ct-c-parts">
                    {parts.map((p) => (
                      <span key={p.cents} className="badge badge-neutral">
                        {p.coin ? `${p.count} ${p.count === 1 ? p.label : p.plural}` : `${p.count} × ${p.label}`}
                      </span>
                    ))}
                  </span>
                ) : null}
              </>
            )}
          </div>
          <Button variant="primary" size="xl" icon="check" block loading={busy} disabled={busy || !state.sufficient} onClick={confirm}>
            {state.changeCents > 0 ? `Book it — give ${money(state.changeCents)}` : "Book the sale"}
          </Button>
          <Button variant="ghost" size="lg" block disabled={busy} onClick={onCancel}>Back</Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="card card-pad stack g-4"
      style={{ background: "var(--accent-soft)", borderColor: "var(--accent-border)" }}
    >
      <div className="row wrap g-3" style={{ alignItems: "baseline", justifyContent: "space-between" }}>
        <div className="stack g-1">
          <span className="t-label t-accent">Total due</span>
          <span className="display num" style={{ fontSize: "var(--fs-4xl)" }}>{money(totalCents)}</span>
        </div>
        <div className="stack g-1" style={{ textAlign: "right" }}>
          <span className="t-label">Cash given</span>
          <span className="display num" style={{ fontSize: "var(--fs-3xl)" }}>{money(tendered)}</span>
        </div>
      </div>

      <div className="stack g-2">
        <span className="t-label">Tap each bill they hand you</span>
        <div className="grid-auto" style={{ ["--min" as string]: "104px" }}>
          {QUICK_BILLS_CENTS.map((c) => (
            <Button key={c} variant="secondary" size="xl" block disabled={busy} onClick={() => addBill(c)}>
              +{money(c)}
            </Button>
          ))}
        </div>
      </div>

      <div className="stack g-2">
        <span className="t-label">Or set it in one tap</span>
        <div className="row wrap g-2">
          <Button variant="primary" size="lg" disabled={busy} onClick={() => setExactly(totalCents)}>
            Exact &mdash; {money(totalCents)}
          </Button>
          {/* The exact amount is already its own button above, so skip it here
              rather than showing the same number twice in a row. */}
          {suggestions.filter((s) => s !== totalCents).map((s) => (
            <Button key={s} variant="secondary" size="lg" disabled={busy} onClick={() => setExactly(s)}>
              {money(s)}
            </Button>
          ))}
          {tendered > 0 ? (
            <Button variant="ghost" size="lg" icon="refresh" disabled={busy} onClick={() => { setTendered(0); setTyped(""); }}>
              Start over
            </Button>
          ) : null}
        </div>
      </div>

      <Field label="Or type the amount they gave you" hint="Replaces the running total above.">
        {(p) => (
          <Input
            {...p}
            className="mono"
            inputMode="decimal"
            autoComplete="off"
            placeholder="20.00"
            value={typed}
            style={{ height: 56, fontSize: "var(--fs-xl)" }}
            onChange={(e) => onTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirm(); }}
          />
        )}
      </Field>

      {/* The whole point of the panel. Big, and never shown as a negative. */}
      {tendered === 0 ? (
        <Note tone="info">Tap the bills they handed over, or hit Exact.</Note>
      ) : !state.sufficient ? (
        <div
          className="card card-pad stack g-1"
          style={{ background: "var(--danger-soft)", textAlign: "center" }}
        >
          <span className="t-label t-danger">Not enough yet &mdash; still short</span>
          <span className="display num t-danger" style={{ fontSize: "var(--fs-4xl)" }}>
            {money(state.shortCents)}
          </span>
        </div>
      ) : (
        <div className="card card-pad stack g-2" style={{ textAlign: "center" }}>
          <span className="t-label">Change to give back</span>
          <span className="display num" style={{ fontSize: "3rem", lineHeight: 1.05 }}>
            {money(state.changeCents)}
          </span>
          {state.changeCents === 0 ? (
            <span className="t-sm t-muted">Exact change &mdash; nothing to give back.</span>
          ) : (
            /* Counting change back is where money goes missing in both
               directions. "Give $13.37" is a puzzle; this is an instruction. */
            <div className="row wrap g-2" style={{ justifyContent: "center" }}>
              {parts.map((p) => (
                <span key={p.cents} className="badge badge-neutral">
                  {/* "3 × $1" for bills, "2 quarters" for coins — same rule as
                      changeBreakdownText, because "2 × quarter" reads wrong. */}
                  {p.coin ? `${p.count} ${p.count === 1 ? p.label : p.plural}` : `${p.count} × ${p.label}`}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="row wrap g-2">
        <Button
          variant="primary"
          size="xl"
          icon="check"
          className="grow"
          loading={busy}
          disabled={busy || !state.sufficient}
          onClick={confirm}
        >
          {state.changeCents > 0 ? `Book it — give ${money(state.changeCents)}` : "Book the sale"}
        </Button>
        <Button variant="ghost" size="xl" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <p className="t-xs t-muted row g-1">
        <Icon name="info" size={12} />
        What they gave and what you handed back are both saved on the ticket and printed on the receipt.
      </p>
    </div>
  );
}

const COMPACT_CSS = `
.ct-c { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 14px; }
.ct-c-left, .ct-c-right { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ct-c-bills { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.ct-c-sugg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.ct-c-bill { height: 56px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); font-size: 1.125rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.ct-c-bill:active:not(:disabled) { transform: scale(.97); background: var(--accent-soft); border-color: var(--accent); }
.ct-c-bill.exact { background: var(--accent); border-color: var(--accent); color: #fff; }
.ct-c-row { display: flex; align-items: baseline; gap: 8px; font-size: var(--fs-md); }
.ct-c-row span:first-child { color: var(--text-secondary); min-width: 52px; }
.ct-c-row b { font-size: 1.5rem; font-weight: 800; }
.ct-c-reset { margin-left: auto; border: 0; background: none; color: var(--text-secondary); text-decoration: underline; font-size: var(--fs-sm); }
.ct-c-change { flex: 1 1 auto; min-height: 96px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 10px; border-radius: 12px; background: var(--accent-soft); color: var(--accent-text); text-align: center; }
.ct-c-change.short { background: var(--danger-soft); color: var(--danger-text); }
.ct-c-big { font-size: 2.5rem; font-weight: 800; line-height: 1.05; }
.ct-c-parts { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; }
@media (max-width: 620px) { .ct-c { grid-template-columns: 1fr; } }
`;

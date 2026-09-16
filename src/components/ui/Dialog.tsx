"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Field, Input, Textarea, Select } from "./Field";
import { Icon, type IconName } from "./Icon";

/**
 * Promise-based replacements for window.confirm / window.prompt / window.alert.
 *
 * The old app ran roughly sixty native browser dialogs — including the ones that
 * collected a rent amount, a lease-notice date and a decline reason, and the one
 * that displayed a vendor's only copy of a generated password. Native dialogs
 * can't be styled, can't validate, can't show money formatting, block the whole
 * tab, and vanish without a trace. Everything here is a real modal instead:
 * labelled fields, validation, typed results, and a keyboard-accessible focus trap.
 *
 *   const dialog = useDialog();
 *   if (!(await dialog.confirm({ title: "Void ticket #4?", tone: "danger" }))) return;
 *   const amount = await dialog.money({ title: "Payout amount", ... });   // cents | null
 *   const note   = await dialog.prompt({ title: "Note", multiline: true }); // string | null
 *   await dialog.alert({ title: "Saved", body: "…" });
 */

type Tone = "default" | "danger" | "warn";

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  /** What the primary button says. Name the action: "Void ticket", not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: Tone;
  /** Require typing this exact string before the primary button enables. */
  typeToConfirm?: string;
};

export type PromptOptions = {
  title: string;
  body?: ReactNode;
  label?: string;
  hint?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  multiline?: boolean;
  required?: boolean;
  type?: "text" | "date" | "number" | "email" | "tel";
  tone?: Tone;
  /** Return an error string to block submission. */
  validate?: (value: string) => string | null;
};

export type MoneyOptions = {
  title: string;
  body?: ReactNode;
  label?: string;
  hint?: string;
  /** Prefilled amount, in cents. */
  defaultCents?: number;
  confirmLabel?: string;
  /** Allow negatives — used by ledger adjustments. */
  allowNegative?: boolean;
  tone?: Tone;
};

export type ChooseOption<T extends string> = {
  value: T;
  label: string;
  hint?: string;
};

export type ChooseOptions<T extends string> = {
  title: string;
  body?: ReactNode;
  label?: string;
  options: ChooseOption<T>[];
  defaultValue?: T;
  confirmLabel?: string;
};

export type AlertOptions = {
  title: string;
  body?: ReactNode;
  tone?: Tone | "success";
  /** Shown in a monospace block with a copy button — receipts, passwords, links. */
  copyable?: string;
  confirmLabel?: string;
};

type Resolver = (value: unknown) => void;

type State =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: Resolver }
  | { kind: "prompt"; opts: PromptOptions; resolve: Resolver }
  | { kind: "money"; opts: MoneyOptions; resolve: Resolver }
  | { kind: "choose"; opts: ChooseOptions<string>; resolve: Resolver }
  | { kind: "alert"; opts: AlertOptions; resolve: Resolver }
  | null;

type DialogApi = {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  prompt: (o: PromptOptions) => Promise<string | null>;
  money: (o: MoneyOptions) => Promise<number | null>;
  choose: <T extends string>(o: ChooseOptions<T>) => Promise<T | null>;
  alert: (o: AlertOptions) => Promise<void>;
};

const Ctx = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useDialog must be used inside <DialogProvider>");
  return api;
}

const TONE_ICON: Record<Tone | "success", IconName> = {
  default: "info", danger: "warning", warn: "warning", success: "checkCircle",
};
const TONE_COLOR: Record<Tone | "success", string> = {
  default: "var(--info)", danger: "var(--danger)", warn: "var(--warn)", success: "var(--accent)",
};

function centsToInput(c?: number) {
  if (c == null) return "";
  return (c / 100).toFixed(2);
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null);
  const [text, setText] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const resolved = useRef(false);

  const open = useCallback((next: NonNullable<State>, initial = "") => {
    resolved.current = false;
    setText(initial);
    setConfirmText("");
    setError(null);
    setCopied(false);
    setState(next);
  }, []);

  const finish = useCallback((value: unknown) => {
    setState((s) => {
      if (s && !resolved.current) {
        resolved.current = true;
        s.resolve(value);
      }
      return null;
    });
  }, []);

  const api = useMemo<DialogApi>(() => ({
    confirm: (opts) => new Promise<boolean>((resolve) =>
      open({ kind: "confirm", opts, resolve: resolve as Resolver })),
    prompt: (opts) => new Promise<string | null>((resolve) =>
      open({ kind: "prompt", opts, resolve: resolve as Resolver }, opts.defaultValue ?? "")),
    money: (opts) => new Promise<number | null>((resolve) =>
      open({ kind: "money", opts, resolve: resolve as Resolver }, centsToInput(opts.defaultCents))),
    choose: ((opts: ChooseOptions<string>) => new Promise((resolve) =>
      open({ kind: "choose", opts, resolve: resolve as Resolver },
        opts.defaultValue ?? opts.options[0]?.value ?? ""))) as DialogApi["choose"],
    alert: (opts) => new Promise<void>((resolve) =>
      open({ kind: "alert", opts, resolve: resolve as Resolver })),
  }), [open]);

  // ---- cancel value differs per dialog kind ----
  const cancelValue = state?.kind === "confirm" ? false : state?.kind === "alert" ? undefined : null;
  const onDismiss = () => finish(cancelValue);

  const submit = () => {
    if (!state) return;
    if (state.kind === "confirm") { finish(true); return; }
    if (state.kind === "alert") { finish(undefined); return; }

    if (state.kind === "money") {
      const raw = text.trim().replace(/[$,\s]/g, "");
      if (!raw) { setError("Enter an amount."); return; }
      if (!/^-?\d*\.?\d{0,2}$/.test(raw)) { setError("Use a number like 150 or 150.00."); return; }
      const n = Number(raw);
      if (!Number.isFinite(n)) { setError("That isn't a valid amount."); return; }
      if (n < 0 && !state.opts.allowNegative) { setError("Amount can't be negative."); return; }
      if (n === 0) { setError("Amount can't be zero."); return; }
      finish(Math.round(n * 100));
      return;
    }

    if (state.kind === "choose") {
      if (!text) { setError("Pick one."); return; }
      finish(text);
      return;
    }

    // prompt
    const v = text.trim();
    if (state.opts.required && !v) { setError("This can't be empty."); return; }
    const custom = state.opts.validate?.(v);
    if (custom) { setError(custom); return; }
    finish(v);
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Couldn't copy — select the text and copy it manually.");
    }
  };

  const tone: Tone | "success" =
    state?.kind === "alert" ? (state.opts.tone ?? "default")
    : state && "tone" in state.opts ? ((state.opts as { tone?: Tone }).tone ?? "default")
    : "default";

  const confirmBlocked =
    state?.kind === "confirm" &&
    !!state.opts.typeToConfirm &&
    confirmText.trim() !== state.opts.typeToConfirm;

  const primaryLabel =
    state?.kind === "confirm" ? (state.opts.confirmLabel ?? "Confirm")
    : state?.kind === "alert" ? (state.opts.confirmLabel ?? "Got it")
    : state && "confirmLabel" in state.opts ? ((state.opts as { confirmLabel?: string }).confirmLabel ?? "Save")
    : "Save";

  return (
    <Ctx.Provider value={api}>
      {children}
      <Modal
        open={!!state}
        onClose={onDismiss}
        width="sm"
        title={
          <span className="row g-2">
            <Icon name={TONE_ICON[tone]} size={18} style={{ color: TONE_COLOR[tone], flex: "0 0 auto" }} />
            <span style={{ minWidth: 0 }}>{state?.opts.title ?? ""}</span>
          </span>
        }
        footer={
          <>
            {state?.kind !== "alert" ? (
              <Button variant="ghost" onClick={onDismiss}>
                {state?.kind === "confirm" ? (state.opts.cancelLabel ?? "Cancel") : "Cancel"}
              </Button>
            ) : null}
            <Button
              variant={tone === "danger" ? "danger" : "primary"}
              onClick={submit}
              disabled={confirmBlocked}
              data-autofocus={state?.kind === "confirm" || state?.kind === "alert" ? "" : undefined}
            >
              {primaryLabel}
            </Button>
          </>
        }
      >
        {state ? (
          <form
            onSubmit={(e) => { e.preventDefault(); submit(); }}
            className="stack g-4"
          >
            {state.opts.body ? (
              <div className="t-sm t-secondary" style={{ lineHeight: 1.6 }}>{state.opts.body}</div>
            ) : null}

            {state.kind === "alert" && state.opts.copyable ? (
              <div className="stack g-2">
                <div
                  className="mono t-sm"
                  style={{
                    background: "var(--bg-sunken)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-md)",
                    padding: "var(--sp-3)",
                    wordBreak: "break-all",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {state.opts.copyable}
                </div>
                <Button
                  size="sm"
                  icon={copied ? "check" : "copy"}
                  onClick={() => copy(state.opts.copyable!)}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            ) : null}

            {state.kind === "prompt" ? (
              <Field
                label={state.opts.label ?? "Value"}
                hint={state.opts.hint}
                error={error}
                required={state.opts.required}
              >
                {(p) =>
                  state.opts.multiline ? (
                    <Textarea
                      {...p}
                      data-autofocus=""
                      value={text}
                      placeholder={state.opts.placeholder}
                      onChange={(e) => { setText(e.target.value); setError(null); }}
                    />
                  ) : (
                    <Input
                      {...p}
                      data-autofocus=""
                      type={state.opts.type ?? "text"}
                      value={text}
                      placeholder={state.opts.placeholder}
                      onChange={(e) => { setText(e.target.value); setError(null); }}
                    />
                  )
                }
              </Field>
            ) : null}

            {state.kind === "money" ? (
              <Field
                label={state.opts.label ?? "Amount"}
                hint={state.opts.hint}
                error={error}
                required
              >
                {(p) => (
                  <span className="input-money">
                    <Input
                      {...p}
                      data-autofocus=""
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0.00"
                      value={text}
                      onChange={(e) => { setText(e.target.value); setError(null); }}
                    />
                  </span>
                )}
              </Field>
            ) : null}

            {state.kind === "choose" ? (
              <Field label={state.opts.label ?? "Choose"} error={error}>
                {(p) => (
                  <Select
                    {...p}
                    data-autofocus=""
                    value={text}
                    onChange={(e) => { setText(e.target.value); setError(null); }}
                  >
                    {state.opts.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}{o.hint ? ` — ${o.hint}` : ""}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}

            {state.kind === "confirm" && state.opts.typeToConfirm ? (
              <Field
                label={<>Type <b className="mono">{state.opts.typeToConfirm}</b> to continue</>}
                error={error}
              >
                {(p) => (
                  <Input
                    {...p}
                    data-autofocus=""
                    value={confirmText}
                    autoComplete="off"
                    onChange={(e) => setConfirmText(e.target.value)}
                  />
                )}
              </Field>
            ) : null}

            {/* Lets Enter submit inside the form without a visible second button. */}
            <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>Submit</button>
          </form>
        ) : null}
      </Modal>
    </Ctx.Provider>
  );
}

export default DialogProvider;

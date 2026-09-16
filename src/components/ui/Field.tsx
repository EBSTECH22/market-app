"use client";

import { forwardRef, useId } from "react";
import type {
  InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode,
} from "react";
import { Icon } from "./Icon";

/**
 * Every input in the app goes through <Field>, which wires up the label,
 * hint, and error message with real `for`/`id`/`aria-describedby` links.
 * The old code relied on DOM adjacency, so screen readers never announced
 * a label and errors were invisible to assistive tech.
 */

type FieldProps = {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
    "aria-required"?: boolean;
  }) => ReactNode;
  className?: string;
};

export function Field({ label, hint, error, required, children, className = "" }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`field ${className}`}>
      {label ? (
        <label className="field-label" htmlFor={id}>
          {label}
          {required ? <span className="field-req" aria-hidden>*</span> : null}
          {required ? <span className="sr-only">(required)</span> : null}
        </label>
      ) : null}
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required || undefined,
      })}
      {error ? (
        <p className="field-error" id={errId} role="alert">
          <Icon name="alert" size={13} /> {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={hintId}>{hint}</p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- inputs -- */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...rest }, ref) {
    return <input ref={ref} className={`input ${className}`} {...rest} />;
  }
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", children, ...rest }, ref) {
    return <select ref={ref} className={`select ${className}`} {...rest}>{children}</select>;
  }
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = "", ...rest }, ref) {
    return <textarea ref={ref} className={`textarea ${className}`} {...rest} />;
  }
);

/* ------------------------------------------------------------ composites -- */

/** Dollar-prefixed input. Always pass a string value; caller parses. */
export const MoneyInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function MoneyInput({ className = "", ...rest }, ref) {
    return (
      <span className="input-money">
        <input
          ref={ref}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className={`input ${className}`}
          {...rest}
        />
      </span>
    );
  }
);

/** Search box with a magnifier and a clear button. */
export function SearchInput({
  value,
  onValueChange,
  placeholder = "Search…",
  autoFocus,
  className = "",
  "aria-label": ariaLabel = "Search",
  ...rest
}: {
  value: string;
  onValueChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className">) {
  return (
    <span className={`input-group ${className}`}>
      <Icon name="search" size={16} />
      <input
        type="search"
        className="input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        autoComplete="off"
        onChange={(e) => onValueChange(e.target.value)}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          className="input-clear"
          aria-label="Clear search"
          onClick={() => onValueChange("")}
        >
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </span>
  );
}

/** Checkbox with a real label and a 40px-tall hit area. */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="check-row">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange(e.target.checked)}
      />
      <span>
        {label}
        {hint ? <span className="field-hint" style={{ display: "block" }}>{hint}</span> : null}
      </span>
    </label>
  );
}

/** Toggleable tile, e.g. the weekday pickers on the tent scheduler. */
export function ToggleTile({
  on,
  onToggle,
  children,
  disabled,
}: {
  on: boolean;
  onToggle: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="tile-check" aria-pressed={on} disabled={disabled} onClick={onToggle}>
      {on ? <Icon name="check" size={14} /> : null}
      {children}
    </button>
  );
}

/** Segmented control. Values must be unique. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default Field;

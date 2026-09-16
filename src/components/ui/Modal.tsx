"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { IconButton } from "./Button";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Traps Tab inside `ref`, restores focus to whatever was focused before, and
 * wires Escape. Used by Modal and Panel.
 *
 * This effect MUST run once per open, never on re-render. `onClose` is almost
 * always a fresh arrow function each render, so listing it as a dependency tore
 * the whole thing down and rebuilt it on every keystroke: the cleanup pulled
 * focus back to the trigger, then the setup re-focused the first element in the
 * dialog — the close button. Typing a price meant retyping one character at a
 * time. So the callback lives in a ref that stays current, and the effect keys
 * only off `open`.
 */
function useFocusTrap(ref: React.RefObject<HTMLElement>, open: boolean, onClose?: () => void) {
  const onCloseRef = useRef(onClose);
  // Assign during render so the listener never calls a stale closure, and so
  // this never itself triggers the effect below.
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;

    /* Where to land on open, in order of preference:
       1. an explicit [data-autofocus]
       2. the first form control — someone opening an edit dialog wants the
          cursor in the field, not on the close button that happens to come
          first in the DOM
       3. anything focusable, then the dialog itself */
    const auto = node.querySelector<HTMLElement>("[data-autofocus]");
    const field = node.querySelector<HTMLElement>(
      "input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled])"
    );
    const first = auto || field || node.querySelector<HTMLElement>(FOCUSABLE) || node;
    const timer = window.setTimeout(() => first.focus(), 0);

    document.body.classList.add("scroll-locked");

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const close = onCloseRef.current;
        if (!close) return;
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.classList.remove("scroll-locked");
      previous?.focus?.();
    };
    // Depends ONLY on `open`. These dialogs stay mounted while closed, so the
    // trap has to install when they open — but re-running on anything else
    // (an ever-changing onClose) is what stole focus on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

export type ModalWidth = "sm" | "md" | "lg" | "xl";
const WIDTH: Record<ModalWidth, string> = {
  sm: "400px", md: "520px", lg: "680px", xl: "880px",
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "md",
  /** Set false for a step the user must resolve with a button. */
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: ModalWidth;
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { if (dismissable) onClose(); }, [dismissable, onClose]);
  useFocusTrap(ref, open, close);

  if (!open) return null;

  return (
    <div
      className="overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        style={{ ["--modal-w" as string]: WIDTH[width] }}
      >
        <div className="modal-head">
          <div style={{ minWidth: 0 }}>
            <h2 className="modal-title">{title}</h2>
            {description ? <p className="modal-desc">{description}</p> : null}
          </div>
          {dismissable ? (
            <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
          ) : null}
        </div>
        {children != null ? <div className="modal-body">{children}</div> : null}
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Right-hand slide-over for record detail — vendor, application, contract. */
export function Panel({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open, onClose);

  if (!open) return null;

  return (
    <div className="overlay" style={{ padding: 0, alignItems: "stretch", justifyContent: "flex-end" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
      >
        <div className="panel-head">
          <div style={{ minWidth: 0 }}>
            <h2 className="t-section truncate">{title}</h2>
            {subtitle ? <p className="t-xs t-muted truncate">{subtitle}</p> : null}
          </div>
          <div className="row g-1 shrink0">
            {actions}
            <IconButton icon="close" label="Close panel" size="sm" onClick={onClose} />
          </div>
        </div>
        <div className="panel-body">{children}</div>
        {footer ? <div className="panel-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export default Modal;

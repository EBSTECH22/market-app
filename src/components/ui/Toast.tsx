"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * Non-blocking feedback. Replaces the alert() calls the old app used to report
 * that a save worked or failed — those interrupted the whole tab and were
 * indistinguishable from an error.
 *
 *   const toast = useToast();
 *   toast.success("Vendor added", "They've been emailed a temporary password.");
 *   toast.error("Couldn't save", err);
 */

type Kind = "success" | "error" | "warn" | "info";

type Toast = {
  id: number;
  kind: Kind;
  title: string;
  desc?: string;
  leaving?: boolean;
  action?: { label: string; onClick: () => void };
};

type ToastApi = {
  success: (title: string, desc?: string) => void;
  error: (title: string, desc?: string) => void;
  warn: (title: string, desc?: string) => void;
  info: (title: string, desc?: string) => void;
  show: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
};

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

const ICON: Record<Kind, IconName> = {
  success: "checkCircle", error: "alert", warn: "warning", info: "info",
};

// Errors stay up longer — the user may need to read and act on them.
const TTL: Record<Kind, number> = { success: 4000, info: 4500, warn: 7000, error: 9000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    const timer = timers.current.get(id);
    if (timer) { window.clearTimeout(timer); timers.current.delete(id); }
    window.setTimeout(() => {
      setItems((list) => list.filter((t) => t.id !== id));
    }, 200);
  }, []);

  const show = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq.current;
    setItems((list) => {
      const next = [...list, { ...t, id }];
      // Never stack more than four; drop the oldest.
      return next.length > 4 ? next.slice(next.length - 4) : next;
    });
    const timer = window.setTimeout(() => dismiss(id), TTL[t.kind]);
    timers.current.set(id, timer);
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    show,
    dismiss,
    success: (title, desc) => show({ kind: "success", title, desc }),
    error: (title, desc) => show({ kind: "error", title, desc }),
    warn: (title, desc) => show({ kind: "warn", title, desc }),
    info: (title, desc) => show({ kind: "info", title, desc }),
  }), [show, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            data-leaving={t.leaving ? "true" : undefined}
            role={t.kind === "error" ? "alert" : "status"}
            aria-live={t.kind === "error" ? "assertive" : "polite"}
          >
            <Icon name={ICON[t.kind]} size={17} className="toast-icon" />
            <div className="grow">
              <div className="toast-title">{t.title}</div>
              {t.desc ? <div className="toast-desc">{t.desc}</div> : null}
              {t.action ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost mt-2"
                  style={{ marginLeft: -8 }}
                  onClick={() => { t.action?.onClick(); dismiss(t.id); }}
                >
                  {t.action.label}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export default ToastProvider;

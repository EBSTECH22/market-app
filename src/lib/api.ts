"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A typed client for API calls: consistent error shapes, an AbortController on
 * every request, and per-action pending state.
 *
 * STATUS: this is the intended replacement for the local `safeFetch` helper in
 * `src/app/admin/page.tsx` and the bare `fetch(...).then(...)` calls in the tab
 * effects, but that migration has NOT been done — those call sites still use the
 * old helper. Nothing imports this module yet. Adopt it incrementally: new code
 * should use it, and existing `safeFetch` call sites can move over one at a time
 * (`safeFetch` returns `{ ok, status, data }`, `api` returns a discriminated
 * union, so each call site needs a small edit rather than a find-and-replace).
 *
 * The concrete bug it fixes: the tab effects fire a fetch per tab switch with no
 * abort, so switching tabs quickly can let a late response overwrite state for a
 * tab the user already left. `useResource` cancels the in-flight request.
 */

export type ApiResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status: number; data?: unknown };

const NETWORK_ERROR = "Can't reach the server. Check your connection and try again.";

function messageFor(status: number, body: unknown): string {
  const fromBody =
    body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : "";
  if (fromBody) return fromBody;
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 403) return "You don't have access to that.";
  if (status === 404) return "Not found.";
  if (status === 409) return "That conflicts with something that already exists.";
  if (status === 429) return "Too many attempts. Wait a moment and try again.";
  if (status >= 500) return "The server hit an error. Try again in a moment.";
  return "Something went wrong.";
}

export async function api<T = unknown>(
  url: string,
  init?: RequestInit & { json?: unknown }
): Promise<ApiResult<T>> {
  const { json, ...rest } = init ?? {};
  try {
    const res = await fetch(url, {
      ...rest,
      ...(json !== undefined
        ? {
            method: rest.method ?? "POST",
            headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) },
            body: JSON.stringify(json),
          }
        : {}),
    });

    let body: unknown = null;
    const text = await res.text();
    if (text) { try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; } }

    if (!res.ok) return { ok: false, error: messageFor(res.status, body), status: res.status, data: body };
    return { ok: true, data: (body ?? {}) as T, status: res.status };
  } catch (err) {
    // An aborted request isn't a failure the user should see.
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: "", status: 0 };
    }
    return { ok: false, error: NETWORK_ERROR, status: 0 };
  }
}

export const apiGet = <T,>(url: string, signal?: AbortSignal) => api<T>(url, { signal });
export const apiPost = <T,>(url: string, json: unknown) => api<T>(url, { method: "POST", json });
export const apiPatch = <T,>(url: string, json: unknown) => api<T>(url, { method: "PATCH", json });
export const apiDelete = <T,>(url: string) => api<T>(url, { method: "DELETE" });

/* ------------------------------------------------------------------ hooks -- */

export type Resource<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** True only on the very first load — use it to choose skeletons vs. stale data. */
  initial: boolean;
  reload: () => Promise<void>;
  setData: (updater: T | ((prev: T | null) => T | null)) => void;
};

/**
 * Loads a URL, keeps the previous data visible while refreshing, and cancels
 * in-flight requests when the URL changes or the component unmounts.
 */
export function useResource<T>(
  url: string | null,
  opts?: { onUnauthorized?: () => void; enabled?: boolean }
): Resource<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initial, setInitial] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const onUnauthorized = opts?.onUnauthorized;
  const enabled = opts?.enabled ?? true;

  const reload = useCallback(async () => {
    if (!url || !enabled) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    const res = await apiGet<T>(url, ctrl.signal);
    if (ctrl.signal.aborted) return;
    setLoading(false);
    setInitial(false);
    if (res.ok) {
      setDataState(res.data);
      setError(null);
    } else if (res.status === 401) {
      onUnauthorized?.();
    } else if (res.error) {
      setError(res.error);
    }
  }, [url, enabled, onUnauthorized]);

  useEffect(() => {
    void reload();
    return () => abortRef.current?.abort();
  }, [reload]);

  const setData = useCallback((updater: T | ((prev: T | null) => T | null)) => {
    setDataState((prev) =>
      typeof updater === "function" ? (updater as (p: T | null) => T | null)(prev) : updater
    );
  }, []);

  return { data, loading, error, initial, reload, setData };
}

/**
 * Wraps a mutating call so each button tracks its own pending state. The old
 * admin page shared one global `busy` boolean, so clicking any action greyed
 * out every button on the page.
 */
export function useAction<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<ApiResult<T>>
): {
  run: (...args: Args) => Promise<ApiResult<T>>;
  pending: boolean;
  error: string | null;
  clearError: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const run = useCallback(async (...args: Args) => {
    setPending(true);
    setError(null);
    try {
      const res = await fn(...args);
      if (mounted.current && !res.ok && res.error) setError(res.error);
      return res;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, [fn]);

  return { run, pending, error, clearError: () => setError(null) };
}

/** Debounces a value — for search boxes that would otherwise fire per keystroke. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Keeps the active tab in the URL hash so refresh, browser back/forward,
 * bookmarking and sharing a link all work. The old pages held the tab in plain
 * useState, so a reload always dumped you back to the first tab and there was
 * no way to send someone a link to a specific section.
 *
 * Hash rather than a query param: it needs no Suspense boundary under the
 * Next app router and never triggers a server round-trip.
 */
export function useHashTab<T extends string>(tabs: readonly T[], fallback: T): [T, (t: T) => void] {
  const isValid = useCallback(
    (v: string): v is T => (tabs as readonly string[]).includes(v),
    [tabs]
  );

  const read = useCallback((): T => {
    if (typeof window === "undefined") return fallback;
    const raw = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    return isValid(raw) ? raw : fallback;
  }, [isValid, fallback]);

  // Start on the fallback so server and first client render agree, then sync
  // to the real hash in an effect — avoids a hydration mismatch.
  const [tab, setTabState] = useState<T>(fallback);

  useEffect(() => {
    setTabState(read());
    const onHashChange = () => setTabState(read());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [read]);

  const setTab = useCallback((next: T) => {
    setTabState(next);
    if (typeof window === "undefined") return;
    const url = `${window.location.pathname}${window.location.search}#${next}`;
    // pushState so Back returns to the previous tab rather than leaving the app.
    if (decodeURIComponent(window.location.hash.replace(/^#/, "")) !== next) {
      window.history.pushState(null, "", url);
    }
  }, []);

  return [tab, setTab];
}

export default useHashTab;

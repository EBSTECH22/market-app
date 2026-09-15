"use client";

import { useEffect, useRef } from "react";

// polls the change marker every 4s (+ on focus); fires onChange the moment ANY data changed anywhere
export function usePulse(onChange: () => void) {
  const last = useRef<string>("");
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch("/api/public/pulse");
        if (!r.ok) return;
        const d = await r.json();
        if (stop) return;
        if (last.current && d.pulse !== last.current) cb.current();
        last.current = d.pulse;
      } catch {}
    };
    check();
    const t = setInterval(check, 4000);
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { stop = true; clearInterval(t); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, []);
}

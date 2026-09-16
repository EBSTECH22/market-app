"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui";

// Fullscreen photo viewer — tap the photo to zoom, drag/scroll to pan,
// the close button or the backdrop to dismiss.
export default function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--n-950)",
        zIndex: "var(--z-modal)",
        overflow: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <button
        ref={closeRef}
        type="button"
        // stopPropagation: without it the click also reaches the backdrop's
        // onClick and onClose fires twice.
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close photo"
        style={{
          position: "fixed",
          top: "calc(var(--sp-3) + env(safe-area-inset-top))",
          right: "var(--sp-3)",
          zIndex: 1,
          background: "var(--n-800)",
          color: "var(--n-0)",
          border: "1px solid var(--n-700)",
          borderRadius: "var(--r-full)",
          width: 44,
          height: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
      >
        <Icon name="close" size={20} />
      </button>

      <div
        onClick={(e) => e.stopPropagation()}
        style={zoomed
          ? { minWidth: "100%", minHeight: "100%", display: "block", padding: 0 }
          : { minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--sp-5)" }}
      >
        <button
          type="button"
          onClick={() => setZoomed((z) => !z)}
          aria-pressed={zoomed}
          aria-label={zoomed ? "Zoom out" : "Zoom in"}
          style={{
            padding: 0,
            border: "none",
            background: "none",
            display: "block",
            lineHeight: 0,
            cursor: zoomed ? "zoom-out" : "zoom-in",
            maxWidth: zoomed ? "none" : "100%",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            style={zoomed
              ? { width: "220%", maxWidth: "none", display: "block" }
              : { maxWidth: "100%", maxHeight: "92vh", display: "block", borderRadius: "var(--r-md)" }}
          />
        </button>
      </div>

      <p
        style={{
          position: "fixed",
          bottom: "calc(var(--sp-3) + env(safe-area-inset-bottom))",
          left: 0,
          right: 0,
          textAlign: "center",
          color: "var(--n-400)",
          fontSize: "var(--fs-xs)",
          margin: 0,
          pointerEvents: "none",
        }}
      >
        {zoomed ? "Tap the photo to zoom out · drag to look around" : "Tap the photo to zoom in"}
      </p>
    </div>
  );
}

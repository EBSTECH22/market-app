"use client";

import { useEffect, useState } from "react";

// Fullscreen photo viewer — tap the photo to zoom, drag/scroll to pan, ✕ or backdrop to close
export default function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.92)", zIndex: 9999, overflow: "auto", WebkitOverflowScrolling: "touch" }}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        style={{ position: "fixed", top: 14, right: 14, zIndex: 10000, background: "rgba(255,255,255,0.14)", color: "#fff", border: "none", borderRadius: 999, width: 40, height: 40, fontSize: 19, fontWeight: 700, cursor: "pointer" }}
      >✕</button>
      <div
        onClick={(e) => e.stopPropagation()}
        style={zoomed
          ? { minWidth: "100%", minHeight: "100%", display: "block", padding: 0 }
          : { minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          onClick={() => setZoomed((z) => !z)}
          style={zoomed
            ? { width: "220%", maxWidth: "none", display: "block", cursor: "zoom-out" }
            : { maxWidth: "100%", maxHeight: "92vh", display: "block", cursor: "zoom-in", borderRadius: 10 }}
        />
      </div>
      <div style={{ position: "fixed", bottom: 12, left: 0, right: 0, textAlign: "center", color: "rgba(255,255,255,0.75)", fontSize: 12, pointerEvents: "none" }}>
        {zoomed ? "Tap photo to zoom out · drag to look around" : "Tap photo to zoom in"}
      </div>
    </div>
  );
}

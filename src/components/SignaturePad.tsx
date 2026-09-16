"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Field, Input, Note } from "@/components/ui";

type Pt = { x: number; y: number };

const PAD_HEIGHT = 160;

/** Ink has to stay dark whatever the theme is — the PNG ends up on a contract. */
const inkColor = () => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--n-900").trim();
    return v || "#111827";
  } catch {
    return "#111827";
  }
};

/**
 * Draw-to-sign pad.
 *
 * The canvas used to size its backing store once, on mount, from offsetWidth.
 * Rotating a phone (or any layout change) left the backing store at the old
 * size while CSS stretched the element, so every stroke drawn afterwards landed
 * somewhere other than where the finger was — on a legally binding signature.
 * Points now live in a ref and the canvas is re-sized and repainted whenever
 * its box changes.
 */
export default function SignaturePad({ onSign, label }: { onSign: (dataUrl: string, typedName: string) => void; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const strokes = useRef<Pt[][]>([]);
  /** The CSS width the stored points are expressed in. Only ever shrinks, so a
   *  rotate-and-rotate-back never compounds a scale onto the signature. */
  const drawWidth = useRef(0);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [nameErr, setNameErr] = useState("");
  const [hasInk, setHasInk] = useState(false);

  const ctxOf = () => canvasRef.current?.getContext("2d") ?? null;

  const paint = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = c.offsetWidth || 1;

    // Re-sizing the backing store also resets the context state, so everything
    // below has to be re-applied on every repaint.
    c.width = Math.round(w * dpr);
    c.height = Math.round(PAD_HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, PAD_HEIGHT);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = inkColor();

    for (const s of strokes.current) {
      if (!s.length) continue;
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      if (s.length === 1) ctx.lineTo(s[0].x + 0.01, s[0].y); // a single tap still leaves a dot
      else for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
      ctx.stroke();
    }
  }, []);

  const resize = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const w = c.offsetWidth || 1;
    if (drawWidth.current === 0) {
      drawWidth.current = w;
    } else if (w < drawWidth.current - 0.5) {
      // Narrower box: scale the existing signature down uniformly so it still
      // fits rather than getting clipped. Aspect ratio is preserved.
      const s = w / drawWidth.current;
      for (const stroke of strokes.current) {
        for (const p of stroke) { p.x *= s; p.y *= s; }
      }
      drawWidth.current = w;
    }
    paint();
  }, [paint]);

  useEffect(() => {
    resize();
    const c = canvasRef.current;
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined" && c) {
      // Setting c.width/c.height changes the backing store, not the CSS box, so
      // this can't loop back into itself.
      ro = new ResizeObserver(() => resize());
      ro.observe(c);
    }
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
    };
  }, [resize]);

  const pos = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    drawing.current = true;
    const p = pos(e);
    strokes.current.push([p]);
    try { canvasRef.current?.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    const ctx = ctxOf();
    if (ctx) { ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  };

  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    e.preventDefault();
    const stroke = strokes.current[strokes.current.length - 1];
    if (!stroke) return;
    const p = pos(e);
    const prev = stroke[stroke.length - 1];
    stroke.push(p);
    const ctx = ctxOf();
    if (ctx && prev) {
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    if (!hasInk) setHasInk(true);
    setErr("");
  };

  const up = (e?: React.PointerEvent) => {
    drawing.current = false;
    if (e) { try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ } }
    if (strokes.current.some((s) => s.length > 0)) setHasInk(true);
  };

  const clear = () => {
    strokes.current = [];
    drawWidth.current = canvasRef.current?.offsetWidth || 0;
    setHasInk(false);
    setErr("");
    paint();
  };

  const sign = () => {
    setErr("");
    setNameErr("");
    if (name.trim().length < 3) { setNameErr("Type your full legal name first."); return; }
    if (!strokes.current.some((s) => s.length > 0)) { setErr("Sign in the box first."); return; }
    const c = canvasRef.current;
    if (!c) return;
    onSign(c.toDataURL("image/png"), name.trim());
  };

  return (
    <div className="stack g-4">
      <Field label="Type your full legal name" error={nameErr} required>
        {(p) => (
          <Input
            {...p}
            value={name}
            autoComplete="name"
            placeholder="Full name"
            onChange={(e) => { setName(e.target.value); setNameErr(""); }}
          />
        )}
      </Field>

      <div className="field">
        <span className="field-label">Sign in the box with your finger</span>
        <canvas
          ref={canvasRef}
          aria-label="Signature pad — draw your signature here"
          role="img"
          style={{
            width: "100%",
            height: PAD_HEIGHT,
            border: "1.5px dashed var(--border-strong)",
            borderRadius: "var(--r-lg)",
            background: "var(--n-0)",
            touchAction: "none",
            display: "block",
          }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={up}
        />
        <p className="field-hint">Use your finger or a stylus. You can clear and start over.</p>
      </div>

      {err && <Note tone="error">{err}</Note>}

      <div className="row g-2">
        <Button variant="primary" size="lg" className="grow" icon="edit" onClick={sign}>{label}</Button>
        <Button variant="secondary" size="lg" className="shrink0" icon="refresh" disabled={!hasInk} onClick={clear}>Clear</Button>
      </div>
    </div>
  );
}

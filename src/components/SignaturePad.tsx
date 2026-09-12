"use client";

import { useEffect, useRef, useState } from "react";

// Draw-to-sign pad (same pattern as the Lightfoot CRM)
export default function SignaturePad({ onSign, label }: { onSign: (dataUrl: string, typedName: string) => void; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    const c = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = c.offsetWidth, h = 160;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111827";
  }, []);

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    drawing.current = true;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke();
    hasInk.current = true;
  };
  const up = () => { drawing.current = false; };
  const clear = () => {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    hasInk.current = false;
  };

  return (
    <div>
      <label>Type your full legal name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
      <label>Sign in the box with your finger</label>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: 160, border: "1.5px dashed #9ca3af", borderRadius: 12, background: "#fff", touchAction: "none", display: "block" }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn" style={{ flex: 1 }} onClick={() => {
          setErr("");
          if (name.trim().length < 3) { setErr("Type your full name first."); return; }
          if (!hasInk.current) { setErr("Sign in the box first."); return; }
          onSign(canvasRef.current!.toDataURL("image/png"), name.trim());
        }}>✍️ {label}</button>
        <button className="btn small ghost" onClick={clear}>CLEAR</button>
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}

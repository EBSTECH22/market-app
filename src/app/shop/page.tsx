"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Lightbox from "@/components/Lightbox";
import { usePulse } from "@/lib/usePulse";

type Item = { id: string; sku: string; name: string; priceCents: number; quantity: number; vendorName: string; photoId?: string | null };
type Line = Item & { qty: number };

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function SelfCheckout() {
  const [items, setItems] = useState<Item[]>([]);
  const [taxRate, setTaxRate] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [cart, setCart] = useState<Line[]>([]);
  const [q, setQ] = useState("");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [scanHit, setScanHit] = useState<{ kind: "ok" | "err"; title: string; sub: string } | null>(null);
  const scannerRef = useRef<{ stop: () => Promise<void>; clear: () => void; pause: (v?: boolean) => void; resume: () => void } | null>(null);
  const holdRef = useRef(false); // true while a scanned item awaits SCAN NEXT - blocks re-reads

  useEffect(() => {
    const loadShop = () => {
      fetch("/api/public/shop").then(async (r) => {
        if (r.ok) { const d = await r.json(); setItems(d.items || []); setTaxRate(d.taxRatePercent || 0); setPaused(!!d.paused); }
        setLoaded(true);
      });
    };
    loadShop();
    (window as unknown as { __ls?: () => void }).__ls = loadShop;
    return () => { scannerRef.current?.stop().catch(() => {}); };
  }, []);
  usePulse(() => (window as unknown as { __ls?: () => void }).__ls?.());

  const addItem = useCallback((it: Item) => {
    setMsg("");
    setCart((c) => {
      const ex = c.find((l) => l.sku === it.sku);
      if (ex) {
        if (ex.qty >= it.quantity) { setMsg(`That's all ${it.quantity} of ${it.name} the system shows.`); return c; }
        return c.map((l) => (l.sku === it.sku ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...c, { ...it, qty: 1 }];
    });
    setOkMsg(`Added ${it.name} ✓`);
    setTimeout(() => setOkMsg(""), 1600);
    if (navigator.vibrate) navigator.vibrate(40);
  }, []);

  const lookupSku = useCallback(async (sku: string): Promise<{ ok: boolean; error?: string; item?: Item }> => {
    setMsg("");
    const r = await fetch("/api/public/shop", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "lookup", sku }),
    });
    const d = await r.json();
    if (!r.ok) { setMsg(d.error || "Couldn't find that one."); return { ok: false, error: d.error }; }
    addItem(d.item);
    return { ok: true, item: d.item };
  }, [addItem]);

  const startScan = async () => {
    setMsg("");
    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
      setScanning(true);
      await new Promise((r) => setTimeout(r, 80)); // let the video box render first
      const scanner = new Html5Qrcode("scan-box", {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.UPC_A,
        ],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false,
      });
      scannerRef.current = scanner as unknown as { stop: () => Promise<void>; clear: () => void; pause: (v?: boolean) => void; resume: () => void };
      holdRef.current = false;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 12, qrbox: (w: number, _h: number) => ({ width: Math.min(340, Math.floor(w * 0.92)), height: 150 }), aspectRatio: 1.4 },
        (text) => {
          if (holdRef.current) return; // one read at a time - camera freezes until SCAN NEXT
          holdRef.current = true;
          try { scanner.pause(true); } catch {}
          if (navigator.vibrate) navigator.vibrate(50);
          lookupSku(text.trim().toUpperCase()).then((res) => {
            if (res.ok && res.item) {
              setScanHit({ kind: "ok", title: "ADDED - " + res.item.name.toUpperCase(), sub: "$" + (res.item.priceCents / 100).toFixed(2) + " - it's in your cart" });
            } else {
              setScanHit({ kind: "err", title: "THAT ONE DIDN'T WORK", sub: res.error || "Try again, or type the code under the barcode." });
            }
          });
        },
        () => {}
      );
    } catch {
      setScanning(false);
      setMsg("Couldn't open the camera — allow camera access, or type the code under the barcode instead.");
    }
  };

  const stopScan = async () => {
    try { await scannerRef.current?.stop(); scannerRef.current?.clear(); } catch {}
    holdRef.current = false;
    setScanHit(null);
    setScanning(false);
  };

  const pay = async () => {
    setMsg(""); setBusy(true);
    await stopScan();
    const r = await fetch("/api/public/shop", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "checkout", lines: cart.map((l) => ({ sku: l.sku, qty: l.qty })), email }),
    });
    const d = await r.json();
    setBusy(false);
    if (!r.ok || !d.url) { setMsg(d.error || "Couldn't start payment."); return; }
    window.location.href = d.url;
  };

  const subtotal = cart.reduce((n, l) => n + l.priceCents * l.qty, 0);
  const tax = Math.round((subtotal * taxRate) / 100);
  const needle = q.trim().toLowerCase();
  const browse = needle ? items.filter((i) => i.name.toLowerCase().includes(needle) || i.vendorName.toLowerCase().includes(needle)) : items;

  return (
    <main style={{ maxWidth: 520, margin: "0 auto", padding: "22px 14px 90px" }}>
      <div style={{ textAlign: "center", marginBottom: 12 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 180, maxWidth: "60%", height: "auto", margin: "0 auto 4px", display: "block" }} />
        <div className="display" style={{ fontSize: 21 }}>SCAN &amp; PAY</div>
        <p style={{ fontSize: 12.5, color: "var(--ash)", marginTop: 2 }}>Skip the line — scan your items, pay by card, show your green screen on the way out.</p>
      </div>

      {paused && (
        <div className="card" style={{ marginBottom: 12, background: "#fef2f2", border: "1px solid #fecaca", textAlign: "center" }}>
          <div style={{ fontSize: 30 }}>🛒</div>
          <b style={{ fontSize: 15 }}>Self-checkout is paused right now.</b>
          <p style={{ fontSize: 13, color: "var(--ash)", marginTop: 4 }}>Bring your items to the register up front — we&rsquo;ll get you checked out with a smile.</p>
        </div>
      )}
      {!paused && (
      <div className="card" style={{ marginBottom: 12 }}>
        {!scanning && <button className="btn" onClick={startScan}>📷 SCAN A BARCODE</button>}
        <div id="scan-box" style={{ borderRadius: 12, overflow: "hidden", display: scanning ? "block" : "none" }} />
        {scanning && scanHit && (
          <div style={{
            marginTop: 10, borderRadius: 12, padding: "14px 14px", textAlign: "center",
            background: scanHit.kind === "ok" ? "#f0fdf4" : "#fef2f2",
            border: scanHit.kind === "ok" ? "2px solid #16a34a" : "2px solid #fca5a5",
          }}>
            <div style={{ fontSize: 26, lineHeight: 1 }}>{scanHit.kind === "ok" ? "\u2705" : "\ud83e\udd14"}</div>
            <div className="display" style={{ fontSize: 16, marginTop: 4 }}>{scanHit.title}</div>
            <div style={{ fontSize: 12.5, color: "var(--ash)", marginTop: 2 }}>{scanHit.sub}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="btn" style={{ flex: 1 }} onClick={() => { setScanHit(null); holdRef.current = false; try { scannerRef.current?.resume(); } catch {} }}>\ud83d\udcf7 SCAN NEXT ITEM</button>
              <button className="btn small ghost" onClick={() => { setScanHit(null); stopScan(); }}>DONE</button>
            </div>
          </div>
        )}
        {scanning && !scanHit && <div style={{ marginTop: 8 }}><button className="btn small ghost" onClick={stopScan}>STOP CAMERA</button></div>}
        <label>Or type the code printed under the barcode</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="V01-0003"
            onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) { lookupSku(code.trim().toUpperCase()); setCode(""); } }} />
          <button className="btn small" style={{ flex: "0 0 auto" }} onClick={() => { if (code.trim()) { lookupSku(code.trim().toUpperCase()); setCode(""); } }}>ADD</button>
        </div>
        {okMsg && <p className="ok" style={{ marginTop: 8 }}>{okMsg}</p>}
        {msg && <p className="err" style={{ marginTop: 8 }}>{msg}</p>}
      </div>
      )}

      {!paused && cart.length > 0 && (
        <div className="card" style={{ marginBottom: 12, border: "1px solid #bbf7d0", background: "#f0fdf4" }}>
          <h2 className="display" style={{ fontSize: 16, marginBottom: 6 }}>YOUR CART</h2>
          {cart.map((l) => (
            <div key={l.sku} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid #d1fae5", fontSize: 13.5 }}>
              <span><b>{l.name}</b> <span style={{ color: "var(--ash)" }}>· {l.vendorName}</span></span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
                <button className="btn small ghost" style={{ padding: "3px 10px" }} onClick={() => setCart((c) => c.map((x) => x.sku === l.sku ? { ...x, qty: Math.max(1, x.qty - 1) } : x))}>−</button>
                <b>{l.qty}</b>
                <button className="btn small ghost" style={{ padding: "3px 10px" }} onClick={() => addItem(l)}>＋</button>
                <b style={{ minWidth: 54, textAlign: "right" }}>{money(l.priceCents * l.qty)}</b>
                <button className="btn small ghost" style={{ padding: "3px 8px" }} onClick={() => setCart((c) => c.filter((x) => x.sku !== l.sku))}>✕</button>
              </span>
            </div>
          ))}
          <div style={{ fontSize: 13.5, marginTop: 8, display: "flex", justifyContent: "space-between" }}><span>Subtotal</span><b>{money(subtotal)}</b></div>
          <div style={{ fontSize: 13.5, display: "flex", justifyContent: "space-between" }}><span>Sales tax</span><b>{money(tax)}</b></div>
          <div style={{ fontSize: 16, display: "flex", justifyContent: "space-between" }}><span className="display">TOTAL</span><b className="display">{money(subtotal + tax)}</b></div>
          <label>Email for your receipt (optional)</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <div style={{ marginTop: 12 }}>
            <button className="btn" disabled={busy} onClick={pay}>💳 PAY {money(subtotal + tax)}</button>
          </div>
        </div>
      )}

      {!paused && (
      <div className="card">
        <h2 className="display" style={{ fontSize: 15, marginBottom: 6 }}>OR BROWSE WHAT&rsquo;S ON THE FLOOR</h2>
        <input placeholder="Search… (bread, honey, candle)" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
        {!loaded && <div className="skel" style={{ height: 120 }} />}
        {loaded && browse.slice(0, 60).map((i) => (
          <div key={i.sku} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 13.5 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>{i.photoId && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/public/photo/${i.photoId}`} alt={i.name} onClick={() => setLightbox({ src: `/api/public/photo/${i.photoId}`, alt: i.name })} style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)", flex: "0 0 auto", cursor: "zoom-in" }} />
            )}<span><b>{i.name}</b> <span style={{ color: "var(--ash)" }}>· {i.vendorName}</span></span></span>
            <span style={{ display: "flex", gap: 8, alignItems: "center", flex: "0 0 auto" }}>
              <b>{money(i.priceCents)}</b>
              <button className="btn small" onClick={() => addItem(i)}>ADD</button>
            </span>
          </div>
        ))}
        {loaded && browse.length === 0 && <p style={{ fontSize: 13, color: "var(--ash)" }}>Nothing matches — some vendors&rsquo; items only sell at the register.</p>}
        <p style={{ fontSize: 11, color: "var(--ash)", marginTop: 8 }}>Some items are register-only per the vendor — the page will tell you if one of yours is.</p>
      </div>
      )}
      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";

type Item = { id: string; sku: string; name: string; priceCents: number; quantity: number };

declare global {
  interface Window { JsBarcode?: (el: Element | string, code: string, opts?: object) => void }
}

export default function LabelsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [business, setBusiness] = useState("");
  const [ready, setReady] = useState(false);
  const [copies, setCopies] = useState<Record<string, number>>({});

  useEffect(() => {
    fetch("/api/vendor/me").then(async (r) => {
      if (!r.ok) { window.location.href = "/"; return; }
      const data = await r.json();
      setItems(data.items.filter((i: Item & { active: boolean }) => i.active));
      setBusiness(data.vendor.businessName);
      const c: Record<string, number> = {};
      for (const it of data.items) c[it.id] = Math.max(1, it.quantity || 1);
      setCopies(c);
    });
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.5/JsBarcode.all.min.js";
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    if (!ready || !window.JsBarcode) return;
    document.querySelectorAll("svg.barcode").forEach((el) => {
      const code = el.getAttribute("data-code");
      if (code) window.JsBarcode!(el, code, { format: "CODE128", width: 1.6, height: 44, fontSize: 12, margin: 0 });
    });
  });

  const sheet: { item: Item; n: number }[] = [];
  for (const it of items) {
    const n = copies[it.id] || 1;
    for (let i = 0; i < n; i++) sheet.push({ item: it, n: i });
  }

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "22px 16px 60px" }}>
      <style>{`
        .label-sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .lbl {
          border: 1.5px solid #22301c; border-radius: 8px; padding: 8px 8px 6px;
          text-align: center; background: #fff; break-inside: avoid;
        }
        .lbl .nm { font-weight: 700; font-size: 12px; line-height: 1.15; min-height: 27px; }
        .lbl .pr { font-family: Archivo, sans-serif; font-weight: 900; font-size: 16px; }
        .lbl .biz { font-size: 9px; color: #6d7a5f; }
        @media print {
          .no-print { display: none !important; }
          main { padding: 0 !important; max-width: none !important; }
          .label-sheet { gap: 4px; }
        }
      `}</style>

      <div className="no-print" style={{ marginBottom: 16 }}>
        <a className="btn small ghost" href="/vendor">← DASHBOARD</a>{" "}
        <button className="btn small" onClick={() => window.print()}>🖨 PRINT LABELS</button>
        <p style={{ fontSize: 13, color: "var(--ash)", marginTop: 10 }}>
          One label per item you&rsquo;re putting out (copies default to your floor quantity — adjust below).
          Prints 3-across; plain paper + tape works, or 30-up sticker sheets.
        </p>
        <div className="card" style={{ marginTop: 10 }}>
          {items.map((it) => (
            <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px dashed var(--ink)", gap: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{it.name} <span style={{ color: "var(--ash)", fontSize: 12 }}>({it.sku})</span></span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                copies:
                <input
                  type="number" min="0" step="1" value={copies[it.id] ?? 1}
                  onChange={(e) => setCopies((c) => ({ ...c, [it.id]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))}
                  style={{ width: 70, padding: "6px 8px" }}
                />
              </span>
            </div>
          ))}
          {items.length === 0 && <p style={{ color: "var(--ash)", fontSize: 14 }}>No items yet — add some on your dashboard first.</p>}
        </div>
      </div>

      <div className="label-sheet">
        {sheet.map(({ item, n }) => (
          <div className="lbl" key={`${item.id}-${n}`}>
            <div className="nm">{item.name}</div>
            <div className="pr">${(item.priceCents / 100) % 1 === 0 ? (item.priceCents / 100).toFixed(0) : (item.priceCents / 100).toFixed(2)}</div>
            <svg className="barcode" data-code={item.sku}></svg>
            <div className="biz">{business}</div>
          </div>
        ))}
      </div>
    </main>
  );
}

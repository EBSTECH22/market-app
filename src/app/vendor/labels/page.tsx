"use client";

import { useEffect, useState } from "react";

type Item = { id: string; sku: string; name: string; priceCents: number; quantity: number };

declare global {
  interface Window { JsBarcode?: (el: Element | string, code: string, opts?: object) => void }
}

// Two market-standard sheets, exact Avery-compatible geometry so barcodes land on stickers:
// STANDARD: 1" x 2-5/8", 30/sheet (Avery 5160 class — "address labels")
// SMALL:    2/3" x 1-3/4", 60/sheet (Avery 5195 class — "return address labels")
const FORMATS = {
  STANDARD: { cols: 3, rows: 10, labelW: "2.625in", labelH: "1in", padTop: "0.5in", padSide: "0.1875in", colGap: "0.125in", perSheet: 30, bar: { width: 1.7, height: 34, fontSize: 11 }, nameSize: 11, priceSize: 14, bizSize: 8 },
  SMALL: { cols: 4, rows: 15, labelW: "1.75in", labelH: "0.6667in", padTop: "0.5in", padSide: "0.3in", colGap: "0.3125in", perSheet: 60, bar: { width: 1.15, height: 22, fontSize: 8 }, nameSize: 8, priceSize: 10, bizSize: 0 },
} as const;
type FormatKey = keyof typeof FORMATS;

export default function LabelsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [business, setBusiness] = useState("");
  const [ready, setReady] = useState(false);
  const [copies, setCopies] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [format, setFormat] = useState<FormatKey>("STANDARD");

  useEffect(() => {
    fetch("/api/vendor/me").then(async (r) => {
      if (!r.ok) { window.location.href = "/"; return; }
      const data = await r.json();
      setItems(data.items.filter((i: Item & { active: boolean }) => i.active));
      setBusiness(data.vendor.businessName);
      const c: Record<string, number> = {};
      for (const it of data.items) c[it.id] = Math.max(1, it.quantity || 1);
      setCopies(c);
      setSelected({});
    });
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.5/JsBarcode.all.min.js";
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    if (!ready || !window.JsBarcode) return;
    const f = FORMATS[format];
    document.querySelectorAll("svg.barcode").forEach((el) => {
      const code = el.getAttribute("data-code");
      if (code) window.JsBarcode!(el, code, { format: "CODE128", width: f.bar.width, height: f.bar.height, fontSize: f.bar.fontSize, margin: 0 });
    });
  });

  const f = FORMATS[format];
  const sheet: { item: Item; n: number }[] = [];
  for (const it of items) {
    if (!selected[it.id]) continue;
    const n = copies[it.id] || 0;
    for (let i = 0; i < n; i++) sheet.push({ item: it, n: i });
  }
  const setAll = (on: boolean) => {
    const next: Record<string, boolean> = {};
    for (const it of items) next[it.id] = on;
    setSelected(next);
  };

  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "22px 16px 60px" }}>
      <style>{`
        .label-sheet {
          display: grid;
          grid-template-columns: repeat(${f.cols}, ${f.labelW});
          grid-auto-rows: ${f.labelH};
          column-gap: ${f.colGap};
          row-gap: 0;
          justify-content: flex-start;
        }
        .lbl {
          overflow: hidden; text-align: center; background: #fff;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          border: 1px dashed #d1d5db; break-inside: avoid;
        }
        .lbl .nm { font-weight: 700; font-size: ${f.nameSize}px; line-height: 1.1; max-width: 96%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lbl .pr { font-weight: 800; font-size: ${f.priceSize}px; line-height: 1.1; }
        .lbl .biz { font-size: ${f.bizSize}px; color: #6b7280; ${f.bizSize === 0 ? "display:none;" : ""} }
        @media print {
          @page { size: letter; margin: 0; }
          .no-print { display: none !important; }
          main { padding: 0 !important; max-width: none !important; margin: 0 !important; }
          .print-area { width: 8.5in; padding: ${f.padTop} ${f.padSide} 0; border: none !important; border-radius: 0 !important; }
          .lbl { border: none; }
        }
        @media screen {
          .print-area { border: 1px solid var(--border); border-radius: 12px; background: #fff; padding: 14px; overflow-x: auto; }
        }
      `}</style>

      <div className="no-print" style={{ marginBottom: 16 }}>
        <a className="btn small ghost" href="/vendor">← DASHBOARD</a>{" "}
        <button className="btn small" onClick={() => window.print()}>🖨 PRINT LABELS</button>

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className={`btn small ${format === "STANDARD" ? "" : "ghost"}`} onClick={() => setFormat("STANDARD")}>
            STANDARD — 1&quot; × 2⅝&quot; (30/sheet)
          </button>
          <button className={`btn small ${format === "SMALL" ? "" : "ghost"}`} onClick={() => setFormat("SMALL")}>
            SMALL — ⅔&quot; × 1¾&quot; (60/sheet)
          </button>
        </div>

        <div className="card" style={{ marginTop: 10, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
          <b style={{ fontSize: 13 }}>🛒 What to buy:</b>
          <p style={{ fontSize: 12.5, margin: "4px 0 0" }}>
            {format === "STANDARD"
              ? <>White <b>&ldquo;address labels, 30 per sheet&rdquo;</b> — 1&quot; × 2⅝&quot; (Avery 5160 or any store brand, ~$10). Works in any printer. Best for jars, bags, boxes, candles, soap.</>
              : <>White <b>&ldquo;return address labels, 60 per sheet&rdquo;</b> — ⅔&quot; × 1¾&quot; (Avery 5195/8195 or any store brand, ~$10). For lip balm, jewelry cards, small tins. Tip: for tiny items, put the label on a hang tag instead of the product.</>}
          </p>
          <p style={{ fontSize: 12.5, fontWeight: 700, margin: "6px 0 0", color: "#b91c1c" }}>
            ⚠️ In the print window set Scale to 100% (never &ldquo;Fit to page&rdquo;) or labels won&rsquo;t line up with the stickers.
          </p>
        </div>

        <p style={{ fontSize: 13, color: "var(--ash)", marginTop: 10 }}>
          Tick the items you want labels for and set how many of each (copies start at your floor quantity). Only what&rsquo;s checked prints. Each full sheet holds {f.perSheet} labels. Plain paper + tape works in a pinch.
        </p>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button className="btn small ghost" onClick={() => setAll(true)}>SELECT ALL</button>
          <button className="btn small ghost" onClick={() => setAll(false)}>SELECT NONE</button>
        </div>
        <div className="card" style={{ marginTop: 10 }}>
          {items.map((it) => (
            <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--border)", gap: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={!!selected[it.id]} style={{ width: "auto" }}
                  onChange={(e) => setSelected((sel) => ({ ...sel, [it.id]: e.target.checked }))} />
                {it.name} <span style={{ color: "var(--ash)", fontSize: 12 }}>({it.sku})</span>
              </label>
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
        {sheet.length === 0 && <p style={{ fontSize: 13, fontWeight: 600, marginTop: 10 }}>Nothing selected yet — tick items above, then print.</p>}
      </div>

      <div className="print-area">
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
      </div>
    </main>
  );
}

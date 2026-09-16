"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button, LinkButton, Field, Input, Checkbox, Segmented, Card, Note,
  EmptyState, PageHeader, Skeleton,
} from "@/components/ui";
import { money, plural } from "@/lib/format";

type Item = { id: string; sku: string; name: string; priceCents: number; quantity: number };

declare global {
  interface Window { JsBarcode?: (el: Element | string, code: string, opts?: object) => void }
}

const BARCODE_SRC = "https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.5/JsBarcode.all.min.js";

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
  const [scriptFailed, setScriptFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copies, setCopies] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [format, setFormat] = useState<FormatKey>("STANDARD");

  /* The barcode library comes off a CDN. If that request fails — captive wifi
     at the market, an ad blocker, a bad connection — every label used to print
     with a blank space where its barcode should be, silently. */
  const loadBarcodeScript = useCallback(() => {
    setScriptFailed(false);
    const s = document.createElement("script");
    s.src = BARCODE_SRC;
    s.onload = () => setReady(true);
    s.onerror = () => { setReady(false); setScriptFailed(true); s.remove(); };
    document.head.appendChild(s);
  }, []);

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
      setLoading(false);
    }).catch(() => setLoading(false));
    loadBarcodeScript();
  }, [loadBarcodeScript]);

  const f = FORMATS[format];

  const sheet = useMemo(() => {
    const out: { item: Item; n: number }[] = [];
    for (const it of items) {
      if (!selected[it.id]) continue;
      const n = copies[it.id] || 0;
      for (let i = 0; i < n; i++) out.push({ item: it, n: i });
    }
    return out;
  }, [items, selected, copies]);

  /* This effect had no dependency array at all, so it re-rendered every barcode
     on every keystroke and every parent render. It only needs to run when the
     library lands, the sheet changes, or the label geometry changes. */
  useEffect(() => {
    if (!ready || !window.JsBarcode) return;
    const fmt = FORMATS[format];
    document.querySelectorAll("svg.barcode").forEach((el) => {
      const code = el.getAttribute("data-code");
      if (code) {
        window.JsBarcode!(el, code, {
          format: "CODE128",
          width: fmt.bar.width,
          height: fmt.bar.height,
          fontSize: fmt.bar.fontSize,
          margin: 0,
        });
      }
    });
  }, [ready, format, sheet]);

  const setAll = (on: boolean) => {
    const next: Record<string, boolean> = {};
    for (const it of items) next[it.id] = on;
    setSelected(next);
  };

  const selectedCount = items.filter((it) => selected[it.id]).length;
  const sheets = Math.ceil(sheet.length / f.perSheet);

  return (
    <main className="content">
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
          overflow: hidden; text-align: center; background: #fff; color: #000;
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
          .print-area { border: 1px solid var(--border); border-radius: var(--r-lg); background: #fff; padding: 14px; overflow-x: auto; }
        }
      `}</style>

      <div className="no-print">
        <PageHeader
          title="Barcode labels"
          subtitle="Tick the items you want labels for, set how many of each, then print. Only what's ticked prints."
          actions={
            <>
              <LinkButton href="/vendor" variant="ghost" icon="arrowLeft">Back to the portal</LinkButton>
              <Button
                variant="primary"
                icon="print"
                disabled={sheet.length === 0 || !ready}
                onClick={() => window.print()}
              >
                Print labels
              </Button>
            </>
          }
        />

        <div className="stack g-4">
          {scriptFailed ? (
            <Note
              tone="error"
              title="Barcodes can't be drawn right now"
              action={<Button size="sm" variant="secondary" icon="refresh" onClick={loadBarcodeScript}>Try again</Button>}
            >
              The barcode library didn&rsquo;t load — usually a spotty connection or a blocker.
              Printing now would give you labels with blank barcodes, so printing is paused until
              it loads. Check your connection and try again.
            </Note>
          ) : null}

          {!ready && !scriptFailed ? (
            <Note tone="neutral" title="Getting the barcode library">
              Printing unlocks as soon as it lands — a second or two on most connections.
            </Note>
          ) : null}

          <Card title="Label size">
            <div className="stack g-4">
              <Segmented
                value={format}
                onChange={setFormat}
                label="Label size"
                options={[
                  { value: "STANDARD", label: "Standard — 1\" × 2⅝\" (30/sheet)" },
                  { value: "SMALL", label: "Small — ⅔\" × 1¾\" (60/sheet)" },
                ]}
              />

              <Note tone="info" title="What to buy">
                {format === "STANDARD"
                  ? <>White <b>&ldquo;address labels, 30 per sheet&rdquo;</b> — 1&quot; × 2⅝&quot; (Avery 5160 or any store brand, about $10). Works in any printer. Best for jars, bags, boxes, candles, soap.</>
                  : <>White <b>&ldquo;return address labels, 60 per sheet&rdquo;</b> — ⅔&quot; × 1¾&quot; (Avery 5195/8195 or any store brand, about $10). For lip balm, jewelry cards, small tins. For tiny items, put the label on a hang tag instead of the product.</>}
              </Note>

              <Note tone="warn" title="Set your printer scale to 100%">
                In the print window choose 100% scale, never &ldquo;Fit to page&rdquo; — otherwise the
                labels won&rsquo;t line up with the stickers.
              </Note>
            </div>
          </Card>

          <Card
            title="What to print"
            subtitle={
              sheet.length > 0
                ? `${plural(selectedCount, "item")} · ${plural(sheet.length, "label")} · ${plural(sheets, "sheet")} (${f.perSheet} per sheet)`
                : `Copies start at your floor quantity. Each full sheet holds ${f.perSheet} labels.`
            }
            actions={
              items.length > 0 ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setAll(true)}>Select all</Button>
                  <Button size="sm" variant="ghost" onClick={() => setAll(false)}>Select none</Button>
                </>
              ) : undefined
            }
          >
            {loading ? (
              <div className="stack g-3" aria-busy="true">
                <Skeleton height={40} />
                <Skeleton height={40} />
                <Skeleton height={40} />
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                icon="box"
                title="No items to label yet"
                body="Add your items on the dashboard first — each one gets its own barcode automatically."
                action={<LinkButton href="/vendor" variant="primary" icon="plus">Add an item</LinkButton>}
              />
            ) : (
              <div className="stack g-3">
                {items.map((it) => (
                  <div key={it.id} className="row between wrap g-3" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--sp-2)" }}>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <Checkbox
                        checked={!!selected[it.id]}
                        onCheckedChange={(on) => setSelected((sel) => ({ ...sel, [it.id]: on }))}
                        label={it.name}
                        hint={`${it.sku} · ${money(it.priceCents)}`}
                      />
                    </div>
                    <Field label="Copies" className="shrink0">
                      {(p) => (
                        <Input
                          {...p}
                          type="number"
                          min="0"
                          step="1"
                          inputMode="numeric"
                          style={{ width: 92 }}
                          value={copies[it.id] ?? 1}
                          onChange={(e) => setCopies((c) => ({ ...c, [it.id]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))}
                        />
                      )}
                    </Field>
                  </div>
                ))}

                {sheet.length === 0 ? (
                  <Note tone="neutral">Nothing selected yet — tick the items you want, then print.</Note>
                ) : null}
              </div>
            )}
          </Card>
        </div>
      </div>

      <div className="print-area mt-4">
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

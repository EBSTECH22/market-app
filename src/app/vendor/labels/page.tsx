"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { tagCents, cashCents } from "@/lib/cardprice";
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
  /* 5160: symmetric and exact. 0.1875 + 3x2.625 + 2x0.125 + 0.1875 = 8.5 */
  STANDARD: { cols: 3, rows: 10, labelW: "2.625in", labelH: "1in", padTop: "0.5in", padLeft: "0.1875in", padRight: "0.1875in", colGap: "0.125in", perSheet: 30, bar: { width: 1.7, height: 34, fontSize: 11 }, nameSize: 11, priceSize: 14, bizSize: 8, nameLines: 1, showCode: true },
  /* 0.28125in side, 0.25in gap — Avery's own 2in horizontal pitch. The old
     numbers (0.3 / 0.3125) needed 7.9375in of room inside an 7.9in box, so
     the fourth column was pushed off the right-hand edge of the paper. */
  /* 0.6667in is 64 dots of height for a name, a price and a barcode. The old
     numbers spent 10 of them reprinting the SKU underneath the bars — a
     number that is already IN the bars and is printed in full on the big
     labels — and left the name so little room it truncated mid-word. So the
     code line goes, the name gets two lines instead of an ellipsis, and the
     barcode gets the height back, which is also what makes it scan. */
  /* 5195, from the published template rather than from arithmetic.
     
     This sheet is NOT symmetric and its pitch is NOT a round number. The
     columns step every 2.031in — label 1.75 plus a 0.281 gap — starting
     0.297 from the left, which leaves 0.36 on the right. Guessing a tidy
     2.0in pitch put the fourth column nearly four millimetres left of its
     stickers, and the top margin is 0.531 rather than the half inch that
     looks obvious.
     
     0.297 + 4x1.75 + 3x0.281 + 0.36 = 8.5 exactly. */
  SMALL: { cols: 4, rows: 15, labelW: "1.75in", labelH: "0.666in", padTop: "0.531in", padLeft: "0.297in", padRight: "0.36in", colGap: "0.281in", perSheet: 60, bar: { width: 1.2, height: 30, fontSize: 0 }, nameSize: 7.5, priceSize: 11, bizSize: 0, nameLines: 2, showCode: false },
} as const;
type FormatKey = keyof typeof FORMATS;

export default function LabelsPage() {
  const [cardPercent, setCardPercent] = useState(0);
  const [feePercent, setFeePercent] = useState(0);
  /* The TAG: vendor's price + the market service fee, then + the card percentage. */
  const labelCents = (vendorCents: number) => tagCents(cashCents(vendorCents, feePercent), cardPercent);
  const [items, setItems] = useState<Item[]>([]);
  const [business, setBusiness] = useState("");
  const [ready, setReady] = useState(false);
  const [scriptFailed, setScriptFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copies, setCopies] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [format, setFormat] = useState<FormatKey>("STANDARD");
  /* PRINTER NUDGE.
     
     Published label geometry gets you close; the last millimetre is the
     printer, and every printer feeds paper slightly differently. Rather than
     anyone chasing specifications again, print one sheet, see which way it's
     out, and move the whole grid. Remembered per browser so it's set once. */
  const [nudgeX, setNudgeX] = useState(0);
  const [nudgeY, setNudgeY] = useState(0);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("labelNudge");
      if (raw) {
        const n = JSON.parse(raw) as { x?: number; y?: number };
        if (Number.isFinite(n.x)) setNudgeX(Number(n.x));
        if (Number.isFinite(n.y)) setNudgeY(Number(n.y));
      }
    } catch {
      /* Private window, storage off — just print with no offset. */
    }
  }, []);

  const saveNudge = (x: number, y: number) => {
    const clamp = (v: number) => Math.max(-0.25, Math.min(0.25, Math.round(v * 1000) / 1000));
    const nx = clamp(x), ny = clamp(y);
    setNudgeX(nx); setNudgeY(ny);
    try { window.localStorage.setItem("labelNudge", JSON.stringify({ x: nx, y: ny })); } catch {}
  };

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
      setCardPercent(Number(data.cardPercent) || 0);
      setFeePercent(Number(data.feePercent) || 0);
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
          /* The readable code under the bars. Worth the room on a 1in label
             and not on a 2/3in one. */
          displayValue: fmt.showCode,
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

  /* ONE BLOCK PER PHYSICAL SHEET.
     
     All the labels used to sit in a single run with the half-inch top margin
     applied once, at the very start. That is correct for the first sheet and
     wrong for every sheet after it: the browser breaks the run at the bottom
     of the paper, so sheet two begins its labels hard against the top edge —
     half an inch high, and the first row past what most printers can even
     reach. Splitting the run into sheets gives each one its own margin. */
  const pages = useMemo(() => {
    const out: { item: Item; n: number }[][] = [];
    for (let i = 0; i < sheet.length; i += f.perSheet) out.push(sheet.slice(i, i + f.perSheet));
    return out;
  }, [sheet, f.perSheet]);

  return (
    <main className="content">
      <style>{`
        .label-sheet {
          display: grid;
          grid-template-columns: repeat(${f.cols}, ${f.labelW});
          grid-auto-rows: ${f.labelH};
          column-gap: ${f.colGap};
          row-gap: 0;
          /* Hard against the left margin. Both sheets now carry their real
             margins, and 5195's are deliberately uneven — centring would
             quietly add half the difference back onto the left. */
          justify-content: flex-start;
        }
        .lbl {
          overflow: hidden; text-align: center; background: #fff; color: #000;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          border: 1px dashed #d1d5db; break-inside: avoid;
        }
        .lbl .nm {
          font-weight: 700; font-size: ${f.nameSize}px; line-height: 1.08;
          max-width: 96%; overflow: hidden;
          ${f.nameLines > 1
            ? `display: -webkit-box; -webkit-line-clamp: ${f.nameLines}; -webkit-box-orient: vertical;`
            : "white-space: nowrap; text-overflow: ellipsis;"}
        }
        .lbl .pr { font-weight: 800; font-size: ${f.priceSize}px; line-height: 1.1; }
        .lbl .biz { font-size: ${f.bizSize}px; color: #6b7280; ${f.bizSize === 0 ? "display:none;" : ""} }
        @media print {
          @page { size: letter; margin: 0; }
          .no-print { display: none !important; }
          main { padding: 0 !important; max-width: none !important; margin: 0 !important; }
          /* The spacing class on this element is for the screen. Left alone it
             survives into print as a sixth of an inch at the top of the first
             sheet, which is enough to walk every label off its sticker. */
          .print-area { width: 8.5in; margin: 0 !important; padding: 0 !important; border: none !important; border-radius: 0 !important; }
          .sheet-page {
            width: 8.5in;
            padding: calc(${f.padTop} + ${nudgeY}in) ${f.padRight} 0 calc(${f.padLeft} + ${nudgeX}in);
            break-after: page; page-break-after: always;
            position: relative;
          }
          /* A ruler on the liner. The half inch above the first row is bare
             backing paper on every one of these sheets, so a mark there costs
             nothing and settles the one thing nobody can see by eye: whether
             the printer shrank the page. If it doesn't measure an inch, the
             scale is wrong and no amount of changing the layout will help. */
          .cal { position: absolute; top: 0.16in; left: calc(${f.padLeft} + ${nudgeX}in); }
          .sheet-page:last-child { break-after: auto; page-break-after: auto; }
          .lbl { border: none; }
        }
        .cal-bar { width: 1in; height: 0; border-top: 1px solid #000; position: relative; }
        .cal-bar::before, .cal-bar::after {
          content: ""; position: absolute; top: -4px; width: 0; height: 9px; border-left: 1px solid #000;
        }
        .cal-bar::before { left: 0; }
        .cal-bar::after { right: 0; }
        .cal-txt { font-size: 6px; color: #666; letter-spacing: 0.02em; }

        @media screen {
          .print-area { overflow-x: auto; }
          .sheet-page {
            width: 8.5in;
            padding: ${f.padTop} ${f.padRight} 0.5in ${f.padLeft};
            border: 1px solid var(--border); border-radius: var(--r-lg);
            background: #fff; margin-bottom: var(--sp-4);
          }
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
                /* Short labels here — the exact dimensions and what to buy are
                   spelled out in the note directly below. */
                options={[
                  { value: "STANDARD", label: "Standard · 30 per sheet" },
                  { value: "SMALL", label: "Small · 60 per sheet" },
                ]}
              />

              <Note tone="info" title="What to buy">
                {format === "STANDARD"
                  ? <>White <b>&ldquo;address labels, 30 per sheet&rdquo;</b> — 1&quot; × 2⅝&quot; (Avery 5160 or any store brand, about $10). Works in any printer. Best for jars, bags, boxes, candles, soap.</>
                  : <>White <b>&ldquo;return address labels, 60 per sheet&rdquo;</b> — ⅔&quot; × 1¾&quot; (Avery 5195/8195 or any store brand, about $10). For lip balm, jewelry cards, small tins. For tiny items, put the label on a hang tag instead of the product.</>}
              </Note>

              <Note tone="warn" title="Set your printer scale to 100%">
                In the print window choose 100% scale, never &ldquo;Fit to page&rdquo; — otherwise the
                labels won&rsquo;t line up with the stickers. The first sheet prints a 1-inch ruler on the
                bare liner at the top: hold a tape to it. If it isn&rsquo;t an inch, the scale is wrong and
                nothing below will help.
              </Note>

              <div className="stack g-2">
                <span className="t-label">Nudge the whole sheet</span>
                <p className="t-xs t-muted">
                  Print one sheet at 100% first. If every label is out by the same amount in the same
                  direction, move the grid to match your printer. Hundredths of an inch; 0.01 is about a
                  quarter of a millimetre of movement. Saved on this device.
                </p>
                <div className="row wrap g-2" style={{ alignItems: "flex-end" }}>
                  <Field label="Left / right (in)" className="shrink0">
                    {(p) => (
                      <Input
                        {...p}
                        type="number" step="0.01" min="-0.25" max="0.25"
                        inputMode="decimal"
                        style={{ width: 110 }}
                        value={nudgeX}
                        onChange={(e) => saveNudge(Number(e.target.value) || 0, nudgeY)}
                      />
                    )}
                  </Field>
                  <Field label="Up / down (in)" className="shrink0">
                    {(p) => (
                      <Input
                        {...p}
                        type="number" step="0.01" min="-0.25" max="0.25"
                        inputMode="decimal"
                        style={{ width: 110 }}
                        value={nudgeY}
                        onChange={(e) => saveNudge(nudgeX, Number(e.target.value) || 0)}
                      />
                    )}
                  </Field>
                  {nudgeX || nudgeY ? (
                    <Button size="sm" variant="ghost" icon="refresh" onClick={() => saveNudge(0, 0)}>
                      Back to zero
                    </Button>
                  ) : null}
                </div>
                <span className="t-xs t-muted">
                  Positive moves right and down. Printing too far left? Try 0.03.
                </span>
              </div>
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
                        hint={`${it.sku} · tag ${money(labelCents(it.priceCents))}${labelCents(it.priceCents) !== it.priceCents ? ` (your price ${money(it.priceCents)})` : ""}`}
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
        {pages.map((page, pageIndex) => (
          <div className="sheet-page" key={pageIndex}>
            {/* Only on the first sheet — one check per print is the point. */}
            {pageIndex === 0 ? (
              <div className="cal" aria-hidden="true">
                <div className="cal-bar" />
                <div className="cal-txt">1 inch — if this isn&rsquo;t exactly 1&quot;, your printer is scaling. Set it to 100%.</div>
              </div>
            ) : null}
            <div className="label-sheet">
              {page.map(({ item, n }) => (
                <div className="lbl" key={`${item.id}-${n}`}>
                  <div className="nm">{item.name}</div>
                  {/* The TAG price: the vendor's price plus the card percentage.
                      Card pays this; cash gets the percentage off at the register. */}
                  <div className="pr">${(() => { const c = labelCents(item.priceCents); return (c / 100) % 1 === 0 ? (c / 100).toFixed(0) : (c / 100).toFixed(2); })()}</div>
                  <svg className="barcode" data-code={item.sku}></svg>
                  <div className="biz">{business}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

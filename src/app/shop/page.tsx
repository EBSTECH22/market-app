"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Lightbox from "@/components/Lightbox";
import { usePulse } from "@/lib/usePulse";
import {
  Button, Card, EmptyState, Field, Icon, IconButton, Input, LinkButton, Note,
  SearchInput, Skeleton, useDialog,
} from "@/components/ui";
import { money, plural } from "@/lib/format";
import { taxFor, normalizeTaxClass } from "@/lib/tax";

type Item = { id: string; sku: string; name: string; priceCents: number; quantity: number; taxClass?: string; vendorName: string; photoId?: string | null };
type Line = Item & { qty: number };

export default function SelfCheckout() {
  const dialog = useDialog();
  const [items, setItems] = useState<Item[]>([]);
  const [taxRate, setTaxRate] = useState(0);
  const [foodTaxRate, setFoodTaxRate] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
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
        if (r.ok) { const d = await r.json(); setItems(d.items || []); setTaxRate(d.taxRatePercent || 0); setFoodTaxRate(typeof d.foodTaxRatePercent === "number" ? d.foodTaxRatePercent : (d.taxRatePercent || 0)); setPaused(!!d.paused); setLoadFailed(false); }
        else setLoadFailed(true);
        setLoaded(true);
      }).catch(() => { setLoadFailed(true); setLoaded(true); });
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
    setOkMsg(`Added ${it.name}`);
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
              setScanHit({ kind: "ok", title: "Added — " + res.item.name, sub: money(res.item.priceCents) + " · it's in your cart" });
            } else {
              setScanHit({ kind: "err", title: "That one didn't work", sub: res.error || "Try again, or type the code under the barcode." });
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

  const clearCart = async () => {
    const yes = await dialog.confirm({
      title: "Empty your cart?",
      body: `This removes all ${plural(cart.reduce((n, l) => n + l.qty, 0), "item")} from your cart on this phone. Nothing is charged and nothing leaves the shelf — you can scan them again.`,
      confirmLabel: "Empty the cart",
      cancelLabel: "Keep shopping",
      tone: "danger",
    });
    if (!yes) return;
    setCart([]);
    setMsg("");
    setOkMsg("");
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
  /* Food and general goods carry different rates — same library the server
     uses, so the screen and the charge can't disagree. */
  const taxRates = { standardPercent: taxRate, foodPercent: foodTaxRate };
  const shopTaxLines = cart.map((l) => ({ amountCents: l.priceCents * l.qty, taxClass: normalizeTaxClass(l.taxClass) }));
  const tax = taxFor(shopTaxLines, taxRates).taxCents;
  const needle = q.trim().toLowerCase();
  const browse = needle ? items.filter((i) => i.name.toLowerCase().includes(needle) || i.vendorName.toLowerCase().includes(needle)) : items;

  return (
    <>
      <header className="public-header">
        <div className="public-header-inner">
          <a href="/market" aria-label="Community Harvest" style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wordmark.png" alt="Community Harvest" style={{ width: 150, maxWidth: "46vw", height: "auto", display: "block" }} />
          </a>
          <LinkButton href="/market" variant="ghost" size="sm" icon="store" className="shrink0">Market</LinkButton>
        </div>
      </header>

      <main className="public-wrap public-narrow">
        <div className="hero">
          <h1 className="hero-title">Scan &amp; pay</h1>
          <p className="hero-sub">
            Skip the line — scan your items, pay by card, and show your green screen on the way out.
          </p>
        </div>

        {paused && (
          <Note tone="warn" title="Self-checkout is paused right now">
            Bring your items to the register up front — we&rsquo;ll get you checked out with a smile.
          </Note>
        )}

        {!paused && (
          <Card title="Scan your items" className="mb-4">
            <div className="stack g-3">
              {!scanning && (
                <Button variant="primary" size="xl" block icon="scan" onClick={startScan}>
                  Scan a barcode
                </Button>
              )}

              <div id="scan-box" style={{ borderRadius: "var(--r-lg)", overflow: "hidden", display: scanning ? "block" : "none" }} />

              {scanning && scanHit && (
                <div
                  role="status"
                  style={{
                    borderRadius: "var(--r-lg)",
                    padding: "var(--sp-4)",
                    textAlign: "center",
                    background: scanHit.kind === "ok" ? "var(--accent-soft)" : "var(--danger-soft)",
                    border: `2px solid ${scanHit.kind === "ok" ? "var(--accent)" : "var(--danger)"}`,
                    color: scanHit.kind === "ok" ? "var(--accent-text)" : "var(--danger-text)",
                  }}
                >
                  <Icon name={scanHit.kind === "ok" ? "checkCircle" : "help"} size={28} />
                  <div className="t-section mt-1">{scanHit.title}</div>
                  <div className="t-sm mt-1">{scanHit.sub}</div>
                  <div className="row g-2 mt-3">
                    <Button
                      variant="primary"
                      size="lg"
                      icon="scan"
                      className="grow"
                      onClick={() => { setScanHit(null); holdRef.current = false; try { scannerRef.current?.resume(); } catch {} }}
                    >
                      Scan next item
                    </Button>
                    <Button variant="secondary" size="lg" onClick={() => { setScanHit(null); stopScan(); }}>Done</Button>
                  </div>
                </div>
              )}

              {scanning && !scanHit && (
                <Button variant="secondary" size="lg" block icon="close" onClick={stopScan}>Stop the camera</Button>
              )}

              <Field label="Or type the code printed under the barcode">
                {(p) => (
                  <div className="row g-2">
                    <Input
                      {...p}
                      className="grow"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="V01-0003"
                      autoCapitalize="characters"
                      autoComplete="off"
                      onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) { lookupSku(code.trim().toUpperCase()); setCode(""); } }}
                    />
                    <Button
                      variant="secondary"
                      size="lg"
                      className="shrink0"
                      onClick={() => { if (code.trim()) { lookupSku(code.trim().toUpperCase()); setCode(""); } }}
                    >
                      Add
                    </Button>
                  </div>
                )}
              </Field>

              {okMsg && <Note tone="success">{okMsg}</Note>}
              {msg && <Note tone="error">{msg}</Note>}
            </div>
          </Card>
        )}

        {!paused && cart.length > 0 && (
          <Card
            title="Your cart"
            subtitle={plural(cart.reduce((n, l) => n + l.qty, 0), "item")}
            actions={<Button variant="dangerSoft" size="sm" icon="trash" onClick={clearCart}>Clear cart</Button>}
            className="mb-4"
          >
            <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {cart.map((l) => (
                <li
                  key={l.sku}
                  className="row between g-3 wrap"
                  style={{ padding: "var(--sp-3) 0", borderBottom: "1px solid var(--border)" }}
                >
                  <span className="grow" style={{ minWidth: 140 }}>
                    <b className="t-body">{l.name}</b>
                    <span className="t-xs t-muted" style={{ display: "block" }}>{l.vendorName}</span>
                  </span>
                  <span className="row g-2 shrink0">
                    <IconButton
                      icon="minus"
                      size="sm"
                      label={`One fewer ${l.name}`}
                      disabled={l.qty <= 1}
                      onClick={() => setCart((c) => c.map((x) => x.sku === l.sku ? { ...x, qty: Math.max(1, x.qty - 1) } : x))}
                    />
                    <b className="num" style={{ minWidth: 20, textAlign: "center" }} aria-label={`Quantity ${l.qty}`}>{l.qty}</b>
                    <IconButton icon="plus" size="sm" label={`One more ${l.name}`} onClick={() => addItem(l)} />
                    <b className="num" style={{ minWidth: 62, textAlign: "right" }}>{money(l.priceCents * l.qty)}</b>
                    <IconButton
                      icon="trash"
                      size="sm"
                      variant="dangerSoft"
                      label={`Remove ${l.name}`}
                      onClick={() => setCart((c) => c.filter((x) => x.sku !== l.sku))}
                    />
                  </span>
                </li>
              ))}
            </ul>

            <div className="stack g-1 mt-3">
              <div className="row between t-body"><span>Subtotal</span><b className="num">{money(subtotal)}</b></div>
              <div className="row between t-body"><span>Sales tax</span><b className="num">{money(tax)}</b></div>
              <div className="row between t-section mt-1"><span>Total</span><b className="num">{money(subtotal + tax)}</b></div>
            </div>

            <div className="mt-4">
              <Field label="Email for your receipt" hint="Optional — we'll send the receipt here.">
                {(p) => (
                  <Input {...p} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                )}
              </Field>
            </div>

            <div className="mt-4">
              <Button variant="primary" size="xl" block loading={busy} icon="card" onClick={pay}>
                Pay {money(subtotal + tax)}
              </Button>
            </div>
          </Card>
        )}

        {!paused && (
          <Card title="Or browse what's on the floor">
            <div className="stack g-3">
              <SearchInput value={q} onValueChange={setQ} placeholder="Search… (bread, honey, candle)" aria-label="Search items on the floor" />

              {!loaded && (
                <div className="stack g-3" aria-hidden>
                  <Skeleton height={44} />
                  <Skeleton height={44} />
                  <Skeleton height={44} />
                </div>
              )}

              {loaded && loadFailed && (
                <EmptyState
                  icon="alert"
                  title="We couldn't load the shelf"
                  body="You can still scan barcodes or type a code. Try loading the list again."
                  action={<Button variant="secondary" icon="refresh" onClick={() => (window as unknown as { __ls?: () => void }).__ls?.()}>Try again</Button>}
                />
              )}

              {loaded && !loadFailed && browse.length === 0 && (
                <EmptyState
                  icon="search"
                  title={needle ? "Nothing matches" : "Nothing listed right now"}
                  body="Some vendors' items only sell at the register — bring those up front."
                  action={needle ? <Button variant="secondary" onClick={() => setQ("")}>Clear search</Button> : undefined}
                />
              )}

              {loaded && !loadFailed && browse.length > 0 && (
                <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {browse.slice(0, 60).map((i) => (
                    <li
                      key={i.sku}
                      className="row between g-3 wrap"
                      style={{ padding: "var(--sp-2) 0", borderBottom: "1px solid var(--border)" }}
                    >
                      <span className="row g-3 grow" style={{ minWidth: 140 }}>
                        {i.photoId && (
                          <button
                            type="button"
                            className="shrink0"
                            aria-label={`View a larger photo of ${i.name}`}
                            onClick={() => setLightbox({ src: `/api/public/photo/${i.photoId}`, alt: i.name })}
                            style={{
                              padding: 0,
                              border: "1px solid var(--border)",
                              borderRadius: "var(--r-md)",
                              background: "none",
                              cursor: "zoom-in",
                              lineHeight: 0,
                              overflow: "hidden",
                            }}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`/api/public/photo/${i.photoId}`}
                              alt=""
                              style={{ width: 44, height: 44, objectFit: "cover", display: "block" }}
                            />
                          </button>
                        )}
                        <span style={{ minWidth: 0 }}>
                          <b className="t-body">{i.name}</b>
                          <span className="t-xs t-muted" style={{ display: "block" }}>{i.vendorName}</span>
                        </span>
                      </span>
                      <span className="row g-3 shrink0">
                        <b className="num">{money(i.priceCents)}</b>
                        <Button variant="secondary" size="lg" icon="plus" onClick={() => addItem(i)}>Add</Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="t-xs t-muted" style={{ margin: 0 }}>
                Some items are register-only per the vendor — the page will tell you if one of yours is.
              </p>
            </div>
          </Card>
        )}
      </main>

      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </>
  );
}

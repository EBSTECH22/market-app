"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  Icon, Button, LinkButton, Field, Input, SearchInput, Badge, Card, Note,
  EmptyState, Skeleton, useToast,
} from "@/components/ui";
import { money, plural } from "@/lib/format";
import { taxFor, displayRate, normalizeTaxClass } from "@/lib/tax";

/**
 * A vendor ringing up their own goods, on their own phone, at their own booth.
 *
 * Built for one thumb standing behind a table: items are big tap targets, the
 * running total never leaves the screen, and the two payment buttons are the
 * last thing on the page.
 *
 * NOT a card reader. Stripe only ships Tap to Pay in native iOS/Android SDKs,
 * so no website can turn a phone into a terminal. Card payments show the
 * customer a QR they scan with their OWN phone — which is better here anyway,
 * since their card never touches a stranger's device.
 */

type Item = {
  id: string; sku: string; name: string; priceCents: number;
  basePriceCents: number; salePercent: number; quantity: number; taxClass?: string;
};
type Line = { item: Item; qty: number };

export default function VendorSellPage() {
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [taxRate, setTaxRate] = useState(0);
  const [foodTaxRate, setFoodTaxRate] = useState(0);
  const [cardReady, setCardReady] = useState(false);

  const [q, setQ] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const [payUrl, setPayUrl] = useState("");
  const [qr, setQr] = useState("");
  const [cashCode, setCashCode] = useState("");
  const [cartId, setCartId] = useState("");
  const [paid, setPaid] = useState(false);


  const subtotal = lines.reduce((n, l) => n + l.item.priceCents * l.qty, 0);
  const taxRates = { standardPercent: taxRate, foodPercent: foodTaxRate };
  const taxLines = lines.map((l) => ({ amountCents: l.item.priceCents * l.qty, taxClass: normalizeTaxClass(l.item.taxClass) }));
  const taxCents = taxFor(taxLines, taxRates).taxCents;
  const shownTaxRate = displayRate(taxLines, taxRates);
  const total = subtotal + taxCents;
  const count = lines.reduce((n, l) => n + l.qty, 0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/vendor/sell");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(String(d.error || "Couldn't load your items.")); return; }
      setItems(d.items || []);
      setTaxRate(Number(d.taxRatePercent) || 0);
      setFoodTaxRate(typeof d.foodTaxRatePercent === "number" ? d.foodTaxRatePercent : (Number(d.taxRatePercent) || 0));
      setCardReady(!!d.cardReady);
      setVendorName(String(d.vendor?.businessName || ""));
      setErr("");
    } catch {
      setErr("No connection. Check your signal and pull down to retry.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);


  const add = (item: Item) => {
    setLines((ls) => {
      const found = ls.find((l) => l.item.id === item.id);
      if (found) return ls.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l));
      return [...ls, { item, qty: 1 }];
    });
  };

  const setQty = (id: string, qty: number) =>
    setLines((ls) => (qty <= 0 ? ls.filter((l) => l.item.id !== id) : ls.map((l) => (l.item.id === id ? { ...l, qty } : l))));

  const reset = () => {
    setLines([]); setEmail(""); setPayUrl(""); setQr(""); setCashCode("");
    setQ(""); setCartId(""); setPaid(false);
  };

  /* Watch for the payment landing.
     The vendor is standing there holding the goods deciding whether to hand
     them over; "did that work?" is the whole question, and Stripe's own
     confirmation happens on the CUSTOMER's phone where the vendor can't see it.
     Polling stops the moment it's paid, and the QR screen is the only place
     this runs. */
  useEffect(() => {
    if (!cartId || !qr || paid) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/vendor/sell?cartId=${encodeURIComponent(cartId)}`);
        if (!r.ok || !alive) return;
        const d = await r.json();
        if (d.paid && alive) setPaid(true);
      } catch { /* a dropped poll just means we check again in three seconds */ }
    };
    const id = window.setInterval(tick, 3000);
    void tick();
    return () => { alive = false; window.clearInterval(id); };
  }, [cartId, qr, paid]);

  const start = async (mode: "CARD" | "CASH") => {
    if (!lines.length) return;
    setBusy(true);
    try {
      const r = await fetch("/api/vendor/sell", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode, email: email.trim(),
          lines: lines.map((l) => ({ itemId: l.item.id, qty: l.qty })),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // The gate refusing is a normal outcome, not a crash — say what to do.
        if (d.gateBlocked) { toast.error("Can't ring this up here", String(d.error || "")); return; }
        toast.error("Couldn't start the payment", String(d.error || ""));
        return;
      }

      setCartId(String(d.cartId || ""));
      if (mode === "CASH") {
        setCashCode(String(d.registerCode || ""));
        return;
      }
      const url = String(d.url || "");
      setPayUrl(url);
      // Rendered on THIS screen for the customer to scan with their own phone.
      setQr(await QRCode.toDataURL(url, { width: 640, margin: 1, color: { dark: "#000000", light: "#ffffff" } }));
    } catch {
      toast.error("No connection", "Nothing was charged. Try again when you have signal.");
    } finally { setBusy(false); }
  };

  const hits = q.trim()
    ? items.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase()) || i.sku.toLowerCase().includes(q.trim().toLowerCase()))
    : items;

  const shell = (inner: React.ReactNode) => (
    <div style={{ minHeight: "100dvh", background: "var(--bg-sunken)", padding: "var(--sp-4)" }}>
      <div className="stack g-4" style={{ maxWidth: 560, margin: "0 auto" }}>
        <div className="row wrap g-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <span className="row g-2">
            <Icon name="register" size={18} />
            <span style={{ fontWeight: 700 }}>{vendorName || "Ring up a sale"}</span>
          </span>
          <LinkButton href="/vendor" size="sm" variant="ghost" icon="arrowLeft">My portal</LinkButton>
        </div>
        {inner}
      </div>
    </div>
  );

  if (loading) {
    return shell(<div className="stack g-3" aria-busy="true"><Skeleton height={64} radius="var(--r-lg)" /><Skeleton height={300} radius="var(--r-lg)" /></div>);
  }

  if (err) {
    return shell(
      <Note tone="error" title="Couldn't open the register">
        {err}
        <div className="mt-2"><Button size="sm" icon="refresh" onClick={() => void load()}>Try again</Button></div>
      </Note>
    );
  }

  /* ---- card: the customer scans this ---- */
  if (qr) {
    /* Paid is its own screen, not a badge on the QR. The vendor is deciding
       whether to hand over goods; that answer has to be unmissable from arm's
       length, not a green dot they have to squint for. */
    if (paid) {
      return shell(
        <Card title="Paid" subtitle="Hand it over — you're done.">
          <div className="stack g-4" style={{ textAlign: "center" }}>
            <div
              className="card card-pad stack g-2"
              style={{ background: "var(--accent-soft)", borderColor: "var(--accent-border)" }}
            >
              <Icon name="checkCircle" size={44} />
              <span className="display num" style={{ fontSize: "var(--fs-4xl)" }}>{money(total)}</span>
              <span className="t-sm">Payment cleared.</span>
            </div>
            <p className="t-sm t-muted">
              Your stock is updated and your balance has been credited, less commission. It&rsquo;ll show on
              your next payout.
            </p>
            <Button variant="primary" size="xl" block icon="plus" onClick={reset}>Next customer</Button>
          </div>
        </Card>
      );
    }

    return shell(
      <Card title="Have them scan this" subtitle="They pay on their own phone. Their card never touches yours.">
        <div className="stack g-4" style={{ textAlign: "center" }}>
          <div className="stack g-1">
            <span className="t-label">Amount</span>
            <span className="display num" style={{ fontSize: "var(--fs-4xl)" }}>{money(total)}</span>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt="Payment QR code" style={{ width: "100%", maxWidth: 320, margin: "0 auto", display: "block", borderRadius: "var(--r-md)" }} />
          <Note tone="info">
            Keep this screen open — it&rsquo;ll tell you the moment they&rsquo;ve paid. Don&rsquo;t hand
            anything over until it does.
          </Note>
          <div className="row wrap g-2">
            <LinkButton href={payUrl} variant="secondary" icon="external" external className="grow">
              Open the payment page instead
            </LinkButton>
            <Button variant="ghost" size="lg" onClick={reset}>Cancel</Button>
          </div>
          <p className="t-xs t-muted">
            If they walk away, nothing is charged and nothing is deducted from your stock.
          </p>
        </div>
      </Card>
    );
  }

  /* ---- cash: they take this code to the register ---- */
  if (cashCode) {
    return shell(
      <Card title="Send them to the register" subtitle="You can't take cash out here — the market's drawer has to hold it.">
        <div className="stack g-4" style={{ textAlign: "center" }}>
          <div className="stack g-1">
            <span className="t-label">Amount</span>
            <span className="display num" style={{ fontSize: "var(--fs-3xl)" }}>{money(total)}</span>
          </div>
          <div className="stack g-1">
            <span className="t-label">Their code</span>
            <span
              className="display num"
              style={{ fontSize: "3rem", letterSpacing: "0.12em", lineHeight: 1.1 }}
            >
              {cashCode}
            </span>
          </div>
          <Note tone="info">
            The cashier types this in and takes the cash. It still counts as your sale, and your balance is
            credited the same as a card payment.
          </Note>
          <Button variant="primary" size="xl" block icon="check" onClick={reset}>Done</Button>
          <p className="t-xs t-muted">
            Nothing is deducted from your stock until they actually pay at the register.
          </p>
        </div>
      </Card>
    );
  }

  /* ---- ringing up ---- */
  return shell(
    <>
      <Card title="Your items" subtitle="Tap to add. Tap again for two.">
        <div className="stack g-3">
          {items.length > 6 ? (
            <Field label="Find an item">
              {(p) => <SearchInput {...p} value={q} onValueChange={setQ} placeholder="honey / soap" aria-label="Find one of your items" />}
            </Field>
          ) : null}

          {items.length === 0 ? (
            <EmptyState
              icon="box"
              title="You haven't added any items yet"
              body="Add them in your portal first, then come back here to sell them."
              action={<LinkButton href="/vendor#items" variant="primary" icon="plus">Add items</LinkButton>}
            />
          ) : hits.length === 0 ? (
            <EmptyState icon="search" title="Nothing matches that" body="Try part of the name." />
          ) : (
            <div className="stack g-2">
              {hits.map((i) => {
                const inCart = lines.find((l) => l.item.id === i.id)?.qty || 0;
                const out = i.quantity <= 0;
                return (
                  <Button
                    key={i.id}
                    variant={inCart ? "primary" : "secondary"}
                    size="xl"
                    block
                    disabled={out}
                    onClick={() => add(i)}
                  >
                    <span className="grow truncate" style={{ textAlign: "left" }}>{i.name}</span>
                    {i.salePercent > 0 ? <Badge tone="danger">−{i.salePercent}%</Badge> : null}
                    {out ? <Badge tone="warn">Sold out</Badge> : null}
                    {inCart ? <Badge tone="solid">{inCart}</Badge> : null}
                    <span className="num">{money(i.priceCents)}</span>
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {lines.length > 0 ? (
        <Card
          title="Ticket"
          subtitle={`${plural(count, "item")}`}
          actions={<Button size="sm" variant="dangerSoft" icon="trash" onClick={() => setLines([])}>Clear</Button>}
        >
          <div className="stack g-3">
            {lines.map((l) => (
              <div key={l.item.id} className="row g-3" style={{ alignItems: "center" }}>
                <span className="grow truncate" style={{ minWidth: 0 }}>{l.item.name}</span>
                <div className="row g-1" style={{ alignItems: "center" }}>
                  <Button size="sm" variant="secondary" aria-label={`One fewer ${l.item.name}`} onClick={() => setQty(l.item.id, l.qty - 1)}>−</Button>
                  <span className="num" style={{ minWidth: 26, textAlign: "center" }}>{l.qty}</span>
                  <Button size="sm" variant="secondary" aria-label={`One more ${l.item.name}`} onClick={() => setQty(l.item.id, l.qty + 1)}>+</Button>
                </div>
                <span className="num" style={{ minWidth: 68, textAlign: "right" }}>{money(l.item.priceCents * l.qty)}</span>
              </div>
            ))}

            <div className="stack g-1" style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--sp-3)" }}>
              <div className="t-body">Subtotal <b className="num">{money(subtotal)}</b></div>
              <div className="t-body">Tax{shownTaxRate === null ? " (mixed)" : ` (${shownTaxRate}%)`} <b className="num">{money(taxCents)}</b></div>
              <div className="row g-3 mt-1" style={{ alignItems: "baseline" }}>
                <span className="t-label">Total</span>
                <span className="display num" style={{ fontSize: "var(--fs-4xl)" }}>{money(total)}</span>
              </div>
            </div>

            <Field label="Email them a receipt" hint="Optional.">
              {(p) => (
                <Input {...p} type="email" inputMode="email" autoComplete="off" placeholder="them@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              )}
            </Field>

            <div className="stack g-2">
              <Button
                variant="primary" size="xl" block icon="card"
                loading={busy} disabled={busy || !cardReady}
                onClick={() => void start("CARD")}
              >
                Card — show them a QR
              </Button>
              <Button
                variant="dark" size="xl" block icon="cash"
                loading={busy} disabled={busy}
                onClick={() => void start("CASH")}
              >
                Cash — get a register code
              </Button>
              {!cardReady ? (
                <Note tone="warn">Card payments aren&rsquo;t switched on right now — use the cash code.</Note>
              ) : null}
            </div>
          </div>
        </Card>
      ) : (
        <Note tone="info">Tap your items above to start a ticket.</Note>
      )}
    </>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Icon, Button, Field, Input, MoneyInput, SearchInput, Badge, Card, Note,
  EmptyState, Skeleton, useToast,
} from "@/components/ui";
import { money, fmtTime, plural, dollarsToCents } from "@/lib/format";
import { taxFor, displayRate, normalizeTaxClass } from "@/lib/tax";
import { TZ } from "@/lib/time";
import { CashTender } from "@/components/register/CashTender";

/**
 * The register as a kiosk.
 *
 * A separate page rather than a link into /admin, for three reasons that all
 * showed up in practice: the admin bundle carries payroll, settings and reports
 * that a cashier has no business loading; /admin's own chrome (sidebar, tab
 * switching) invites wandering; and a till needs to LOCK, which a tab inside a
 * signed-in owner session can't meaningfully do.
 *
 * It talks to exactly the same endpoints as the register tab — those already
 * accept a staff session — so there is no second implementation of a sale.
 * The one piece of real logic, working out change, lives in @/lib/cash and is
 * shared with the register tab rather than written twice.
 */

const IDLE_LOCK_MS = 5 * 60 * 1000;

type FloorItem = {
  id: string; sku: string; name: string; priceCents: number; basePriceCents: number;
  quantity: number; vendorName: string; vendorCode: string; taxClass?: string;
};
type CartLine = {
  itemId: string; sku: string; name: string; vendorName: string;
  priceCents: number; basePriceCents: number; quantity: number; taxClass?: string;
};
type Drawer = { id: string; employee: string; openedAt: string; openTotalCents: number; cashSalesCents: number };
type Receipt = {
  id: string; number: number; employee: string; totalCents: number;
  cashTenderedCents?: number; changeCents?: number; paymentMethod: string;
};
type VendorTicket = {
  cartId: string; code: string; vendorName: string; vendorCode: string;
  lines: { name: string; sku: string; quantity: number; priceCents: number }[];
  subtotalCents: number; taxCents: number; totalCents: number;
};

export default function RegisterKiosk() {
  const toast = useToast();

  const [who, setWho] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [drawerLoaded, setDrawerLoaded] = useState(false);
  const [openFloat, setOpenFloat] = useState("");
  const [closeCount, setCloseCount] = useState("");
  const [closing, setClosing] = useState(false);

  const [floor, setFloor] = useState<FloorItem[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [scan, setScan] = useState("");
  const [scanErr, setScanErr] = useState("");
  const [search, setSearch] = useState("");
  const [openVendor, setOpenVendor] = useState<string | null>(null);
  const [taxRate, setTaxRate] = useState(0);
  const [foodTaxRate, setFoodTaxRate] = useState(0);

  const [pay, setPay] = useState<"NONE" | "CASH" | "CARD">("NONE");
  const [cardRef, setCardRef] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  /* A ticket a vendor rang up at their own booth and sent here for cash. It
     never enters the normal cart: re-pricing it against today's prices, or
     booking it under the cashier's name, are the two things the code exists to
     prevent. */
  const [vtCode, setVtCode] = useState("");
  const [vt, setVt] = useState<VendorTicket | null>(null);
  const [vtErr, setVtErr] = useState("");

  const scanRef = useRef<HTMLInputElement>(null);
  const printRef = useRef<HTMLDivElement>(null);

  const subtotal = cart.reduce((n, l) => n + l.priceCents * l.quantity, 0);
  /* Same library the server uses, so the number on screen and the number that
     gets booked can't disagree. */
  const rates = { standardPercent: taxRate, foodPercent: foodTaxRate };
  const taxLines = cart.map((l) => ({ amountCents: l.priceCents * l.quantity, taxClass: normalizeTaxClass(l.taxClass) }));
  const taxCents = taxFor(taxLines, rates).taxCents;
  const shownRate = displayRate(taxLines, rates);
  const total = subtotal + taxCents;

  /* ------------------------------------------------------------- session -- */

  const lock = useCallback(async (quiet = false) => {
    try { await fetch("/api/staff/pin-login", { method: "DELETE" }); } catch {}
    setWho(null); setPin(""); setPinErr("");
    setCart([]); setPay("NONE"); setReceipt(null); setCardRef("");
    if (!quiet) toast.success("Locked");
  }, [toast]);

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/whoami")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        // An owner opening this page on their laptop is signed in as "admin"
        // with no employee name. That's a valid staff session for the APIs, but
        // a till needs a person's name on the drawer, so ask for a PIN anyway.
        if (d && d.role === "staff" && d.name) setWho(d.name);
      })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, []);

  /* Idle lock. Every pointer, key and touch resets the clock; nothing else
     does, so a page left sitting on a finished receipt still locks. */
  useEffect(() => {
    if (!who) return;
    let timer = window.setTimeout(() => void lock(true), IDLE_LOCK_MS);
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void lock(true), IDLE_LOCK_MS);
    };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "touchstart", "wheel"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [who, lock]);

  const signIn = async (entered: string) => {
    if (!entered) return;
    setBusy(true); setPinErr("");
    try {
      const r = await fetch("/api/staff/pin-login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: entered }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setPinErr(String(d.error || "Couldn't sign you in.")); setPin(""); return; }
      setWho(String(d.employee?.name || ""));
      setPin("");
    } catch {
      setPinErr("No connection. Check the wifi and try again.");
    } finally { setBusy(false); }
  };

  /* ---------------------------------------------------------------- data -- */

  const loadDrawer = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/drawer");
      if (r.ok) setDrawer((await r.json()).session);
    } finally { setDrawerLoaded(true); }
  }, []);

  const loadFloor = useCallback(async () => {
    const r = await fetch("/api/admin/overview");
    if (r.ok) setFloor((await r.json()).floor || []);
  }, []);

  /* Tax lives in settings, not overview. Reading it wrong would put a different
     tax on the kiosk than the register tab charges — and the server recomputes
     the real figure anyway, so the mismatch would only ever show up as a total
     that changes after the customer has already been told a number. */
  const loadTax = useCallback(async () => {
    const r = await fetch("/api/admin/settings");
    if (!r.ok) return;
    const d = await r.json();
    if (typeof d.taxRatePercent === "number") setTaxRate(d.taxRatePercent);
    if (typeof d.foodTaxRatePercent === "number") setFoodTaxRate(d.foodTaxRatePercent);
  }, []);

  useEffect(() => {
    if (!who) return;
    void loadDrawer();
    void loadFloor();
    void loadTax();
  }, [who, loadDrawer, loadFloor, loadTax]);

  /* Keep the cursor in the scan box so a barcode scanner just works — it types
     and presses Enter, and it does not care what's focused. */
  useEffect(() => {
    if (who && drawer && !closing && !receipt && pay === "NONE") scanRef.current?.focus();
  }, [who, drawer, closing, receipt, pay, cart.length]);

  /* ---------------------------------------------------------------- cart -- */

  const addItem = (i: { id: string; sku: string; name: string; priceCents: number; basePriceCents: number; vendorName: string; taxClass?: string }) => {
    setScanErr("");
    setCart((c) => {
      const line = c.find((l) => l.sku === i.sku);
      if (line) return c.map((l) => (l.sku === i.sku ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { itemId: i.id, sku: i.sku, name: i.name, vendorName: i.vendorName, priceCents: i.priceCents, basePriceCents: i.basePriceCents, quantity: 1, taxClass: i.taxClass }];
    });
  };

  const setQty = (sku: string, q: number) =>
    setCart((c) => (q <= 0 ? c.filter((l) => l.sku !== sku) : c.map((l) => (l.sku === sku ? { ...l, quantity: q } : l))));

  const doScan = async () => {
    const code = scan.trim().toUpperCase();
    setScan("");
    if (!code) return;
    const inCart = cart.find((l) => l.sku === code);
    if (inCart) { addItem({ id: inCart.itemId, sku: inCart.sku, name: inCart.name, priceCents: inCart.priceCents, basePriceCents: inCart.basePriceCents, vendorName: inCart.vendorName, taxClass: inCart.taxClass }); return; }
    const onFloor = floor.find((i) => i.sku === code);
    if (onFloor) { addItem(onFloor); return; }
    try {
      const res = await fetch(`/api/admin/lookup?sku=${encodeURIComponent(code)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setScanErr(String(data.error || `Nothing found for ${code}.`)); return; }
      addItem({ id: data.item.id, sku: data.item.sku, name: data.item.name, priceCents: data.item.priceCents, basePriceCents: data.item.basePriceCents, vendorName: data.item.vendor.businessName, taxClass: data.item.taxClass });
    } catch {
      // Raw fetch in the original register threw into nothing on a dropped
      // connection, so a scan during a wifi blip just did nothing at all.
      setScanErr("No connection — the item couldn't be looked up.");
    }
  };

  /* -------------------------------------------------------------- drawer -- */

  const openDrawer = async () => {
    /* dollarsToCents returns null for anything it can't read. Passing that
       through would have the server coerce it to 0 and open the drawer with a
       float of nothing — which then reads as a huge shortage at count-out. */
    const cents = dollarsToCents(openFloat);
    if (cents === null || cents < 0) {
      toast.error("That's not an amount", "Enter the starting cash like 150.00");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/admin/drawer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // No name or PIN: the staff session already says who this is.
        body: JSON.stringify({ counts: {}, totalCents: cents }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't open the drawer", String(d.error || "")); return; }
      setDrawer(d.session);
      setOpenFloat("");
      toast.success("Drawer open", `Starting with ${money(cents)}.`);
    } finally { setBusy(false); }
  };

  const closeDrawer = async () => {
    const cents = dollarsToCents(closeCount);
    if (cents === null || cents < 0) {
      toast.error("That's not an amount", "Enter what you counted, like 284.50");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/admin/drawer", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ counts: {}, countedCents: cents }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't close the drawer", String(d.error || "")); return; }
      const over = Number(d.session?.overShortCents ?? 0);
      toast.success(
        "Drawer closed",
        over === 0 ? "Counted exactly." : over > 0 ? `${money(over)} over.` : `${money(-over)} short.`
      );
      setDrawer(null); setClosing(false); setCloseCount("");
      await lock(true);
    } finally { setBusy(false); }
  };

  /* ---------------------------------------------------------------- sale -- */

  const printReceipt = useCallback(async (saleId: string) => {
    const res = await fetch(`/api/admin/tickets/${saleId}`);
    if (!res.ok) return;
    const { sale } = await res.json();
    if (!printRef.current) return;
    const when = new Date(sale.createdAt);
    printRef.current.innerHTML = `
      <div style="width:280px;margin:0 auto;font-size:12px;line-height:1.5;text-align:center;font-family:'IBM Plex Mono',monospace;color:#000">
        <img src="/logo.png" alt="Community Harvest" style="width:100%;max-width:260px;display:block;margin:0 auto 2px" />
        <div>Noble, Oklahoma</div>
        <div style="margin:6px 0;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:4px 0">
          RECEIPT #${sale.number}<br>${when.toLocaleDateString("en-US", { timeZone: TZ })} ${when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ })}${sale.employee ? "<br>CLERK: " + sale.employee : ""}
        </div>
        <div style="text-align:left">
          ${sale.lines.map((l: { quantity: number; name: string; priceCents: number; basePriceCents?: number }) =>
            `<div style="display:flex;justify-content:space-between"><span>${l.quantity}x ${String(l.name).slice(0, 26)}</span><span>${money((l.basePriceCents || l.priceCents) * l.quantity)}</span></div>`).join("")}
        </div>
        <div style="border-top:1px dashed #000;margin-top:4px;padding-top:4px;text-align:left">
          <div style="display:flex;justify-content:space-between"><span>SUBTOTAL</span><span>${money(sale.subtotalCents + (sale.saleSavingsCents || 0))}</span></div>
          ${sale.saleSavingsCents ? `<div style="display:flex;justify-content:space-between"><span>SALE SAVINGS</span><span>-${money(sale.saleSavingsCents)}</span></div>` : ""}
          ${sale.cardAdjustCents ? `<div style="display:flex;justify-content:space-between"><span>NON-CASH ADJ</span><span>${money(sale.cardAdjustCents)}</span></div>` : ""}
          ${sale.foodTaxCents && sale.standardTaxCents
            ? `<div style="display:flex;justify-content:space-between"><span>TAX (GENERAL)</span><span>${money(sale.standardTaxCents)}</span></div>
          <div style="display:flex;justify-content:space-between"><span>TAX (FOOD)</span><span>${money(sale.foodTaxCents)}</span></div>`
            : `<div style="display:flex;justify-content:space-between"><span>TAX</span><span>${money(sale.taxCents)}</span></div>`}
          ${sale.discountCents ? `<div style="display:flex;justify-content:space-between"><span>REWARDS</span><span>-${money(sale.discountCents)}</span></div>` : ""}
          <div style="display:flex;justify-content:space-between;font-weight:700;font-size:14px"><span>TOTAL</span><span>${money(sale.totalCents)}</span></div>
          ${sale.cashTenderedCents ? `<div style="display:flex;justify-content:space-between"><span>CASH</span><span>${money(sale.cashTenderedCents)}</span></div>
          <div style="display:flex;justify-content:space-between"><span>CHANGE</span><span>${money(sale.changeCents || 0)}</span></div>` : ""}
          <div>${sale.paymentMethod}${sale.cardName ? " - " + sale.cardName : ""}</div>
        </div>
        <div style="margin-top:8px">THANK YOU!<br>homegrown + homemade</div>
        <div style="margin-top:6px;font-size:10px">ALL SALES FINAL — NO REFUNDS OR EXCHANGES</div>
      </div>`;
    const img = printRef.current.querySelector("img");
    if (img && !img.complete) {
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
        setTimeout(resolve, 1500);
      });
    }
    document.body.classList.add("receiptmode");
    window.print();
    setTimeout(() => document.body.classList.remove("receiptmode"), 400);
  }, []);

  const book = async (method: "CASH" | "CARD", tenderedCents = 0) => {
    if (!cart.length) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/sale", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethod: method,
          cardName: method === "CARD" ? cardRef : "",
          cashTenderedCents: method === "CASH" ? tenderedCents : 0,
          lines: cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setScanErr(String(d.error || "Sale failed.")); setPay("NONE"); return; }
      setReceipt({ ...(d.sale as Receipt), paymentMethod: method });
      setCart([]); setPay("NONE"); setCardRef("");
      void loadDrawer(); void loadFloor();
    } catch {
      setScanErr("No connection — the sale was not booked. Check the wifi and ring it again.");
      setPay("NONE");
    } finally { setBusy(false); }
  };

  /* ------------------------------------------------- vendor booth tickets -- */

  const findVendorTicket = async () => {
    const code = vtCode.trim().toUpperCase();
    if (!code) return;
    setBusy(true); setVtErr("");
    try {
      const r = await fetch(`/api/admin/vendor-ticket?code=${encodeURIComponent(code)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setVtErr(String(d.error || "Couldn't find that ticket.")); setVt(null); return; }
      setVt(d as VendorTicket);
    } catch {
      setVtErr("No connection — couldn't look that up.");
    } finally { setBusy(false); }
  };

  const bookVendorTicket = async (tenderedCents: number) => {
    if (!vt) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/vendor-ticket", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: vt.code, cashTenderedCents: tenderedCents }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setVtErr(String(d.error || "Couldn't book that ticket.")); return; }
      setReceipt({ ...(d.sale as Receipt), paymentMethod: "CASH" });
      setVt(null); setVtCode(""); setVtErr("");
      void loadDrawer(); void loadFloor();
    } catch {
      setVtErr("No connection — the ticket was NOT rung. Try again before taking the money.");
    } finally { setBusy(false); }
  };

  /* ---------------------------------------------------------------- view -- */

  /* #printzone must be a DIRECT child of body: the print stylesheet is
     `body.receiptmode > *:not(#printzone) { display: none }`, so nesting it
     inside the page wrapper would hide the wrapper and the receipt with it.
     That's why it's a sibling of the shell rather than inside it. */
  const shell = (inner: React.ReactNode) => (
    <>
      <div style={{ minHeight: "100dvh", background: "var(--bg-sunken)", padding: "var(--sp-4)" }}>
        <div className="stack g-4" style={{ maxWidth: 940, margin: "0 auto" }}>{inner}</div>
      </div>
      <div id="printzone" ref={printRef} />
    </>
  );

  if (checking) {
    return shell(
      <div className="stack g-3" aria-busy="true">
        <Skeleton height={80} radius="var(--r-lg)" />
        <Skeleton height={320} radius="var(--r-lg)" />
      </div>
    );
  }

  /* ----- locked ----- */
  if (!who) {
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "enter"];
    return shell(
      <div className="stack g-4" style={{ maxWidth: 380, margin: "8vh auto 0" }}>
        <div className="stack g-2" style={{ textAlign: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 56, height: 56, margin: "0 auto" }} />
          <h1 className="display" style={{ fontSize: "var(--fs-2xl)", margin: 0 }}>Register</h1>
          <p className="t-sm t-muted">Enter your PIN to start a shift.</p>
        </div>

        <div
          className="card card-pad"
          style={{ textAlign: "center", letterSpacing: "0.5em", fontSize: "var(--fs-2xl)", minHeight: 64 }}
          aria-live="polite"
          aria-label={`${pin.length} digits entered`}
        >
          {pin ? "•".repeat(pin.length) : <span className="t-muted" style={{ letterSpacing: 0, fontSize: "var(--fs-sm)" }}>PIN</span>}
        </div>

        {pinErr ? <Note tone="error">{pinErr}</Note> : null}

        <div className="grid-auto" style={{ ["--min" as string]: "96px" }}>
          {keys.map((k) =>
            k === "clear" ? (
              <Button key={k} size="xl" variant="ghost" block disabled={busy} onClick={() => { setPin(""); setPinErr(""); }}>
                Clear
              </Button>
            ) : k === "enter" ? (
              <Button key={k} size="xl" variant="primary" block loading={busy} disabled={busy || pin.length < 3} onClick={() => void signIn(pin)}>
                Enter
              </Button>
            ) : (
              <Button
                key={k}
                size="xl"
                variant="secondary"
                block
                disabled={busy}
                onClick={() => { setPinErr(""); setPin((p) => (p.length >= 12 ? p : p + k)); }}
              >
                {k}
              </Button>
            )
          )}
        </div>

        {/* A physical keyboard should work too — some tills have one. */}
        <input
          className="input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label="PIN"
          value={pin}
          onChange={(e) => { setPinErr(""); setPin(e.target.value.replace(/\D/g, "").slice(0, 12)); }}
          onKeyDown={(e) => { if (e.key === "Enter") void signIn(pin); }}
        />
      </div>
    );
  }

  const header = (
    <div className="row wrap g-3" style={{ justifyContent: "space-between", alignItems: "center" }}>
      <div className="row g-2">
        <Icon name="register" size={18} />
        <span style={{ fontWeight: 700 }}>{who}</span>
        {drawer ? (
          <Badge tone="success" dot>Drawer open {fmtTime(drawer.openedAt)}</Badge>
        ) : (
          <Badge tone="warn" dot>No drawer</Badge>
        )}
      </div>
      <div className="row wrap g-2">
        {drawer && !closing ? (
          <Button size="sm" variant="secondary" icon="lock" onClick={() => setClosing(true)}>
            Close drawer
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" icon="logout" onClick={() => void lock()}>Lock</Button>
      </div>
    </div>
  );

  /* ----- no drawer open ----- */
  if (drawerLoaded && !drawer) {
    return shell(
      <>
        {header}
        <Card title="Open the drawer" subtitle="Count the starting cash before the first sale.">
          <div className="stack g-4">
            <Field label="Starting cash in the drawer" hint="What's in there right now, before you sell anything.">
              {(p) => (
                <MoneyInput
                  {...p}
                  value={openFloat}
                  placeholder="150.00"
                  style={{ height: 64, fontSize: "var(--fs-xl)" }}
                  onChange={(e) => setOpenFloat(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void openDrawer(); }}
                />
              )}
            </Field>
            <Button variant="primary" size="xl" block icon="unlock" loading={busy} disabled={busy || !openFloat.trim()} onClick={() => void openDrawer()}>
              Open the drawer with {money(dollarsToCents(openFloat) || 0)}
            </Button>
          </div>
        </Card>
      </>
    );
  }

  /* ----- closing out ----- */
  if (closing && drawer) {
    const expected = drawer.openTotalCents + drawer.cashSalesCents;
    const counted = dollarsToCents(closeCount) || 0;
    const diff = counted - expected;
    return shell(
      <>
        {header}
        <Card title="Count out" subtitle="Count everything in the drawer, including the float you started with.">
          <div className="stack g-4">
            <div className="row wrap g-4">
              <div className="stack g-1">
                <span className="t-label">Should be there</span>
                <span className="display num" style={{ fontSize: "var(--fs-3xl)" }}>{money(expected)}</span>
                <span className="t-xs t-muted">{money(drawer.openTotalCents)} start + {money(drawer.cashSalesCents)} cash sales</span>
              </div>
            </div>
            <Field label="What you actually counted">
              {(p) => (
                <MoneyInput
                  {...p}
                  value={closeCount}
                  placeholder="0.00"
                  style={{ height: 64, fontSize: "var(--fs-xl)" }}
                  onChange={(e) => setCloseCount(e.target.value)}
                />
              )}
            </Field>
            {closeCount.trim() ? (
              <Note tone={diff === 0 ? "success" : Math.abs(diff) < 500 ? "warn" : "error"}>
                {diff === 0 ? "Exactly right." : diff > 0 ? `${money(diff)} over.` : `${money(-diff)} short.`}
              </Note>
            ) : null}
            <div className="row wrap g-2">
              <Button variant="primary" size="xl" className="grow" icon="lock" loading={busy} disabled={busy || !closeCount.trim()} onClick={() => void closeDrawer()}>
                Close the drawer
              </Button>
              <Button variant="ghost" size="xl" disabled={busy} onClick={() => { setClosing(false); setCloseCount(""); }}>
                Back
              </Button>
            </div>
          </div>
        </Card>
      </>
    );
  }

  /* ----- receipt ----- */
  if (receipt) {
    return shell(
      <>
        {header}
        <Card title={`Sale #${receipt.number}`} subtitle="Done — hand over the receipt.">
          <div className="stack g-4" style={{ textAlign: "center" }}>
            <div className="stack g-1">
              <span className="t-label">Total</span>
              <span className="display num" style={{ fontSize: "var(--fs-4xl)" }}>{money(receipt.totalCents)}</span>
            </div>
            {receipt.paymentMethod === "CASH" && (receipt.cashTenderedCents ?? 0) > 0 ? (
              <div className="row g-4" style={{ justifyContent: "center" }}>
                <div className="stack g-1">
                  <span className="t-label">Cash given</span>
                  <span className="num" style={{ fontSize: "var(--fs-xl)" }}>{money(receipt.cashTenderedCents || 0)}</span>
                </div>
                <div className="stack g-1">
                  <span className="t-label">Change given</span>
                  <span className="num" style={{ fontSize: "var(--fs-xl)" }}>{money(receipt.changeCents || 0)}</span>
                </div>
              </div>
            ) : null}
            <div className="row wrap g-2">
              <Button variant="primary" size="xl" className="grow" icon="plus" onClick={() => setReceipt(null)}>
                Next customer
              </Button>
              <Button variant="secondary" size="xl" icon="print" onClick={() => void printReceipt(receipt.id)}>
                Print again
              </Button>
            </div>
          </div>
        </Card>
      </>
    );
  }

  /* ----- selling ----- */
  const hits = search.trim()
    ? floor.filter((i) =>
        i.name.toLowerCase().includes(search.trim().toLowerCase()) ||
        i.sku.toLowerCase().includes(search.trim().toLowerCase())
      ).slice(0, 12)
    : [];
  const vendorList = [...new Map(floor.map((i) => [i.vendorCode, i.vendorName])).entries()];

  /* A vendor's booth ticket takes over the screen: it is already priced and
     already attributed, so mixing it with whatever is in the cart would only
     create ways to ring the wrong thing. */
  if (vt) {
    return shell(
      <>
        {header}
        <Card
          title={`${vt.vendorName} — booth ticket ${vt.code}`}
          subtitle="Rung up at their own booth. Take the cash; it books as their sale, not yours."
          actions={<Button size="sm" variant="ghost" onClick={() => { setVt(null); setVtErr(""); }}>Back</Button>}
        >
          <div className="stack g-3">
            {vt.lines.map((l, idx) => (
              <div key={`${l.sku}-${idx}`} className="row g-3" style={{ alignItems: "center" }}>
                <span className="grow truncate">{l.quantity}× {l.name}</span>
                <span className="num">{money(l.priceCents * l.quantity)}</span>
              </div>
            ))}
            <div className="stack g-1" style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--sp-3)" }}>
              <div className="t-body">Subtotal <b className="num">{money(vt.subtotalCents)}</b></div>
              <div className="t-body">Tax <b className="num">{money(vt.taxCents)}</b></div>
            </div>
            {vtErr ? <Note tone="error">{vtErr}</Note> : null}
          </div>
        </Card>
        <CashTender
          totalCents={vt.totalCents}
          busy={busy}
          onCancel={() => { setVt(null); setVtErr(""); }}
          onConfirm={(tendered) => void bookVendorTicket(tendered)}
        />
      </>
    );
  }

  return shell(
    <>
      {header}

      {pay === "NONE" ? (
        <Card
          title="Vendor booth ticket"
          subtitle="A vendor rang something up at their own booth and sent the customer here to pay cash."
        >
          <div className="stack g-2">
            <div className="row wrap g-2" style={{ alignItems: "flex-end" }}>
              <Field label="Their code" className="grow">
                {(p) => (
                  <Input
                    {...p}
                    className="mono"
                    value={vtCode}
                    autoComplete="off"
                    placeholder="K4M7Q"
                    style={{ height: 56, fontSize: "var(--fs-xl)", letterSpacing: "0.12em", textTransform: "uppercase" }}
                    onChange={(e) => { setVtCode(e.target.value.toUpperCase()); setVtErr(""); }}
                    onKeyDown={(e) => { if (e.key === "Enter") void findVendorTicket(); }}
                  />
                )}
              </Field>
              <Button size="lg" variant="secondary" icon="search" loading={busy} disabled={busy || !vtCode.trim()} onClick={() => void findVendorTicket()}>
                Find it
              </Button>
            </div>
            {vtErr ? <Note tone="error">{vtErr}</Note> : null}
          </div>
        </Card>
      ) : null}

      {pay === "NONE" ? (
        <Card title="Ring up" subtitle="Scan, search, or tap a vendor's line.">
          <div className="stack g-4">
            <Field label="Scan or type a code, then Enter" error={scanErr || undefined}>
              {(p) => (
                <Input
                  {...p}
                  ref={scanRef}
                  className="mono"
                  value={scan}
                  autoComplete="off"
                  placeholder="V01-0001"
                  style={{ height: 64, fontSize: "var(--fs-xl)", letterSpacing: "0.04em" }}
                  onChange={(e) => setScan(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void doScan(); }}
                />
              )}
            </Field>

            <Field label="Or search">
              {(p) => (
                <SearchInput {...p} value={search} onValueChange={setSearch} placeholder="honey / cutting board" aria-label="Search the floor" />
              )}
            </Field>

            {search.trim() ? (
              hits.length === 0 ? (
                <EmptyState icon="search" title="No matches on the floor" body="Try part of the name, or the vendor code." />
              ) : (
                <div className="row wrap g-2">
                  {hits.map((i) => (
                    <Button key={i.id} variant="secondary" size="lg" icon="plus" onClick={() => addItem(i)}>
                      <span className="truncate">{i.name}</span>
                      <span className="num">{money(i.priceCents)}</span>
                      {i.quantity === 0 ? <Badge tone="warn">Out</Badge> : null}
                    </Button>
                  ))}
                </div>
              )
            ) : (
              <div className="stack g-2">
                <span className="t-label">Browse a vendor</span>
                <div className="row wrap g-2">
                  {vendorList.map(([code, name]) => (
                    <Button
                      key={code}
                      variant={openVendor === code ? "primary" : "secondary"}
                      icon="store"
                      aria-pressed={openVendor === code}
                      onClick={() => setOpenVendor(openVendor === code ? null : code)}
                    >
                      <span className="mono t-xs">{code}</span>
                      <span className="truncate">{name}</span>
                    </Button>
                  ))}
                </div>
                {openVendor ? (
                  <div className="row wrap g-2">
                    {floor.filter((i) => i.vendorCode === openVendor).map((i) => (
                      <Button key={i.id} variant="secondary" size="lg" icon="plus" onClick={() => addItem(i)}>
                        <span className="truncate">{i.name}</span>
                        <span className="num">{money(i.priceCents)}</span>
                        {i.quantity === 0 ? <Badge tone="warn">Out</Badge> : null}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </Card>
      ) : null}

      <Card
        title="Ticket"
        subtitle={cart.length ? `${plural(cart.reduce((n, l) => n + l.quantity, 0), "item")}` : undefined}
        actions={cart.length && pay === "NONE" ? (
          <Button size="sm" variant="dangerSoft" icon="trash" onClick={() => setCart([])}>Clear</Button>
        ) : undefined}
      >
        {cart.length === 0 ? (
          <EmptyState icon="receipt" title="Nothing on the ticket" body="Scan something to get started." />
        ) : (
          <div className="stack g-3">
            <div className="stack g-2">
              {cart.map((l) => (
                <div key={l.sku} className="row g-3" style={{ alignItems: "center" }}>
                  <div className="stack g-1 grow" style={{ minWidth: 0 }}>
                    <span className="truncate" style={{ fontWeight: 600 }}>{l.name}</span>
                    <span className="t-xs t-muted">{l.vendorName} · {money(l.priceCents)} each</span>
                  </div>
                  {pay === "NONE" ? (
                    <div className="row g-1" style={{ alignItems: "center" }}>
                      <Button size="sm" variant="secondary" aria-label={`One fewer ${l.name}`} onClick={() => setQty(l.sku, l.quantity - 1)}>−</Button>
                      <span className="num" style={{ minWidth: 28, textAlign: "center" }}>{l.quantity}</span>
                      <Button size="sm" variant="secondary" aria-label={`One more ${l.name}`} onClick={() => setQty(l.sku, l.quantity + 1)}>+</Button>
                    </div>
                  ) : (
                    <span className="num">×{l.quantity}</span>
                  )}
                  <span className="num" style={{ minWidth: 72, textAlign: "right" }}>{money(l.priceCents * l.quantity)}</span>
                </div>
              ))}
            </div>

            <div className="stack g-1" style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--sp-3)" }}>
              <div className="t-body">Subtotal <b className="num">{money(subtotal)}</b></div>
              <div className="t-body">Tax{shownRate === null ? " (mixed)" : ` (${shownRate}%)`} <b className="num">{money(taxCents)}</b></div>
              <div className="row g-3 mt-1" style={{ alignItems: "baseline" }}>
                <span className="t-label">Total</span>
                <span className="display num" style={{ fontSize: "var(--fs-4xl)" }}>{money(total)}</span>
              </div>
            </div>

            {pay === "NONE" ? (
              <div className="grid-auto" style={{ ["--min" as string]: "200px" }}>
                <Button variant="primary" size="xl" block icon="cash" disabled={busy} onClick={() => setPay("CASH")}>Cash</Button>
                <Button variant="dark" size="xl" block icon="card" disabled={busy} onClick={() => setPay("CARD")}>Card</Button>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      {pay === "CASH" && cart.length > 0 ? (
        <CashTender
          totalCents={total}
          busy={busy}
          onCancel={() => setPay("NONE")}
          onConfirm={(tendered) => void book("CASH", tendered)}
        />
      ) : null}

      {pay === "CARD" && cart.length > 0 ? (
        <div className="card card-pad stack g-3" style={{ background: "var(--accent-soft)", borderColor: "var(--accent-border)" }}>
          <div className="stack g-1">
            <span className="t-label t-accent">Charge the card terminal</span>
            <span className="display num" style={{ fontSize: "var(--fs-4xl)" }}>{money(total)}</span>
          </div>
          <Field label="Approval code or last 4" hint="Optional, but it's the only thing tying this ticket to the terminal.">
            {(p) => (
              <Input {...p} className="mono" value={cardRef} placeholder="APPR 004571 · 4242" autoComplete="off" onChange={(e) => setCardRef(e.target.value)} />
            )}
          </Field>
          <Note tone="info">Run the card on the terminal first. Nothing is recorded here until you book it.</Note>
          <div className="row wrap g-2">
            <Button variant="primary" size="xl" className="grow" icon="check" loading={busy} disabled={busy} onClick={() => void book("CARD")}>
              Book the sale
            </Button>
            <Button variant="ghost" size="xl" disabled={busy} onClick={() => setPay("NONE")}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

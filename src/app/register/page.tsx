"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Icon, Button, Field, Input, MoneyInput, SearchInput, Badge, Card, Note,
  EmptyState, Skeleton, useToast,
} from "@/components/ui";
import { money, fmtTime, plural, dollarsToCents } from "@/lib/format";
import { ScanBurst, looksLikeProductBarcode } from "@/lib/scanner";
import { PrintAgent } from "@/components/PrintAgent";
import { taxFor, displayRate, normalizeTaxClass } from "@/lib/tax";
import { TZ } from "@/lib/time";
import { CashTender } from "@/components/register/CashTender";
import {
  newSaleKey, queueSale, queuedSales, removeQueuedSale, syncQueuedSales, isStuck,
  type QueuedSale,
} from "@/lib/offline";
import { isPickupCode } from "@/lib/pickupcode";

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

/** An online pre-order the vendor has packed and left at the counter. */
type Pickup = {
  id: string; number: number; customerName: string; customerPhone: string;
  vendorName: string; vendorCode: string;
  lines: { name: string; quantity: number }[];
  totalCents: number; readyAt: string | null;
};
type Receipt = {
  id: string; number: number; employee: string; totalCents: number;
  cashTenderedCents?: number; changeCents?: number; paymentMethod: string;
  /** Rung with no connection: it has no ticket number until it syncs. */
  offline?: boolean;
  /** "VISA 4242" when the card was taken on the reader. */
  cardName?: string;
};

/**
 * A card sitting on the reader, waiting for the customer.
 *
 * The money is taken before the sale is booked, so between these two moments
 * there is a payment with no ticket behind it. This is that moment, held in
 * one place so the screen can always say which of the two things is happening
 * and the cashier is never guessing.
 */
type Charge = {
  paymentIntentId: string;
  amountCents: number;
  state: "sending" | "waiting" | "succeeded" | "failed" | "booking";
  message: string;
  cardLabel: string;
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
  const [cardAdjustPercent, setCardAdjustPercent] = useState(0);

  /* Offline. `online` starts true rather than reading navigator.onLine, because
     that property is also false during the first paint on some browsers and a
     till that opens shouting "no connection" trains people to ignore it. */
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<QueuedSale[]>([]);
  const [syncing, setSyncing] = useState(false);

  const [pay, setPay] = useState<"NONE" | "CASH" | "CARD">("NONE");
  const [cardRef, setCardRef] = useState("");
  /* What the till has to work with. Both default to false so a register that
     can't reach the settings offers the manual path rather than a button that
     talks to hardware that isn't there. */
  const [readerReady, setReaderReady] = useState(false);
  const [printerReady, setPrinterReady] = useState(false);
  /* In direct mode this till is what actually reaches the printer, so it
     carries the receipts itself. See components/PrintAgent. */
  const [printDirect, setPrintDirect] = useState(false);
  const [printTrouble, setPrintTrouble] = useState("");
  const [charge, setCharge] = useState<Charge | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  /* A ticket a vendor rang up at their own booth and sent here for cash. It
     never enters the normal cart: re-pricing it against today's prices, or
     booking it under the cashier's name, are the two things the code exists to
     prevent. */
  /* Online pre-orders sitting at the counter, waiting for somebody to walk in
     for them. The till has to know about these: the customer has already paid,
     so there is nothing to ring up — the only job is finding the right bag and
     recording that it left. */
  const [pickups, setPickups] = useState<Pickup[]>([]);
  const [pickupQ, setPickupQ] = useState("");
  /* A scanned code, held up for the cashier to confirm before anything is
     recorded. The scan finds the bag; a person still checks the face. */
  const [scanned, setScanned] = useState<Pickup | null>(null);
  const [scannedErr, setScannedErr] = useState("");
  const [camOpen, setCamOpen] = useState(false);
  const camRef = useRef<{ stop: () => Promise<void>; clear: () => void } | null>(null);
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

  /* Dual pricing: the posted price is the CARD price, and cash skips the
     adjustment. The kiosk used to show one total and let the server add the
     adjustment afterwards, which meant a card customer was quoted one number
     and charged another. Computed here with the same function the server uses,
     surcharge included, so the two agree to the cent. */
  const cardAdjustCents = cardAdjustPercent > 0 ? Math.round((subtotal * cardAdjustPercent) / 100) : 0;
  const cardTaxCents = taxFor(taxLines, rates, cardAdjustCents).taxCents;
  const cardTotal = subtotal + cardAdjustCents + cardTaxCents;

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
    if (typeof d.cardAdjustPercent === "number") setCardAdjustPercent(d.cardAdjustPercent);
    setReaderReady(!!d.cardReaderReady);
    setPrinterReady(!!d.printerReady);
    setPrintDirect(d.printMode === "direct");
  }, []);

  /* Only ever the ready ones. A cashier has no use for an order the vendor
     hasn't packed yet, and showing it would invite handing over a bag that
     isn't there. */
  const loadPickups = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/orders?scope=ready");
      if (!r.ok) return;
      const d = await r.json();
      setPickups(Array.isArray(d.orders) ? d.orders : []);
    } catch { /* offline: the list just goes stale, which is harmless */ }
  }, []);

  useEffect(() => {
    if (!who) return;
    void loadDrawer();
    void loadFloor();
    void loadTax();
    void loadPickups();
  }, [who, loadDrawer, loadFloor, loadTax, loadPickups]);

  /* Vendors drop orders off through the day, so the till re-checks rather than
     waiting for somebody to reload the page. */
  useEffect(() => {
    if (!who) return;
    const t = window.setInterval(() => { void loadPickups(); }, 60_000);
    return () => window.clearInterval(t);
  }, [who, loadPickups]);

  /** Look a scanned or typed collection code up. Returns true if it found one. */
  const lookupPickup = useCallback(async (code: string): Promise<boolean> => {
    setScannedErr("");
    try {
      const r = await fetch(`/api/admin/orders?code=${encodeURIComponent(code)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setScannedErr(String(d.error || "No order with that code.")); return false; }
      setScanned(d.order as Pickup);
      return true;
    } catch {
      setScannedErr("No connection — the code couldn't be checked.");
      return false;
    }
  }, []);

  const stopCam = useCallback(async () => {
    try { await camRef.current?.stop(); camRef.current?.clear(); } catch { /* already stopped */ }
    camRef.current = null;
    setCamOpen(false);
  }, []);

  /* The camera, not a laser. A market till is an iPad, and a laser scanner
     can't read a phone screen at all — the beam needs ink on paper. The same
     camera scanner the self-checkout already uses reads a QR off a screen
     without complaint. */
  const startCam = async () => {
    setScannedErr("");
    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
      setCamOpen(true);
      await new Promise((r) => setTimeout(r, 80)); // let the video box render first
      const scanner = new Html5Qrcode("collect-scan-box", {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.CODE_128],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false,
      });
      camRef.current = scanner as unknown as { stop: () => Promise<void>; clear: () => void };
      let held = false;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 12, qrbox: (w: number) => ({ width: Math.min(300, Math.floor(w * 0.9)), height: Math.min(300, Math.floor(w * 0.9)) }), aspectRatio: 1 },
        (text) => {
          if (held) return;
          held = true;
          if (navigator.vibrate) navigator.vibrate(50);
          void lookupPickup(text.trim().toUpperCase()).then((ok) => {
            void stopCam();
            if (!ok) held = false;
          });
        },
        () => {}
      );
    } catch {
      setCamOpen(false);
      setScannedErr("Couldn't open the camera — allow camera access, or type the code instead.");
    }
  };

  /* Never leave the camera running behind a locked till. */
  useEffect(() => {
    if (!who && camRef.current) void stopCam();
  }, [who, stopCam]);

  const handOver = async (o: Pickup) => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/orders", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: o.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error("Couldn't record that", String(d.error || "Give it another go."));
      } else {
        toast.success(`#${o.number} handed over`, `${o.customerName} — ${o.vendorName}.`);
        setScanned(null);
      }
    } catch {
      toast.error("No connection", "Hand the bag over anyway and record it when the wifi is back.");
    } finally {
      setBusy(false);
      void loadPickups();
    }
  };

  /* ------------------------------------------------------------- offline -- */

  const refreshQueue = useCallback(async () => {
    try { setQueue(await queuedSales()); } catch { /* no IndexedDB: the badge just stays empty */ }
  }, []);

  /** Post everything waiting. Safe to call at any time — it no-ops when empty. */
  const drainQueue = useCallback(async (announce = false) => {
    setSyncing(true);
    try {
      const before = (await queuedSales()).length;
      if (!before) return;
      const r = await syncQueuedSales();
      await refreshQueue();
      if (r.posted > 0) {
        void loadDrawer();
        void loadFloor();
        toast.success(
          `${plural(r.posted, "offline sale")} synced`,
          "They're in the books and on the drawer count now."
        );
      } else if (announce && r.failed > 0) {
        toast.error("Couldn't sync yet", "The sales are still saved on this iPad — nothing is lost.");
      }
    } catch {
      /* Nothing to tell the cashier: the sales are still queued. */
    } finally {
      setSyncing(false);
    }
  }, [refreshQueue, loadDrawer, loadFloor, toast]);

  useEffect(() => { void refreshQueue(); }, [refreshQueue]);

  /* navigator.onLine only knows whether there is A network, not whether the
     server is reachable — a market wifi that's up but has no internet still
     reads as online. So it is treated as a hint that's worth retrying on, and
     the real signal is whether a POST succeeds. */
  useEffect(() => {
    const up = () => { setOnline(true); void drainQueue(); };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    if (typeof navigator !== "undefined" && navigator.onLine === false) setOnline(false);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, [drainQueue]);

  /* A quiet retry while the till sits idle, so a queue left over from a blip
     clears itself without anybody noticing it was there. */
  useEffect(() => {
    if (!who) return;
    const t = window.setInterval(() => { void drainQueue(); }, 45_000);
    return () => window.clearInterval(t);
  }, [who, drainQueue]);

  /* Keep the cursor in the scan box so a barcode scanner just works — it types
     and presses Enter, and it does not care what's focused. */
  useEffect(() => {
    if (who && drawer && !closing && !receipt && pay === "NONE") scanRef.current?.focus();
  }, [who, drawer, closing, receipt, pay, cart.length]);

  /* ------------------------------------------------------------- scanner --
     A USB barcode scanner is a keyboard as far as the tablet is concerned: it
     types the code and, USUALLY, presses something afterwards to say it's
     finished. Which something depends on how the scanner was programmed at the
     factory — Enter on most, Tab on plenty, and nothing at all on some.
     Waiting only for Enter means a scanner set to Tab, or set to no suffix,
     types the code into the box and sits there.

     So the code is taken three ways. Enter, Tab, and — for a scanner that
     sends no suffix at all — the fact that it typed far faster than hands can.
     A scan arrives in a few milliseconds a character; the fastest person at
     the counter is an order of magnitude slower. When a run of characters
     comes in at machine speed and then stops, that's a finished scan, and it
     looks itself up without anybody pressing anything. */

  /** Quiet after the last character before a scan is taken as complete. */
  const SCAN_IDLE_MS = 180;

  const burstRef = useRef(new ScanBurst());
  const scanTimerRef = useRef<number | null>(null);

  const onScanChange = (value: string) => {
    setScan(value);
    if (scanTimerRef.current) { window.clearTimeout(scanTimerRef.current); scanTimerRef.current = null; }
    if (burstRef.current.see(value, Date.now())) {
      const snapshot = value;
      scanTimerRef.current = window.setTimeout(() => {
        scanTimerRef.current = null;
        void doScan(snapshot);
      }, SCAN_IDLE_MS);
    }
  };

  /* A pending scan must not fire into a screen that has moved on. */
  useEffect(() => {
    return () => { if (scanTimerRef.current) window.clearTimeout(scanTimerRef.current); };
  }, []);

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

  const doScan = async (raw?: string) => {
    /* The value is passed in when a scanner triggered this, because the timer
       that fires it was created a keystroke ago and the state it captured is
       already stale. Typed entry has no such problem and passes nothing. */
    const code = (raw ?? scan).trim().toUpperCase();
    if (scanTimerRef.current) { window.clearTimeout(scanTimerRef.current); scanTimerRef.current = null; }
    burstRef.current.reset();
    setScan("");
    if (!code) return;
    /* Checked before anything else. A collection code can't collide with a SKU
       — it always starts CH- and a SKU never does — and a cashier who scans one
       into the ring-up box means "find this order", not "sell me something". */
    if (isPickupCode(code)) { setScanErr(""); await lookupPickup(code); return; }
    const inCart = cart.find((l) => l.sku === code);
    if (inCart) { addItem({ id: inCart.itemId, sku: inCart.sku, name: inCart.name, priceCents: inCart.priceCents, basePriceCents: inCart.basePriceCents, vendorName: inCart.vendorName, taxClass: inCart.taxClass }); return; }
    const onFloor = floor.find((i) => i.sku === code);
    if (onFloor) { addItem(onFloor); return; }
    try {
      const res = await fetch(`/api/admin/lookup?sku=${encodeURIComponent(code)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        /* A plain run of digits is almost always the manufacturer's own
           barcode off the packaging rather than a code from this market, and
           saying so turns "nothing found" into something fixable. */
        const looksLikeUpc = looksLikeProductBarcode(code);
        setScanErr(
          String(data.error || `Nothing found for ${code}.`) +
            (looksLikeUpc ? ` That's the maker's own barcode — to scan these, set the item's code to ${code}.` : "")
        );
        return;
      }
      addItem({ id: data.item.id, sku: data.item.sku, name: data.item.name, priceCents: data.item.priceCents, basePriceCents: data.item.basePriceCents, vendorName: data.item.vendor.businessName, taxClass: data.item.taxClass });
    } catch {
      // Raw fetch in the original register threw into nothing on a dropped
      // connection, so a scan during a wifi blip just did nothing at all.
      setScanErr("No connection — the item couldn't be looked up.");
    }
  };

  /* -------------------------------------------------------------- drawer -- */

  const openDrawer = async () => {
    /* Opening and closing a drawer are server-side records that the offline
       queue deliberately does NOT cover: a float counted into a till that the
       books never heard of is how a shift ends up unreconcilable. Selling is
       the thing worth saving offline; bookkeeping can wait for the wifi. */
    if (!online) {
      toast.error("No connection", "The drawer can't be opened until the wifi is back. Sales still work.");
      return;
    }
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
    if (!online) {
      toast.error("No connection", "Count out once the wifi is back, so the offline sales are counted in.");
      return;
    }
    if (queue.length) {
      toast.error(
        `${plural(queue.length, "sale")} hasn't synced`,
        "Those aren't in the expected total yet. Sync first, or the drawer will look over."
      );
      return;
    }
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

  /**
   * Save a sale on this device because the server couldn't be reached.
   *
   * The customer is standing there with their money out, so this never refuses:
   * the worst case is that the ticket reaches the books a few minutes late.
   * Totals are computed here with the same library the server uses, which is
   * what makes the change handed over now match the receipt printed later.
   */
  const bookOffline = async (method: "CASH" | "CARD", tenderedCents: number, key: string): Promise<boolean> => {
    const dueCents = method === "CARD" ? cardTotal : total;
    try {
      await queueSale({
        key,
        createdAtIso: new Date().toISOString(),
        employee: who || "",
        paymentMethod: method,
        cardName: method === "CARD" ? cardRef : "",
        cashTenderedCents: method === "CASH" ? tenderedCents : 0,
        totalCents: dueCents,
        changeCents: method === "CASH" && tenderedCents > 0 ? Math.max(0, tenderedCents - dueCents) : 0,
        lines: cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity, name: l.name, priceCents: l.priceCents })),
      });
      await refreshQueue();
      setOnline(false);
      setReceipt({
        id: key,
        number: 0,
        employee: who || "",
        totalCents: dueCents,
        cashTenderedCents: method === "CASH" ? tenderedCents : 0,
        changeCents: method === "CASH" && tenderedCents > 0 ? Math.max(0, tenderedCents - dueCents) : 0,
        paymentMethod: method,
        offline: true,
      });
      setCart([]); setPay("NONE"); setCardRef("");
      return true;
    } catch {
      /* IndexedDB itself refused — private browsing, or a full disk. This is
         the one case where the cashier has to be told to write it down, and
         saying so plainly beats a spinner that never resolves. */
      setScanErr("No connection AND this device can't save the sale. Write the ticket down and ring it when the wifi is back.");
      setPay("NONE");
      return false;
    }
  };

  const book = async (
    method: "CASH" | "CARD",
    tenderedCents = 0,
    terminal?: { paymentIntentId: string; cardLabel: string }
  ) => {
    if (!cart.length) return;

    /* One key per ticket, minted BEFORE anything is sent and reused if this
       sale ends up in the offline queue — which is why it is declared out here
       rather than inside the try, where the catch below couldn't see it.

       It exists for the nastiest case: the server books the sale, the reply is
       lost on the way back, the till treats it as failed and posts it again
       later. Same key, same ticket, no second sale. */
    const key = newSaleKey();

    setBusy(true);
    try {
      /* Known to be offline: don't spend the customer's time on a fetch that
         will time out. Straight to the queue.

         A card already taken on the reader never goes down this path. That
         money exists on the server whatever this tablet thinks, and a queued
         copy would be priced again on the way in — the one case where the
         ticket could end up disagreeing with what was charged. */
      if (!online && !terminal) { await bookOffline(method, tenderedCents, key); return; }

      const r = await fetch("/api/admin/sale", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethod: method,
          cardName: method === "CARD" ? (terminal?.cardLabel || cardRef) : "",
          cashTenderedCents: method === "CASH" ? tenderedCents : 0,
          lines: cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
          idemKey: key,
          ...(terminal ? { terminalPaymentIntentId: terminal.paymentIntentId } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        /* The card went through and the ticket didn't. Say so plainly and
           leave the charge on screen: pressing Finish again books it, because
           the payment is what the server matches on. Clearing it here is what
           would lose the sale. */
        if (terminal) {
          setCharge((c) => (c ? { ...c, state: "succeeded", message: String(d.error || "The sale didn't save — press Finish to try again.") } : c));
          return;
        }
        setScanErr(String(d.error || "Sale failed.")); setPay("NONE"); return;
      }
      setReceipt({ ...(d.sale as Receipt), paymentMethod: method, cardName: terminal?.cardLabel || "" });
      setCart([]); setPay("NONE"); setCardRef(""); setCharge(null);
      chargeKeyRef.current = "";
      void loadDrawer(); void loadFloor();
    } catch {
      if (terminal) {
        setCharge((c) => (c ? { ...c, state: "succeeded", message: "Couldn't reach the server. The card WAS charged — press Finish to save the ticket." } : c));
        return;
      }
      /* The fetch failed. It may never have reached the server, or it may have
         been booked and the reply lost — there is no way to tell from here. The
         sale is queued either way, carrying the key it was sent with, and the
         server sorts it out: a sale that did commit is returned as-is instead
         of being rung twice. */
      await bookOffline(method, tenderedCents, key);
    } finally { setBusy(false); }
  };

  /* --------------------------------------------------------- the reader -- */

  /**
   * Put the total on the card reader and wait for the customer.
   *
   * Written as one straight-through function rather than a state machine
   * driven by effects, because that is how it reads at the counter: send it,
   * watch it, book it. The cashier can cancel at any point and the flag below
   * is what stops the watching.
   */
  const chargeKeyRef = useRef("");
  const abandonRef = useRef(false);

  const watchCharge = async (paymentIntentId: string) => {
    /* Three minutes is longer than any customer takes and shorter than a
       reader left showing a total nobody is paying. */
    const until = Date.now() + 3 * 60 * 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1200));
      if (abandonRef.current) return;
      let d: { state?: string; message?: string; cardLabel?: string; error?: string } = {};
      try {
        const r = await fetch(`/api/admin/terminal/charge?pi=${encodeURIComponent(paymentIntentId)}`);
        d = await r.json().catch(() => ({}));
      } catch {
        /* A dropped poll is not a dropped payment — the reader is talking to
           Stripe, not to this tablet. Keep asking. */
        continue;
      }
      if (abandonRef.current) return;

      if (d.state === "succeeded") {
        setCharge((c) => (c ? { ...c, state: "booking", cardLabel: d.cardLabel || "", message: "Approved — saving the ticket." } : c));
        await book("CARD", 0, { paymentIntentId, cardLabel: d.cardLabel || "" });
        return;
      }
      if (d.state === "failed") {
        setCharge((c) => (c ? { ...c, state: "failed", message: d.message || "The card was declined." } : c));
        return;
      }
      if (d.state === "canceled") { setCharge(null); return; }
      if (d.message) setCharge((c) => (c ? { ...c, message: d.message as string } : c));
    }
    setCharge((c) => (c ? { ...c, state: "failed", message: "The reader didn't answer. Cancel and try again." } : c));
  };

  const startCharge = async () => {
    if (!cart.length) return;
    abandonRef.current = false;
    /* One key per attempt, so a tablet that loses its answer and retries asks
       the reader for the SAME payment rather than a second one. */
    if (!chargeKeyRef.current) chargeKeyRef.current = newSaleKey();
    setCharge({ paymentIntentId: "", amountCents: cardTotal, state: "sending", message: "Sending it to the reader…", cardLabel: "" });
    try {
      const r = await fetch("/api/admin/terminal/charge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
          idemKey: chargeKeyRef.current,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setCharge({ paymentIntentId: "", amountCents: cardTotal, state: "failed", message: String(d.error || "Couldn't start that payment."), cardLabel: "" }); return; }
      setCharge({ paymentIntentId: d.paymentIntentId, amountCents: d.amountCents ?? cardTotal, state: "waiting", message: "Ask them to tap, insert or swipe.", cardLabel: "" });
      await watchCharge(d.paymentIntentId);
    } catch {
      setCharge({ paymentIntentId: "", amountCents: cardTotal, state: "failed", message: "No connection — the card was NOT charged.", cardLabel: "" });
    }
  };

  const cancelCharge = async () => {
    abandonRef.current = true;
    const pi = charge?.paymentIntentId;
    setCharge(null);
    chargeKeyRef.current = "";
    if (pi) {
      /* Clear the reader's screen too. A reader still showing a total is the
         next customer's confusion. */
      try { await fetch(`/api/admin/terminal/charge?pi=${encodeURIComponent(pi)}`, { method: "DELETE" }); } catch {}
    }
  };

  /* ----------------------------------------------------- paper and drawer -- */

  /** Open the till without a sale. Always written down, never blocked. */
  const popDrawer = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/print", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "drawer" }),
      });
      const d = await r.json().catch(() => ({}));
      setScanErr(r.ok ? "" : String(d.error || "Couldn't open the drawer."));
    } catch {
      setScanErr("No connection — the drawer stays shut.");
    } finally { setBusy(false); }
  };

  /** Another copy of a receipt, marked as a copy. */
  const printAgain = async (saleId: string) => {
    if (!printerReady) { await printReceipt(saleId); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/admin/print", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reprint", saleId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setScanErr(String(d.error || "Couldn't send that to the printer."));
    } catch {
      setScanErr("No connection — couldn't send that to the printer.");
    } finally { setBusy(false); }
  };

  /* ------------------------------------------------- vendor booth tickets -- */

  const findVendorTicket = async () => {
    const code = vtCode.trim().toUpperCase();
    if (!code) return;
    if (!online) {
      setVtErr("Booth tickets are looked up on the server — this one needs a connection.");
      return;
    }
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
      {/* Runs wherever the till is on screen, including the lock screen and
          the receipt screen: a receipt rung a minute ago must not wait on
          somebody navigating back to the sell view. */}
      <PrintAgent
        active={printDirect && printerReady && !!who}
        onStatus={(s) => setPrintTrouble(s.trouble)}
      />
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
        {!online ? <Badge tone="danger" dot>Offline</Badge> : null}
        {printTrouble ? <Badge tone="warn" dot>Printer</Badge> : null}
        {pickups.length ? (
          <Badge tone="info" dot>{plural(pickups.length, "order")} to collect</Badge>
        ) : null}
        {queue.length ? (
          <Badge tone={queue.some(isStuck) ? "danger" : "warn"} dot>
            {plural(queue.length, "sale")} waiting to sync
          </Badge>
        ) : null}
      </div>
      <div className="row wrap g-2">
        {/* No sale. It pops the till without ringing anything, which is what
            you need for change and a miskey — and it goes in the log with a
            name on it every single time. */}
        {drawer && !closing && printerReady ? (
          <Button size="sm" variant="ghost" icon="cash" disabled={busy} onClick={() => void popDrawer()}>
            No sale
          </Button>
        ) : null}
        {drawer && !closing ? (
          <Button size="sm" variant="secondary" icon="lock" onClick={() => setClosing(true)}>
            Close drawer
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" icon="logout" onClick={() => void lock()}>Lock</Button>
      </div>
    </div>
  );

  /* Shown wherever the till is being used, not just on the sell screen: the
     one thing a cashier must never wonder about is whether the sale they just
     took is actually recorded anywhere. */
  const offlineBanner =
    !online || queue.length ? (
      <div
        className="card card-pad stack g-2"
        style={{
          background: online ? "var(--warn-soft, var(--bg-sunken))" : "var(--danger-soft, var(--bg-sunken))",
          borderColor: online ? "var(--warn-border, var(--border-subtle))" : "var(--danger-border, var(--border-subtle))",
        }}
        aria-live="polite"
      >
        <div className="row wrap g-2" style={{ alignItems: "center", justifyContent: "space-between" }}>
          <div className="stack g-1">
            <span style={{ fontWeight: 700 }}>
              {!online ? "No connection — still taking sales" : `${plural(queue.length, "sale")} waiting to sync`}
            </span>
            <span className="t-sm">
              {!online
                ? "Sales are being saved on this device and will post themselves when the wifi is back. Card sales still need running on the terminal."
                : "They're saved here and haven't reached the books yet."}
            </span>
          </div>
          {queue.length ? (
            <Button size="sm" variant="secondary" icon="refresh" loading={syncing} disabled={syncing} onClick={() => void drainQueue(true)}>
              Sync now
            </Button>
          ) : null}
        </div>

        {queue.length ? (
          <div className="stack g-1" style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--sp-2)" }}>
            {queue.slice(0, 6).map((q) => (
              <div key={q.key} className="row g-2" style={{ alignItems: "center" }}>
                <span className="t-xs t-muted">{fmtTime(q.createdAtIso)}</span>
                <span className="grow truncate t-sm">
                  {plural(q.lines.reduce((n, l) => n + l.quantity, 0), "item")} · {q.paymentMethod === "CASH" ? "cash" : "card"}
                </span>
                <span className="num t-sm">{money(q.totalCents)}</span>
                {isStuck(q) ? <Badge tone="danger">Needs a look</Badge> : null}
              </div>
            ))}
            {queue.length > 6 ? <span className="t-xs t-muted">and {queue.length - 6} more</span> : null}
          </div>
        ) : null}

        {queue.some(isStuck) ? (
          <Note tone="error" title="Some sales won't post">
            {queue.filter(isStuck).map((q) => q.lastError).find(Boolean) || "The server keeps rejecting them."}{" "}
            Nothing has been lost — show this screen to whoever runs the market.
          </Note>
        ) : null}
      </div>
    ) : null;

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
        {offlineBanner}
        <Card
          title={receipt.offline ? "Saved on this device" : `Sale #${receipt.number}`}
          subtitle={receipt.offline ? "Take the money — it posts itself when the connection is back." : "Done — hand over the receipt."}
        >
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
              {/* A printed receipt is built from the booked sale, which doesn't
                  exist yet for an offline ticket. Rather than print something
                  that can't be looked up later, say so. */}
              {receipt.offline ? null : (
                <Button variant="secondary" size="xl" icon="print" disabled={busy} onClick={() => void printAgain(receipt.id)}>
                  Print again
                </Button>
              )}
            </div>
            {receipt.cardName ? (
              <span className="t-xs t-muted">Paid by card — {receipt.cardName}</span>
            ) : null}
            {printerReady && !receipt.offline ? (
              /* The receipt is already on its way out; this line is here so a
                 cashier waiting a second for paper knows it's coming rather
                 than pressing print and getting two. */
              <span className="t-xs t-muted">The receipt is printing itself.</span>
            ) : null}
            {receipt.offline ? (
              <Note tone="warn">
                No ticket number and no printed receipt until this syncs. If the customer needs paper, write the
                total down — the sale itself is safe on this device.
              </Note>
            ) : null}
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
  /* A scanned order takes over the screen, for the same reason a booth ticket
     does: it is already paid and already priced, and the only decision left is
     whether the person in front of you is the person on the order. That
     decision deserves the whole screen, not a row in a list. */
  if (scanned) {
    return shell(
      <>
        {header}
        <Card
          title={scanned.customerName}
          subtitle={`Order #${scanned.number} · ${scanned.vendorName}`}
          actions={<Button size="sm" variant="ghost" onClick={() => { setScanned(null); setScannedErr(""); }}>Back</Button>}
        >
          <div className="stack g-4">
            <Note tone="success" title="Code checks out">
              Paid in full online — {money(scanned.totalCents)}. Take no money.
            </Note>

            <div className="stack g-2">
              {scanned.lines.map((l, idx) => (
                <div key={`${l.name}-${idx}`} className="row g-3" style={{ alignItems: "center" }}>
                  <span className="grow truncate">{l.quantity}× {l.name}</span>
                </div>
              ))}
            </div>

            <div className="stack g-1">
              <span className="t-sm t-muted">
                {scanned.readyAt ? `Dropped off ${fmtTime(scanned.readyAt)}` : "Marked ready"}
                {scanned.customerPhone ? ` · ${scanned.customerPhone}` : ""}
              </span>
              <span className="t-sm t-muted">Check the name matches before you hand it over.</span>
            </div>

            <Button size="xl" block variant="primary" icon="check" loading={busy} disabled={busy} onClick={() => void handOver(scanned)}>
              Hand it over
            </Button>
          </div>
        </Card>
      </>
    );
  }

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
      {offlineBanner}

      {/* Collections come first on the screen because they come first at the
          counter: somebody standing there for a paid order is not queuing to
          buy anything, and making them wait behind a ring-up is the fastest
          way to make online ordering feel worse than just turning up. Hidden
          entirely when there's nothing waiting — a permanent empty panel on a
          till is noise. */}
      {pay === "NONE" && (pickups.length > 0 || camOpen || scannedErr) ? (
        <Card
          title="Ready to collect"
          subtitle="Already paid online. Scan their code, or find them by name."
          actions={
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => void loadPickups()}>
              Refresh
            </Button>
          }
        >
          <div className="stack g-3">
            {camOpen ? (
              <div className="stack g-2">
                <div
                  id="collect-scan-box"
                  style={{ width: "100%", maxWidth: 380, margin: "0 auto", borderRadius: "var(--r-lg)", overflow: "hidden", background: "#000" }}
                />
                <Button size="lg" variant="secondary" block onClick={() => void stopCam()}>Stop scanning</Button>
              </div>
            ) : (
              <Button size="lg" variant="primary" block icon="search" onClick={() => void startCam()}>
                Scan their code
              </Button>
            )}

            {scannedErr ? <Note tone="error">{scannedErr}</Note> : null}
            {pickups.length > 4 ? (
              <Field label="Find it">
                {(p) => (
                  <SearchInput
                    {...p}
                    value={pickupQ}
                    onValueChange={setPickupQ}
                    placeholder="name or order number"
                    aria-label="Search orders waiting for collection"
                  />
                )}
              </Field>
            ) : null}

            {(() => {
              if (pickups.length === 0) return null;
              const q = pickupQ.trim().toLowerCase();
              const shown = q
                ? pickups.filter(
                    (o) =>
                      o.customerName.toLowerCase().includes(q) ||
                      String(o.number).includes(q) ||
                      o.vendorName.toLowerCase().includes(q)
                  )
                : pickups;

              if (shown.length === 0) {
                return <EmptyState icon="search" title="No match" body="Try their surname, or the number on their email." />;
              }

              return shown.map((o) => (
                <div
                  key={o.id}
                  className="row wrap g-3"
                  style={{
                    alignItems: "center",
                    padding: "var(--sp-3)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-lg)",
                  }}
                >
                  <div className="stack g-1 grow" style={{ minWidth: 200 }}>
                    <span className="row g-2" style={{ alignItems: "baseline" }}>
                      <b style={{ fontSize: "var(--fs-lg)" }}>{o.customerName}</b>
                      <span className="t-sm t-muted num">#{o.number}</span>
                    </span>
                    <span className="t-sm t-muted truncate">
                      {o.vendorName} · {o.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ")}
                    </span>
                    <span className="t-xs t-muted">
                      {o.readyAt ? `Dropped off ${fmtTime(o.readyAt)}` : "Ready"} · paid {money(o.totalCents)}
                      {o.customerPhone ? ` · ${o.customerPhone}` : ""}
                    </span>
                  </div>
                  <Button
                    size="lg"
                    variant="primary"
                    icon="check"
                    disabled={busy}
                    onClick={() => void handOver(o)}
                  >
                    Handed over
                  </Button>
                </div>
              ));
            })()}

            {pickups.length > 0 ? (
              <Note tone="info">
                Nothing to ring up — these are paid in full. Take no money at the counter.
              </Note>
            ) : null}
          </div>
        </Card>
      ) : null}

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
            <Field label="Scan a barcode, or type a code and press Enter" error={scanErr || undefined}>
              {(p) => (
                <Input
                  {...p}
                  ref={scanRef}
                  className="mono"
                  value={scan}
                  autoComplete="off"
                  placeholder="V01-0001"
                  style={{ height: 64, fontSize: "var(--fs-xl)", letterSpacing: "0.04em" }}
                  onChange={(e) => onScanChange(e.target.value)}
                  onKeyDown={(e) => {
                    /* Enter and Tab both mean "that's the whole code" — which
                       one you get depends on how the scanner was programmed.
                       Tab would otherwise move the cursor out of the box and
                       the next scan would go nowhere, so it is swallowed. */
                    if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      void doScan();
                    }
                  }}
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
                <Button variant="dark" size="xl" block icon="card" disabled={busy} onClick={() => setPay("CARD")}>
                  Card{cardAdjustCents > 0 ? ` ${money(cardTotal)}` : ""}
                </Button>
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
            <span className="display num" style={{ fontSize: "var(--fs-4xl)" }}>{money(cardTotal)}</span>
            {cardAdjustCents > 0 ? (
              <span className="t-xs t-muted">
                {money(total)} cash price + {money(cardAdjustCents)} non-cash adjustment, tax included
              </span>
            ) : null}
          </div>
          {readerReady ? (
            charge ? (
              <>
                {charge.state === "failed" ? (
                  <Note tone="error" title="Not paid">{charge.message}</Note>
                ) : (
                  <Note tone={charge.state === "booking" ? "success" : "info"} title={
                    charge.state === "sending" ? "Sending…"
                      : charge.state === "booking" ? "Approved"
                      : "On the reader now"
                  }>
                    {charge.message}
                    {charge.cardLabel ? ` (${charge.cardLabel})` : ""}
                  </Note>
                )}
                <div className="row wrap g-2">
                  {charge.state === "failed" ? (
                    <>
                      <Button variant="primary" size="xl" className="grow" icon="card" disabled={busy} onClick={() => void startCharge()}>
                        Try the card again
                      </Button>
                      <Button variant="ghost" size="xl" disabled={busy} onClick={() => { void cancelCharge(); setPay("NONE"); }}>
                        Cancel
                      </Button>
                    </>
                  ) : charge.state === "succeeded" ? (
                    /* Paid, but the ticket didn't save. The only button that
                       matters is the one that tries again. */
                    <Button variant="primary" size="xl" className="grow" icon="check" loading={busy} disabled={busy}
                      onClick={() => void book("CARD", 0, { paymentIntentId: charge.paymentIntentId, cardLabel: charge.cardLabel })}>
                      Finish the sale
                    </Button>
                  ) : (
                    <Button variant="ghost" size="xl" className="grow" disabled={charge.state === "booking"} onClick={() => { void cancelCharge(); setPay("NONE"); }}>
                      Cancel the payment
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <>
                <Note tone="info">The reader will ask for the card. Nothing is charged until they tap.</Note>
                <div className="row wrap g-2">
                  <Button variant="primary" size="xl" className="grow" icon="card" loading={busy} disabled={busy} onClick={() => void startCharge()}>
                    Send {money(cardTotal)} to the reader
                  </Button>
                  <Button variant="ghost" size="xl" disabled={busy} onClick={() => setPay("NONE")}>Cancel</Button>
                </div>
              </>
            )
          ) : (
            <>
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
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

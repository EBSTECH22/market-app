"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Icon, Button, Field, Input, MoneyInput, SearchInput, Badge, Card, Note,
  EmptyState, Skeleton, useToast,
} from "@/components/ui";
import { money, fmtTime, plural, dollarsToCents } from "@/lib/format";
import { ScanBurst, looksLikeProductBarcode } from "@/lib/scanner";
import { WedgeTiming, isTerminator, readCode } from "@/lib/wedge";
import { PrintAgent, deliverJob, markTillDevice } from "@/components/PrintAgent";
import { taxFor, displayRate, normalizeTaxClass } from "@/lib/tax";
import { TZ } from "@/lib/time";
import { CashTender } from "@/components/register/CashTender";
import {
  newSaleKey, queueSale, queuedSales, removeQueuedSale, syncQueuedSales, isStuck,
  type QueuedSale,
} from "@/lib/offline";
import { isPickupCode } from "@/lib/pickupcode";
import { tagCents, cardUpliftCents } from "@/lib/cardprice";

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
/** A card the reader charged whose ticket never saved. */
type Unbooked = { paymentIntentId: string; amountCents: number; employee: string; createdAt: string; cardLabel: string };
type PrintNowReply = { printNow?: { job?: { id: string; body: string }; host?: string; devid?: string } | null };
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
  /* The line just rung, highlighted and scrolled into view like a real till. */
  const [lastSku, setLastSku] = useState("");
  /* Right-hand pane: selling, pre-order pickups, or a vendor's booth ticket. */
  const [tab, setTab] = useState<"items" | "pickups" | "booth">("items");
  /* The on-screen keyboard is OFF for the scan box — the scanner is the
     keyboard, and the tablet's keyboard would cover the ticket. This turns it
     on for typing a name or code by hand. */
  const [kb, setKb] = useState(false);
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
  /* Cards charged on the reader that never got a ticket — see loadUnbooked. */
  const [unbooked, setUnbooked] = useState<Unbooked[]>([]);

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
  /* Catches the scanner on the receipt screen, so the next customer's first
     scan starts their ticket instead of vanishing. */
  const nextScanRef = useRef<HTMLInputElement>(null);
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
  /* The tag price is the vendor's price plus the card percentage, per item —
     the number on the shelf label. Card pays the tags; cash gets the
     percentage back. Same function the server uses (lib/cardprice). */
  const tag = (cents: number) => tagCents(cents, cardAdjustPercent);
  const cardAdjustCents = cardUpliftCents(cart, cardAdjustPercent);
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
    /* Items only. The full overview also adds up the month's takings, which
       the till never shows and which got slower to fetch every day. */
    const r = await fetch("/api/admin/overview?only=floor");
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

  /* A card that was charged but whose ticket never saved — the tablet was
     closed, the wifi dropped, or the page reloaded right after "Approved".
     The money is taken; this puts it back in front of the cashier. */
  const loadUnbooked = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/terminal/charge?unbooked=1");
      if (!r.ok) return;
      const d = await r.json();
      setUnbooked(Array.isArray(d.unbooked) ? d.unbooked : []);
    } catch { /* offline: try again on the next round */ }
  }, []);

  useEffect(() => {
    if (!who) return;
    void loadDrawer();
    void loadFloor();
    void loadTax();
    void loadPickups();
  }, [who, loadDrawer, loadFloor, loadTax, loadPickups]);

  useEffect(() => {
    if (who && readerReady) void loadUnbooked();
  }, [who, readerReady, loadUnbooked]);

  /* Vendors drop orders off through the day, so the till re-checks rather than
     waiting for somebody to reload the page. */
  useEffect(() => {
    if (!who) return;
    const t = window.setInterval(() => {
      void loadPickups();
      if (readerReady) void loadUnbooked();
    }, 60_000);
    return () => window.clearInterval(t);
  }, [who, loadPickups, readerReady, loadUnbooked]);

  /** Put a receipt/drawer job the server handed back straight on the printer. */
  const sendToPrinter = useCallback((d: PrintNowReply) => {
    const p = d?.printNow;
    if (!p?.job?.id || !p.host) return;
    void deliverJob(p.job, p.host, p.devid).then(({ ok, trouble }) => setPrintTrouble(ok ? "" : trouble));
  }, []);

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

  /* This device is the till: it's the one that carries receipts to the printer. */
  useEffect(() => { markTillDevice(); }, []);

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

  useEffect(() => {
    if (receipt) nextScanRef.current?.focus();
  }, [receipt]);

  /* ------------------------------------------------------- the whole page --
     The scanner types into whatever has the cursor, and most of them finish
     with Tab — which MOVES the cursor. So the first scan lands in the scan box
     and the cursor leaves, and the next one goes into the search box, or the
     cash box, or nowhere. Watching one input cannot fix that.

     So the page watches instead. Every keystroke is collected, anywhere, and
     judged afterwards on speed: a scanner is twenty times faster than hands,
     so a burst that fast is a barcode no matter where it was aimed. Anything
     slower is left completely alone, and typing behaves exactly as before.

     Whatever field caught the characters gets cleared afterwards, because they
     went in there too — that is why a scan used to leave its code sitting in
     the search box. */
  const wedgeRef = useRef(new WedgeTiming());
  /* A readout of what the scanner listener is actually seeing, shown only when
     the address ends in ?probe=1. Three fixes for this scanner have missed
     because I was reasoning about what the tablet probably does instead of
     looking, so the till can now say so itself. */
  const [probe, setProbe] = useState("");
  const probeOn = typeof window !== "undefined" && window.location.search.includes("probe=1");
  /* doScan is rebuilt every render and reads the current cart and floor. The
     listener below is installed once, so it must reach the CURRENT one — a
     captured copy would ring up against the cart as it was when the till
     opened. */
  const doScanRef = useRef<(raw?: string) => Promise<void>>(async () => {});

  const wedgeScan = useCallback(() => {
    /* Read the code out of whichever box caught it, rather than rebuilding it
       from keystrokes — on this tablet some characters arrive with no
       character attached at all. See lib/wedge. */
    const code = readCode(document.activeElement, scanRef.current || nextScanRef.current);
    if (probeOn) setProbe((p) => `${p}  ->  FIRED code="${code}"`);
    wedgeRef.current.reset();
    if (nextScanRef.current) nextScanRef.current.value = "";
    if (!code) return;

    /* Scanned on the receipt screen: that's the next customer. Close the
       receipt and ring it up, rather than making the cashier tap "Next
       customer" first and scan again. */
    setReceipt(null);

    /* The characters went into a real field, so clear both candidates, put the
       cursor back where it belongs, and ring it up. */
    setScan("");
    setSearch("");
    burstRef.current.reset();
    if (scanTimerRef.current) { window.clearTimeout(scanTimerRef.current); scanTimerRef.current = null; }
    scanRef.current?.focus();
    void doScanRef.current(code);
  }, []);

  useEffect(() => {
    /* Only while a till is actually open and selling. Nobody wants a stray
       keystroke ringing something up on the count-out screen. */
    if (!who || !drawer || closing) return;

    const onKey = (e: KeyboardEvent) => {
      if (probeOn) {
        const el = document.activeElement as HTMLInputElement | null;
        setProbe(
          `key=${e.key} keys=${wedgeRef.current.keys} machine=${wedgeRef.current.looksMachine()} ` +
            `term=${isTerminator(e.key)} focus=${el?.tagName || "?"}:${(el?.value ?? "").slice(0, 20)}`
        );
      }
      if (isTerminator(e.key) && wedgeRef.current.looksMachine()) {
        /* Swallow it. An arrow key that reaches Android moves the cursor to
           the next field, which is what sent every scan after the first one
           into the search box. */
        e.preventDefault();
        e.stopPropagation();
        wedgeScan();
        return;
      }
      /* Every keystroke counts towards the timing, named or not. */
      wedgeRef.current.tick(Date.now());
    };

    window.addEventListener("keydown", onKey, true);

    /* For a scanner sending no finishing key: the code is complete once the
       keystrokes stop. */
    const sweep = window.setInterval(() => {
      if (wedgeRef.current.settled(Date.now(), 170)) wedgeScan();
    }, 80);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearInterval(sweep);
    };
  }, [who, drawer, closing, wedgeScan, probeOn]);

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
    setLastSku(i.sku);
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
    /* Not while a card is on the reader. The reader was sent the total for
       the ticket as it stood; an item scanned now would sit on screen, never
       be charged, and walk out with the customer when the ticket clears. */
    if (pay === "CARD") {
      toast.error("Finish the card first", `${code} isn't on this payment. Cancel the card to add it.`);
      return;
    }
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

  doScanRef.current = doScan;

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
            `<div style="display:flex;justify-content:space-between"><span>${l.quantity}x ${String(l.name).slice(0, 26)}</span><span>${money(tag(l.basePriceCents || l.priceCents) * l.quantity)}</span></div>`).join("")}
        </div>
        <div style="border-top:1px dashed #000;margin-top:4px;padding-top:4px;text-align:left">
          ${(() => {
            const ls = sale.lines as { quantity: number; priceCents: number; basePriceCents?: number }[];
            const tagBase = ls.reduce((n, l) => n + tag(l.basePriceCents || l.priceCents) * l.quantity, 0);
            const tagPaid = ls.reduce((n, l) => n + tag(l.priceCents) * l.quantity, 0);
            const row = (a: string, b: string) => `<div style="display:flex;justify-content:space-between"><span>${a}</span><span>${b}</span></div>`;
            return row("SUBTOTAL", money(tagBase))
              + (tagBase > tagPaid ? row("SALE SAVINGS", `-${money(tagBase - tagPaid)}`) : "")
              + (sale.paymentMethod === "CASH" && tagPaid > sale.subtotalCents ? row("CASH DISCOUNT", `-${money(tagPaid - sale.subtotalCents)}`) : "");
          })()}
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
          printHere: true,
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
      /* Straight onto the printer, before anything else happens on screen.
         Not awaited: the cashier gets the receipt screen now and the paper
         and the drawer follow a beat later, rather than the screen waiting on
         the printer. If it fails it is already in the queue and the agent
         above prints it. */
      sendToPrinter(d);
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
    if (pi) {
      /* Wait for the answer. The customer may have tapped at the same moment,
         and a payment that went through must be SAVED, not cleared off the
         screen — clearing it is how a card got charged with no ticket. */
      setBusy(true);
      try {
        const r = await fetch(`/api/admin/terminal/charge?pi=${encodeURIComponent(pi)}`, { method: "DELETE" });
        const d = await r.json().catch(() => ({}));
        if (r.status === 409 && d.state === "succeeded") {
          setCharge((c) => ({
            paymentIntentId: pi,
            amountCents: c?.amountCents ?? cardTotal,
            state: "succeeded",
            message: String(d.error || "The card went through. Save the ticket."),
            cardLabel: String(d.cardLabel || ""),
          }));
          return;
        }
      } catch {
        /* No answer. If it did go through, the unbooked check brings it back. */
      } finally {
        setBusy(false);
      }
    }
    setCharge(null);
    chargeKeyRef.current = "";
    setPay("NONE");
  };

  /** Save the ticket for a card that was charged but never booked. */
  const saveUnbooked = async (u: Unbooked) => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/sale", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethod: "CARD",
          cardName: u.cardLabel,
          lines: [],
          idemKey: newSaleKey(),
          printHere: true,
          terminalPaymentIntentId: u.paymentIntentId,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't save that ticket", String(d.error || "Try again in a moment.")); return; }
      sendToPrinter(d);
      toast.success(`Sale #${d.sale?.number ?? ""} saved`, `${money(u.amountCents)} on ${u.cardLabel || "the card"}.`);
      void loadDrawer(); void loadFloor();
    } catch {
      toast.error("No connection", "The card payment is safe — save the ticket when the wifi is back.");
    } finally {
      setBusy(false);
      void loadUnbooked();
    }
  };

  /* ----------------------------------------------------- paper and drawer -- */

  /** Open the till without a sale. Always written down, never blocked. */
  const popDrawer = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/print", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "drawer", printHere: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) sendToPrinter(d);
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
        body: JSON.stringify({ action: "reprint", saleId, printHere: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) sendToPrinter(d);
      else setScanErr(String(d.error || "Couldn't send that to the printer."));
    } catch {
      setScanErr("No connection — couldn't send that to the printer.");
    } finally {
      setBusy(false);
      nextScanRef.current?.focus();
    }
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
        body: JSON.stringify({ code: vt.code, cashTenderedCents: tenderedCents, printHere: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setVtErr(String(d.error || "Couldn't book that ticket.")); return; }
      sendToPrinter(d);
      setReceipt({ ...(d.sale as Receipt), paymentMethod: "CASH" });
      setVt(null); setVtCode(""); setVtErr("");
      void loadDrawer(); void loadFloor();
    } catch {
      setVtErr("No connection — the ticket was NOT rung. Try again before taking the money.");
    } finally { setBusy(false); }
  };

  /* ---------------------------------------------------------------- view --
     Laid out like a real till on a landscape tablet: a thin bar across the
     top, the TICKET on the left (always on screen, total and pay buttons
     pinned to its foot), and everything you do — scan, pick, take money — on
     the right. The page itself never scrolls; only the lists inside do. */

  /* Scroll the line just rung into view, the way a till's display follows. */
  useEffect(() => {
    if (!lastSku) return;
    document.getElementById(`rg-line-${lastSku}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [lastSku, cart]);

  /* Switching the scan box's keyboard on or off only takes effect on the next
     focus, so it is blurred and focused again. */
  const toggleKeyboard = () => {
    setKb((on) => !on);
    const el = scanRef.current;
    if (el) {
      el.blur();
      window.setTimeout(() => el.focus(), 60);
    }
  };

  /* #printzone must be a DIRECT child of body: the print stylesheet is
     `body.receiptmode > *:not(#printzone) { display: none }`, so nesting it
     inside the page wrapper would hide the wrapper and the receipt with it.
     That's why it's a sibling of the shell rather than inside it. */
  const frame = (top: React.ReactNode, inner: React.ReactNode) => (
    <>
      <style>{TILL_CSS}</style>
      {/* Runs wherever the till is on screen, including the receipt screen:
          a receipt rung a minute ago must not wait on somebody navigating
          back to the sell view. */}
      <PrintAgent
        active={printDirect && printerReady && !!who}
        onStatus={(s) => setPrintTrouble(s.trouble)}
      />
      <div className="rg">
        {top}
        {inner}
      </div>
      <div id="printzone" ref={printRef} />
    </>
  );

  const center = (inner: React.ReactNode) => <div className="rg-center">{inner}</div>;

  if (checking) {
    return frame(null, center(<Skeleton height={320} radius="var(--r-lg)" />));
  }

  /* ----- locked ----- */
  if (!who) {
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "enter"];
    return frame(
      null,
      center(
        <div className="rg-lock">
          <div className="stack g-3" style={{ textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" style={{ width: 72, height: 72, margin: "0 auto" }} />
            <h1 className="display" style={{ fontSize: "var(--fs-2xl)", margin: 0 }}>Register</h1>
            <p className="t-sm t-muted" style={{ margin: 0 }}>Enter your PIN to start.</p>
            <div className="rg-dots" aria-live="polite" aria-label={`${pin.length} digits entered`}>
              {pin
                ? Array.from({ length: pin.length }).map((_, i) => <span key={i} className="rg-dot" />)
                : <span className="t-muted t-sm">PIN</span>}
            </div>
            {pinErr ? <Note tone="error">{pinErr}</Note> : null}
            {/* A physical keyboard works too. Invisible, and never raises the
                on-screen keyboard — the pad is right there. */}
            <input
              type="password"
              inputMode="none"
              autoComplete="off"
              autoFocus
              aria-label="PIN"
              className="rg-hidden"
              value={pin}
              onChange={(e) => { setPinErr(""); setPin(e.target.value.replace(/\D/g, "").slice(0, 12)); }}
              onKeyDown={(e) => { if (e.key === "Enter") void signIn(pin); }}
            />
          </div>
          <div className="rg-pad">
            {keys.map((k) =>
              k === "clear" ? (
                <button key={k} type="button" className="rg-key clear" disabled={busy} onClick={() => { setPin(""); setPinErr(""); }}>
                  Clear
                </button>
              ) : k === "enter" ? (
                <button key={k} type="button" className="rg-key go" disabled={busy || pin.length < 3} onClick={() => void signIn(pin)}>
                  {busy ? "…" : "Enter"}
                </button>
              ) : (
                <button
                  key={k}
                  type="button"
                  className="rg-key"
                  disabled={busy}
                  onClick={() => { setPinErr(""); setPin((p) => (p.length >= 12 ? p : p + k)); }}
                >
                  {k}
                </button>
              )
            )}
          </div>
        </div>
      )
    );
  }

  const topBar = (
    <div className="rg-top">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="" style={{ width: 28, height: 28 }} />
      <span className="rg-who">{who}</span>
      {drawer ? <Badge tone="success" dot>Drawer open {fmtTime(drawer.openedAt)}</Badge> : <Badge tone="warn" dot>No drawer</Badge>}
      {!online ? <Badge tone="danger" dot>Offline</Badge> : null}
      {printTrouble ? (
        <span className="rg-trouble" title={printTrouble}><Icon name="print" size={14} /> {printTrouble}</span>
      ) : null}
      {queue.length ? (
        <Badge tone={queue.some(isStuck) ? "danger" : "warn"} dot>{plural(queue.length, "sale")} to sync</Badge>
      ) : null}
      <span className="rg-sp" />
      {/* No sale pops the till without ringing anything, and goes in the log
          with a name on it every single time. */}
      {drawer && !closing && printerReady ? (
        <Button size="md" variant="secondary" icon="cash" disabled={busy} onClick={() => void popDrawer()}>No sale</Button>
      ) : null}
      {drawer && !closing ? (
        <Button size="md" variant="secondary" icon="lock" onClick={() => setClosing(true)}>Close drawer</Button>
      ) : null}
      <Button size="md" variant="ghost" icon="logout" onClick={() => void lock()}>Lock</Button>
    </div>
  );

  /* Shown wherever the till is being used: the one thing a cashier must never
     wonder about is whether the sale they just took is recorded anywhere. */
  const offlineBanner =
    !online || queue.length ? (
      <div className={`rg-banner ${online ? "warn" : "err"}`} aria-live="polite">
        <div className="stack g-1" style={{ flex: 1, minWidth: 0 }}>
          <b>{!online ? "No connection — still taking sales" : `${plural(queue.length, "sale")} waiting to sync`}</b>
          <span>
            {!online
              ? "Sales save on this tablet and post themselves when the wifi is back. Card sales still need the terminal."
              : queue.some(isStuck)
                ? `${queue.filter(isStuck).map((q) => q.lastError).find(Boolean) || "The server keeps rejecting some."} Nothing is lost — show this to the office.`
                : "Saved here; not in the books yet."}
          </span>
        </div>
        {queue.length ? (
          <Button size="sm" variant="secondary" icon="refresh" loading={syncing} disabled={syncing} onClick={() => void drainQueue(true)}>
            Sync now
          </Button>
        ) : null}
      </div>
    ) : null;

  /* ----- no drawer open ----- */
  if (drawerLoaded && !drawer) {
    return frame(
      topBar,
      center(
        <div className="card card-pad stack g-4" style={{ width: "100%", maxWidth: 520 }}>
          <div className="stack g-1">
            <h2 style={{ margin: 0, fontSize: "var(--fs-xl)" }}>Open the drawer</h2>
            <span className="t-sm t-muted">Count the starting cash before the first sale.</span>
          </div>
          <MoneyInput
            value={openFloat}
            placeholder="150.00"
            aria-label="Starting cash in the drawer"
            style={{ height: 64, fontSize: "var(--fs-xl)" }}
            onChange={(e) => setOpenFloat(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void openDrawer(); }}
          />
          <Button variant="primary" size="xl" block icon="unlock" loading={busy} disabled={busy || !openFloat.trim()} onClick={() => void openDrawer()}>
            Open with {money(dollarsToCents(openFloat) || 0)}
          </Button>
        </div>
      )
    );
  }

  /* ----- closing out ----- */
  if (closing && drawer) {
    const expected = drawer.openTotalCents + drawer.cashSalesCents;
    const counted = dollarsToCents(closeCount) || 0;
    const diff = counted - expected;
    return frame(
      topBar,
      center(
        <div className="card card-pad stack g-4" style={{ width: "100%", maxWidth: 560 }}>
          <div className="row between wrap g-3" style={{ alignItems: "flex-end" }}>
            <div className="stack g-1">
              <h2 style={{ margin: 0, fontSize: "var(--fs-xl)" }}>Count out</h2>
              <span className="t-xs t-muted">{money(drawer.openTotalCents)} start + {money(drawer.cashSalesCents)} cash sales</span>
            </div>
            <div className="stack g-1" style={{ textAlign: "right" }}>
              <span className="t-label">Should be there</span>
              <span className="num" style={{ fontSize: "var(--fs-3xl)", fontWeight: 800 }}>{money(expected)}</span>
            </div>
          </div>
          <MoneyInput
            value={closeCount}
            placeholder="What you counted"
            aria-label="What you actually counted"
            style={{ height: 64, fontSize: "var(--fs-xl)" }}
            onChange={(e) => setCloseCount(e.target.value)}
          />
          {closeCount.trim() ? (
            <Note tone={diff === 0 ? "success" : Math.abs(diff) < 500 ? "warn" : "error"}>
              {diff === 0 ? "Exactly right." : diff > 0 ? `${money(diff)} over.` : `${money(-diff)} short.`}
            </Note>
          ) : null}
          <div className="row g-2">
            <Button variant="primary" size="xl" className="grow" icon="lock" loading={busy} disabled={busy || !closeCount.trim()} onClick={() => void closeDrawer()}>
              Close the drawer
            </Button>
            <Button variant="ghost" size="xl" disabled={busy} onClick={() => { setClosing(false); setCloseCount(""); }}>Back</Button>
          </div>
        </div>
      )
    );
  }

  /* ---------------------------------------------- the two-pane till body -- */
  const till = (left: React.ReactNode, right: React.ReactNode) =>
    frame(topBar, <div className="rg-body"><section className="rg-pane">{left}</section><section className="rg-pane">{right}</section></div>);

  /* Totals block, shared by the ticket and the booth ticket. */
  const totals = (rows: { label: string; cents: number; minus?: boolean }[], totalCents: number) => (
    <>
      {rows.map((r) => (
        <div key={r.label} className="rg-sum"><span>{r.label}</span><span>{r.minus ? "-" : ""}{money(r.cents)}</span></div>
      ))}
      <div className="rg-total"><span className="lbl">Total</span><span className="amt">{money(totalCents)}</span></div>
    </>
  );

  /* ----- receipt ----- */
  if (receipt) {
    const change = receipt.paymentMethod === "CASH" ? receipt.changeCents || 0 : 0;
    const tendered = receipt.cashTenderedCents || 0;
    return till(
      <>
        <div className="rg-pane-head">
          <b>{receipt.offline ? "Saved on this tablet" : `Sale #${receipt.number}`}</b>
          <Badge tone="success" dot>Paid</Badge>
        </div>
        <div className="rg-scroll" style={{ padding: "14px" }}>
          <div className="stack g-3">
            <div className="rg-sum" style={{ fontSize: "var(--fs-md)" }}><span>Total</span><b>{money(receipt.totalCents)}</b></div>
            <div className="rg-sum" style={{ fontSize: "var(--fs-md)" }}>
              <span>Paid by</span>
              <b>{receipt.paymentMethod === "CASH" ? "Cash" : `Card${receipt.cardName ? ` — ${receipt.cardName}` : ""}`}</b>
            </div>
            {receipt.paymentMethod === "CASH" && tendered > 0 ? (
              <div className="rg-sum" style={{ fontSize: "var(--fs-md)" }}><span>Cash given</span><b>{money(tendered)}</b></div>
            ) : null}
            {receipt.offline ? (
              <Note tone="warn">No ticket number and no printed receipt until this syncs. The sale is safe on this tablet.</Note>
            ) : printerReady ? (
              <span className="t-sm t-muted">The receipt is printing.</span>
            ) : null}
          </div>
        </div>
      </>,
      <div className="rg-center" style={{ flexDirection: "column", gap: 16 }}>
        {/* Holds the cursor so a scan here starts the next ticket. Invisible,
            and never raises the on-screen keyboard. */}
        <input ref={nextScanRef} aria-hidden="true" tabIndex={-1} inputMode="none" autoComplete="off" className="rg-hidden" />
        {receipt.paymentMethod === "CASH" && tendered > 0 ? (
          <div className="stack g-1" style={{ textAlign: "center" }}>
            <span className="t-label">Change due</span>
            <span className="rg-hero num">{money(change)}</span>
          </div>
        ) : (
          <div className="stack g-1" style={{ textAlign: "center" }}>
            <span className="t-label">Total</span>
            <span className="rg-hero num">{money(receipt.totalCents)}</span>
          </div>
        )}
        <div className="stack g-2" style={{ width: "100%", maxWidth: 420 }}>
          <Button variant="primary" size="xl" block icon="plus" onClick={() => setReceipt(null)}>Next customer</Button>
          {receipt.offline ? null : (
            <Button variant="secondary" size="lg" block icon="print" disabled={busy} onClick={() => void printAgain(receipt.id)}>Print again</Button>
          )}
        </div>
        <span className="t-sm t-muted">Or just scan the next item.</span>
      </div>
    );
  }

  /* ----- a pre-order being collected ----- */
  if (scanned) {
    return till(
      <>
        <div className="rg-pane-head"><b>Order #{scanned.number}</b><span className="t-sm t-muted">{scanned.vendorName}</span></div>
        <div className="rg-scroll">
          {scanned.lines.map((l, idx) => (
            <div key={`${l.name}-${idx}`} className="rg-line" style={{ gridTemplateColumns: "auto 1fr" }}>
              <span className="num" style={{ fontWeight: 700 }}>{l.quantity}×</span>
              <span className="rg-name"><b>{l.name}</b></span>
            </div>
          ))}
        </div>
        <div className="rg-foot">
          <div className="rg-total"><span className="lbl">Paid online</span><span className="amt">{money(scanned.totalCents)}</span></div>
        </div>
      </>,
      <div className="rg-center" style={{ flexDirection: "column", gap: 14, alignItems: "stretch" }}>
        <div className="stack g-1">
          <h2 style={{ margin: 0, fontSize: "var(--fs-2xl)" }}>{scanned.customerName}</h2>
          <span className="t-sm t-muted">
            {scanned.readyAt ? `Dropped off ${fmtTime(scanned.readyAt)}` : "Marked ready"}
            {scanned.customerPhone ? ` · ${scanned.customerPhone}` : ""}
          </span>
        </div>
        <Note tone="success" title="Paid in full online">Take no money. Check the name matches before you hand it over.</Note>
        <Button size="xl" block variant="primary" icon="check" loading={busy} disabled={busy} onClick={() => void handOver(scanned)}>
          Hand it over
        </Button>
        <Button size="lg" block variant="ghost" onClick={() => { setScanned(null); setScannedErr(""); }}>Back</Button>
      </div>
    );
  }

  /* ----- a vendor's booth ticket, paid in cash here ----- */
  if (vt) {
    return till(
      <>
        <div className="rg-pane-head"><b>Booth ticket {vt.code}</b><span className="t-sm t-muted">{vt.vendorName}</span></div>
        <div className="rg-scroll">
          {vt.lines.map((l, idx) => (
            <div key={`${l.sku}-${idx}`} className="rg-line" style={{ gridTemplateColumns: "auto 1fr auto" }}>
              <span className="num" style={{ fontWeight: 700 }}>{l.quantity}×</span>
              <span className="rg-name"><b>{l.name}</b></span>
              <span className="rg-amt">{money(l.priceCents * l.quantity)}</span>
            </div>
          ))}
        </div>
        <div className="rg-foot">
          {totals([{ label: "Subtotal", cents: vt.subtotalCents }, { label: "Tax", cents: vt.taxCents }], vt.totalCents)}
        </div>
      </>,
      <div className="rg-scroll" style={{ padding: 10 }}>
        {vtErr ? <div className="rg-banner err" style={{ margin: "0 0 10px" }}>{vtErr}</div> : null}
        <CashTender
          compact
          totalCents={vt.totalCents}
          busy={busy}
          onCancel={() => { setVt(null); setVtErr(""); }}
          onConfirm={(tendered) => void bookVendorTicket(tendered)}
        />
      </div>
    );
  }

  /* ----- selling ----- */
  const query = scan.trim().toLowerCase();
  const hits = query.length >= 2
    ? floor.filter((i) => i.name.toLowerCase().includes(query) || i.sku.toLowerCase().includes(query)).slice(0, 24)
    : [];
  const vendorList = [...new Map<string, string>(floor.map((i) => [i.vendorCode, i.vendorName] as [string, string])).entries()];
  const stranded = unbooked.filter((u) => u.paymentIntentId !== charge?.paymentIntentId);
  const itemCount = cart.reduce((n, l) => n + l.quantity, 0);

  const itemTile = (i: FloorItem) => (
    <button key={i.id} type="button" className={`rg-tile${i.quantity === 0 ? " out" : ""}`} onClick={() => addItem(i)}>
      <b>{i.name}</b>
      <span className="meta"><span>{i.quantity === 0 ? "Out" : `${i.quantity} left`}</span><span className="num">{money(tag(i.priceCents))}</span></span>
    </button>
  );

  /* LEFT: the ticket. Always on screen, total and pay buttons pinned. */
  const ticket = (
    <>
      <div className="rg-pane-head">
        <b>Ticket{itemCount ? ` · ${plural(itemCount, "item")}` : ""}</b>
        {cart.length && pay === "NONE" ? (
          <Button size="sm" variant="dangerSoft" icon="trash" onClick={() => { setCart([]); setLastSku(""); }}>Clear</Button>
        ) : null}
      </div>
      <div className="rg-scroll">
        {cart.length === 0 ? (
          <div className="rg-empty">
            <Icon name="scan" size={36} />
            <b>Scan an item to start</b>
            <span className="t-sm">Or search and tap it on the right.</span>
          </div>
        ) : (
          cart.map((l) => (
            <div key={l.sku} id={`rg-line-${l.sku}`} className={`rg-line${l.sku === lastSku ? " is-new" : ""}`}>
              {pay === "NONE" ? (
                <span className="rg-qty">
                  <button type="button" aria-label={`One fewer ${l.name}`} onClick={() => setQty(l.sku, l.quantity - 1)}>−</button>
                  <span>{l.quantity}</span>
                  <button type="button" aria-label={`One more ${l.name}`} onClick={() => { setQty(l.sku, l.quantity + 1); setLastSku(l.sku); }}>+</button>
                </span>
              ) : (
                <span className="num" style={{ fontWeight: 700, minWidth: 36 }}>{l.quantity}×</span>
              )}
              <span className="rg-name">
                <b>{l.name}</b>
                <small>{l.vendorName} · {money(tag(l.priceCents))} each</small>
              </span>
              <span className="rg-amt">{money(tag(l.priceCents) * l.quantity)}</span>
            </div>
          ))
        )}
      </div>
      <div className="rg-foot">
        {/* Tag prices up top. Paying cash shows the discount and the cash
            total; otherwise the total is the card (tag) total. */}
        {totals(
          pay === "CASH"
            ? [
                { label: "Subtotal", cents: subtotal + cardAdjustCents },
                ...(cardAdjustCents > 0 ? [{ label: `Cash discount (${cardAdjustPercent}%)`, cents: cardAdjustCents, minus: true }] : []),
                { label: shownRate === null ? "Tax (mixed)" : `Tax (${shownRate}%)`, cents: taxCents },
              ]
            : [
                { label: "Subtotal", cents: subtotal + cardAdjustCents },
                { label: shownRate === null ? "Tax (mixed)" : `Tax (${shownRate}%)`, cents: cardTaxCents },
              ],
          pay === "CASH" ? total : cardTotal
        )}
        {pay === "NONE" ? (
          <div className="rg-pay">
            <button type="button" className="rg-paybtn rg-cash" disabled={busy || !cart.length} onClick={() => setPay("CASH")}>
              <span><Icon name="cash" size={20} /> Cash</span>
              <small>{money(total)}{cardAdjustCents > 0 ? ` · ${cardAdjustPercent}% off` : ""}</small>
            </button>
            <button type="button" className="rg-paybtn rg-card" disabled={busy || !cart.length} onClick={() => setPay("CARD")}>
              <span><Icon name="card" size={20} /> Card</span>
              <small>{money(cardTotal)}</small>
            </button>
          </div>
        ) : (
          <div className="rg-paying">
            Taking {pay === "CASH" ? "cash" : "card"} — {money(pay === "CASH" ? total : cardTotal)}
          </div>
        )}
      </div>
    </>
  );

  /* RIGHT, while paying by card. */
  const cardPanel = (
    <div className="rg-scroll" style={{ padding: 14 }}>
      <div className="stack g-3">
        <div className="stack g-1">
          <span className="t-label t-accent">Charge the card</span>
          <span className="rg-hero num">{money(cardTotal)}</span>
          {cardAdjustCents > 0 ? (
            <span className="t-xs t-muted">Tag prices, tax included. Paying cash would be {money(total)}.</span>
          ) : null}
        </div>
        {readerReady ? (
          charge ? (
            <>
              {charge.state === "failed" ? (
                <Note tone="error" title="Not paid">{charge.message}</Note>
              ) : (
                <Note
                  tone={charge.state === "booking" ? "success" : "info"}
                  title={charge.state === "sending" ? "Sending…" : charge.state === "booking" ? "Approved" : charge.state === "succeeded" ? "Paid — save the ticket" : "On the reader now"}
                >
                  {charge.message}
                  {charge.cardLabel ? ` (${charge.cardLabel})` : ""}
                </Note>
              )}
              {charge.state === "failed" ? (
                <div className="row g-2">
                  <Button variant="primary" size="xl" className="grow" icon="card" disabled={busy} onClick={() => void startCharge()}>Try the card again</Button>
                  <Button variant="ghost" size="xl" disabled={busy} onClick={() => void cancelCharge()}>Cancel</Button>
                </div>
              ) : charge.state === "succeeded" ? (
                /* Paid, but the ticket didn't save. The only button that
                   matters is the one that tries again. */
                <Button variant="primary" size="xl" block icon="check" loading={busy} disabled={busy}
                  onClick={() => void book("CARD", 0, { paymentIntentId: charge.paymentIntentId, cardLabel: charge.cardLabel })}>
                  Finish the sale
                </Button>
              ) : (
                /* Not while it's still being sent: the reader would show the
                   total a moment later with nobody watching for the tap. */
                <Button variant="ghost" size="xl" block loading={busy} disabled={busy || charge.state === "booking" || charge.state === "sending"} onClick={() => void cancelCharge()}>
                  Cancel the payment
                </Button>
              )}
            </>
          ) : (
            <>
              <Note tone="info">The reader asks for the card. Nothing is charged until they tap.</Note>
              <Button variant="primary" size="xl" block icon="card" loading={busy} disabled={busy} onClick={() => void startCharge()}>
                Send {money(cardTotal)} to the reader
              </Button>
              <Button variant="ghost" size="lg" block disabled={busy} onClick={() => setPay("NONE")}>Back</Button>
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
            <Button variant="primary" size="xl" block icon="check" loading={busy} disabled={busy} onClick={() => void book("CARD")}>Book the sale</Button>
            <Button variant="ghost" size="lg" block disabled={busy} onClick={() => setPay("NONE")}>Back</Button>
          </>
        )}
      </div>
    </div>
  );

  /* RIGHT, while ringing up: scan box, tabs, tiles. */
  const pickingPanel = (
    <>
      <div className="rg-scanbar">
        <input
          ref={scanRef}
          className="mono"
          value={scan}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode={kb ? "text" : "none"}
          placeholder="Scan, or tap ⌨ to type a name or code"
          aria-label="Scan a barcode or search"
          onChange={(e) => { onScanChange(e.target.value); if (tab !== "items") setTab("items"); }}
          onKeyDown={(e) => {
            /* Enter and Tab both mean "that's the whole code". A typed name
               with exactly one match rings that one up. */
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              const exact = floor.some((i) => i.sku === scan.trim().toUpperCase());
              if (!exact && hits.length === 1) { addItem(hits[0]); setScan(""); return; }
              void doScan();
            }
          }}
        />
        {scan ? (
          <button type="button" className="rg-iconbtn" aria-label="Clear" onClick={() => { setScan(""); scanRef.current?.focus(); }}>
            <Icon name="close" size={20} />
          </button>
        ) : null}
        <button type="button" className={`rg-iconbtn${kb ? " on" : ""}`} aria-pressed={kb} aria-label="Keyboard" title="Keyboard" onClick={toggleKeyboard}>
          <span style={{ fontSize: 22, lineHeight: 1 }}>⌨</span>
        </button>
      </div>
      {scanErr ? <div className="rg-banner err">{scanErr}</div> : null}
      {offlineBanner}
      {stranded.length ? (
        <div className="rg-banner err" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <b>{stranded.length === 1 ? "A card was charged with no ticket" : `${stranded.length} cards were charged with no ticket`}</b>
          {stranded.map((u) => (
            <div key={u.paymentIntentId} className="row wrap g-2" style={{ alignItems: "center" }}>
              <span className="grow">
                <b className="num">{money(u.amountCents)}</b>
                {u.cardLabel ? ` · ${u.cardLabel}` : ""} · {fmtTime(u.createdAt)}{u.employee ? ` · ${u.employee}` : ""}
              </span>
              <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => void saveUnbooked(u)}>Save the ticket</Button>
            </div>
          ))}
        </div>
      ) : null}
      {probeOn ? (
        <div className="rg-banner warn"><code className="mono t-xs" style={{ wordBreak: "break-all" }}>{probe || "scan something"}</code></div>
      ) : null}

      <div className="rg-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "items"} className={`rg-tab${tab === "items" ? " on" : ""}`} onClick={() => setTab("items")}>Items</button>
        <button type="button" role="tab" aria-selected={tab === "pickups"} className={`rg-tab${tab === "pickups" ? " on" : ""}`} onClick={() => setTab("pickups")}>
          Pickups{pickups.length ? ` (${pickups.length})` : ""}
        </button>
        <button type="button" role="tab" aria-selected={tab === "booth"} className={`rg-tab${tab === "booth" ? " on" : ""}`} onClick={() => setTab("booth")}>Booth ticket</button>
      </div>

      <div className="rg-scroll rg-tabbody">
        {tab === "items" ? (
          query.length >= 2 ? (
            hits.length ? (
              <div className="rg-tiles">{hits.map(itemTile)}</div>
            ) : (
              <div className="rg-empty"><b>No matches on the floor</b><span className="t-sm">Try part of the name, or the vendor code.</span></div>
            )
          ) : openVendor ? (
            <>
              <div className="rg-crumb">
                <Button size="md" variant="secondary" icon="arrowLeft" onClick={() => setOpenVendor(null)}>All vendors</Button>
                <b className="truncate">{vendorList.find(([c]) => c === openVendor)?.[1] || openVendor}</b>
              </div>
              <div className="rg-tiles">{floor.filter((i) => i.vendorCode === openVendor).map(itemTile)}</div>
            </>
          ) : (
            <div className="rg-tiles">
              {vendorList.map(([code, name]) => (
                <button key={code} type="button" className="rg-tile vendor" onClick={() => setOpenVendor(code)}>
                  <b>{name}</b>
                  <span className="meta"><span className="mono">{code}</span><span>{floor.filter((i) => i.vendorCode === code).length} items</span></span>
                </button>
              ))}
            </div>
          )
        ) : tab === "pickups" ? (
          <div className="stack g-3" style={{ padding: 10 }}>
            {camOpen ? (
              <div className="stack g-2">
                <div id="collect-scan-box" style={{ width: "100%", maxWidth: 360, margin: "0 auto", borderRadius: "var(--r-lg)", overflow: "hidden", background: "#000" }} />
                <Button size="lg" variant="secondary" block onClick={() => void stopCam()}>Stop scanning</Button>
              </div>
            ) : (
              <Button size="lg" variant="primary" block icon="camera" onClick={() => void startCam()}>Scan their code with the camera</Button>
            )}
            {scannedErr ? <Note tone="error">{scannedErr}</Note> : null}
            {pickups.length === 0 ? (
              <div className="rg-empty" style={{ height: "auto" }}><b>No orders waiting</b><span className="t-sm">Paid online orders show here once the vendor drops them off.</span></div>
            ) : (
              <>
                {pickups.length > 4 ? (
                  <SearchInput value={pickupQ} onValueChange={setPickupQ} placeholder="Name or order number" aria-label="Search orders waiting for collection" />
                ) : null}
                {(() => {
                  const q = pickupQ.trim().toLowerCase();
                  const shown = q
                    ? pickups.filter((o) => o.customerName.toLowerCase().includes(q) || String(o.number).includes(q) || o.vendorName.toLowerCase().includes(q))
                    : pickups;
                  if (!shown.length) return <EmptyState icon="search" title="No match" body="Try their surname, or the number on their email." />;
                  return shown.map((o) => (
                    <div key={o.id} className="rg-order">
                      <div className="stack g-1" style={{ flex: 1, minWidth: 0 }}>
                        <span className="row g-2" style={{ alignItems: "baseline" }}>
                          <b style={{ fontSize: "var(--fs-lg)" }}>{o.customerName}</b>
                          <span className="t-sm t-muted num">#{o.number}</span>
                        </span>
                        <span className="t-sm t-muted truncate">{o.vendorName} · {o.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ")}</span>
                        <span className="t-xs t-muted">
                          {o.readyAt ? `Dropped off ${fmtTime(o.readyAt)}` : "Ready"} · paid {money(o.totalCents)}{o.customerPhone ? ` · ${o.customerPhone}` : ""}
                        </span>
                      </div>
                      <Button size="lg" variant="primary" icon="check" disabled={busy} onClick={() => void handOver(o)}>Handed over</Button>
                    </div>
                  ));
                })()}
                <span className="t-xs t-muted">Paid in full online — take no money for these.</span>
              </>
            )}
          </div>
        ) : (
          <div className="stack g-3" style={{ padding: 14 }}>
            <span className="t-sm t-muted">A vendor rang something up at their booth and sent the customer here to pay cash. Type the code from their phone.</span>
            <div className="row g-2">
              <Input
                className="mono grow"
                value={vtCode}
                autoComplete="off"
                autoCapitalize="characters"
                placeholder="K4M7Q"
                aria-label="Booth ticket code"
                style={{ height: 56, fontSize: "var(--fs-xl)", letterSpacing: "0.12em", textTransform: "uppercase" }}
                onChange={(e) => { setVtCode(e.target.value.toUpperCase()); setVtErr(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") void findVendorTicket(); }}
              />
              <Button size="xl" variant="primary" icon="search" loading={busy} disabled={busy || !vtCode.trim()} onClick={() => void findVendorTicket()}>Find</Button>
            </div>
            {vtErr ? <Note tone="error">{vtErr}</Note> : null}
          </div>
        )}
      </div>
    </>
  );

  return till(
    ticket,
    pay === "CASH" && cart.length > 0 ? (
      <div className="rg-scroll" style={{ padding: 10 }}>
        <CashTender compact totalCents={total} busy={busy} onCancel={() => setPay("NONE")} onConfirm={(tendered) => void book("CASH", tendered)} />
      </div>
    ) : pay === "CARD" && cart.length > 0 ? (
      cardPanel
    ) : (
      pickingPanel
    )
  );
}

/* The till's own layout. Kept here rather than in globals.css because nothing
   else in the app looks like a cash register, and nothing else should. */
const TILL_CSS = `
.rg { height: 100dvh; display: flex; flex-direction: column; background: var(--bg-sunken); overflow: hidden; }
.rg-top { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 6px 10px; min-height: 52px; background: var(--surface); border-bottom: 1px solid var(--border); overflow: hidden; }
.rg-who { font-weight: 700; font-size: var(--fs-md); white-space: nowrap; }
.rg-sp { flex: 1 1 auto; }
.rg-trouble { display: inline-flex; align-items: center; gap: 4px; max-width: 280px; padding: 3px 8px; border-radius: 999px; background: var(--warn-soft); color: var(--warn-text); font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rg-body { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(330px, 42%) minmax(0, 1fr); gap: 10px; padding: 10px; }
.rg-pane { min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.rg-pane-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 48px; padding: 6px 14px; border-bottom: 1px solid var(--border-subtle); font-size: var(--fs-md); }
.rg-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
.rg-foot { flex: 0 0 auto; padding: 10px 14px 12px; border-top: 1px solid var(--border); background: var(--bg-elevated); }
.rg-line { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--border-subtle); transition: background .4s; }
.rg-line.is-new { background: var(--accent-soft); }
.rg-qty { display: inline-flex; align-items: center; gap: 4px; }
.rg-qty button { width: 38px; height: 38px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: 20px; line-height: 1; }
.rg-qty button:active { background: var(--surface-active); }
.rg-qty span { min-width: 26px; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }
.rg-name { min-width: 0; display: flex; flex-direction: column; }
.rg-name b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rg-name small { color: var(--text-muted); font-size: var(--fs-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rg-amt { font-weight: 650; font-variant-numeric: tabular-nums; text-align: right; }
.rg-sum { display: flex; justify-content: space-between; gap: 8px; font-size: var(--fs-sm); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.rg-total { display: flex; justify-content: space-between; align-items: baseline; margin-top: 2px; }
.rg-total .lbl { font-weight: 700; font-size: var(--fs-sm); text-transform: uppercase; letter-spacing: .05em; }
.rg-total .amt { font-size: 2.25rem; font-weight: 800; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.1; }
.rg-pay { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.rg-paybtn { height: 66px; border: 0; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; font-size: 1.125rem; font-weight: 700; cursor: pointer; }
.rg-paybtn span { display: inline-flex; align-items: center; gap: 8px; }
.rg-paybtn small { font-size: var(--fs-sm); font-weight: 600; opacity: .85; font-variant-numeric: tabular-nums; }
.rg-paybtn:active:not(:disabled) { transform: scale(.98); }
.rg-paybtn:disabled { opacity: .4; cursor: default; }
.rg-cash { background: var(--accent); color: #fff; }
.rg-card { background: var(--n-900); color: #fff; }
.rg-paying { margin-top: 10px; padding: 12px; border-radius: 12px; background: var(--accent-soft); color: var(--accent-text); font-weight: 700; text-align: center; }
.rg-scanbar { flex: 0 0 auto; display: flex; gap: 8px; padding: 10px; }
.rg-scanbar input { flex: 1 1 auto; min-width: 0; height: 54px; padding: 0 14px; font-size: 1.125rem; border: 2px solid var(--border-strong); border-radius: 12px; background: var(--bg-elevated); color: var(--text); }
.rg-scanbar input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.rg-iconbtn { flex: 0 0 auto; width: 54px; height: 54px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); }
.rg-iconbtn.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-text); }
.rg-tabs { flex: 0 0 auto; display: flex; gap: 6px; padding: 8px 10px 0; border-bottom: 1px solid var(--border); }
.rg-tab { flex: 1 1 0; height: 44px; border: 1px solid transparent; border-bottom: 0; border-radius: 10px 10px 0 0; background: transparent; color: var(--text-secondary); font-weight: 650; font-size: var(--fs-md); }
.rg-tab.on { background: var(--bg-sunken); border-color: var(--border); color: var(--text); box-shadow: inset 0 3px 0 var(--accent); }
.rg-tabbody { background: var(--bg-sunken); }
.rg-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; padding: 10px; }
.rg-tile { min-height: 78px; padding: 10px 12px; display: flex; flex-direction: column; justify-content: space-between; gap: 6px; text-align: left; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); cursor: pointer; }
.rg-tile:active { transform: scale(.98); background: var(--accent-soft); border-color: var(--accent); }
.rg-tile b { font-weight: 650; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.rg-tile .meta { display: flex; justify-content: space-between; gap: 6px; font-size: var(--fs-sm); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.rg-tile .meta .num { color: var(--text); font-weight: 700; }
.rg-tile.out { opacity: .5; }
.rg-tile.vendor { border-left: 4px solid var(--accent); }
.rg-crumb { display: flex; align-items: center; gap: 10px; padding: 10px 10px 0; }
.rg-banner { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; margin: 0 10px 8px; padding: 10px 12px; border-radius: 10px; font-size: var(--fs-sm); }
.rg-banner.err { background: var(--danger-soft); color: var(--danger-text); }
.rg-banner.warn { background: var(--warn-soft); color: var(--warn-text); }
.rg-order { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.rg-empty { height: 100%; min-height: 160px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 24px; text-align: center; color: var(--text-muted); }
.rg-empty b { color: var(--text-secondary); }
.rg-hero { font-size: 3rem; font-weight: 800; letter-spacing: -.02em; line-height: 1.05; }
.rg-center { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 16px; overflow-y: auto; }
.rg-hidden { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.rg-lock { width: 100%; max-width: 780px; display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: center; }
.rg-dots { height: 60px; display: flex; align-items: center; justify-content: center; gap: 14px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
.rg-dot { width: 14px; height: 14px; border-radius: 50%; background: var(--text); }
.rg-pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.rg-key { height: clamp(54px, 12vh, 80px); border: 1px solid var(--border); border-radius: 14px; background: var(--surface); color: var(--text); font-size: 1.625rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.rg-key:active:not(:disabled) { background: var(--surface-active); transform: scale(.97); }
.rg-key.clear { font-size: var(--fs-md); color: var(--text-secondary); }
.rg-key.go { background: var(--accent); border-color: var(--accent); color: #fff; font-size: var(--fs-lg); }
.rg-key:disabled { opacity: .5; }
@media (max-width: 860px) {
  .rg-body { grid-template-columns: 1fr; grid-template-rows: minmax(0, 45%) minmax(0, 1fr); }
  .rg-lock { grid-template-columns: 1fr; gap: 20px; max-width: 380px; }
  .rg-top .btn span { display: none; }
}
@media (max-height: 560px) {
  .rg-total .amt { font-size: 1.875rem; }
  .rg-paybtn { height: 58px; }
  .rg-hero { font-size: 2.5rem; }
}
`;

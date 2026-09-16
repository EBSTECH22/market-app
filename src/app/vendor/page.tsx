"use client";

import { useCallback, useEffect, useState } from "react";
import { usePulse } from "@/lib/usePulse";
import {
  Icon, Button, IconButton, LinkButton, Field, Input, Select, Textarea, Checkbox,
  Modal, Panel, useDialog, useToast, DataTable, Badge, Card, Stat, EmptyState,
  Note, Skeleton, SkeletonStats, PageHeader, type Column, type IconName,
} from "@/components/ui";
import { money, fmtDate, fmtDateTime, fmtTime, plural } from "@/lib/format";
import { useHashTab } from "@/lib/useHashTab";
import { subscribeToPush } from "@/lib/pushclient";

type Item = { id: string; sku: string; name: string; priceCents: number; quantity: number; active: boolean; salePercent?: number; taxClass?: string };
type Ledger = { id: string; type: string; amountCents: number; note: string; createdAt: string };
type Me = {
  vendor: { code: string; businessName: string; email: string; commissionPercent: number; mustChangePassword?: boolean; acceptsPreorders?: boolean; acceptsRequests?: boolean; publicBlurb?: string; allowSelfCheckout?: boolean; cardLast4?: string; contracts?: { id: string; status: string; vendorSignedAt: string | null }[] };
  items: Item[]; ledger: Ledger[]; balance: number; monthSales: number; monthNet: number;
};
type Thread = { id: string; type: string; status: string; customerName: string; email: string; phone: string; last: { sender: string; body: string } | null };
type OpenThread = { id: string; type: string; status: string; customerName: string; email: string; phone: string; messages: { id: string; sender: string; body: string; createdAt: string }[] };
type Photo = { id: string; kind: string; itemId?: string };

/* Tabs live in the URL hash so refresh, back/forward and shared links all work.
   They used to sit in plain useState, so a reload always dumped a vendor back
   on Home and there was no way to link anyone to a section. */
const VENDOR_TABS = ["home", "items", "insights", "inbox", "page", "money", "chat", "settings"] as const;
type VendorTab = (typeof VENDOR_TABS)[number];

const TAB_META: Record<VendorTab, { label: string; icon: IconName; sub: string }> = {
  home: { label: "Home", icon: "store", sub: "Your booth at a glance" },
  items: { label: "My items", icon: "box", sub: "Prices, stock, sales, and barcode labels" },
  insights: { label: "What's working", icon: "chart", sub: "What sells, what's stuck, and what's about to run out" },
  inbox: { label: "Inbox", icon: "inbox", sub: "Pre-orders, requests, and complaints from customers" },
  page: { label: "My page", icon: "star", sub: "Your public page, photos, and market feed posts" },
  money: { label: "Money", icon: "dollar", sub: "Balance, rent, card on file, and your full statement" },
  chat: { label: "Vendor chat", icon: "message", sub: "Every vendor and staff member at the market" },
  settings: { label: "Settings", icon: "settings", sub: "Sale alerts and your password" },
};

/* Phones get the four most-used destinations plus a "More" sheet — seven
   equal tabs across a phone is unreadable and under the 44px target. */
const PRIMARY_MOBILE: VendorTab[] = ["home", "items", "insights", "money"];
const MORE_MOBILE: VendorTab[] = ["page", "chat", "settings"];

const LEDGER_ICON = (type: string): IconName =>
  type === "SALE" ? "receipt" : type === "PAYOUT" ? "cash" : type === "RENT" ? "store" : "edit";

const THREAD_ICON = (type: string): IconName =>
  type === "PREORDER" ? "receipt" : type === "REQUEST" ? "help" : "warning";

/** The price a shopper actually pays — unchanged from the original maths. */
const effectivePriceCents = (it: Item): number =>
  Math.max(0, Math.round((it.priceCents * (100 - Math.min(90, Math.max(0, it.salePercent || 0)))) / 100));

/** Anything at or below this gets a badge so a thin shelf is obvious. */
const LOW_STOCK = 3;

/**
 * One password form, used by both the forced first-change screen and the
 * Settings tab. The markup was duplicated verbatim in two places, so a fix to
 * one never reached the other. Lives at module scope so typing in it doesn't
 * remount the inputs on every parent render.
 */
function PasswordForm({
  requireCurrent, cur, next, again, onCur, onNext, onAgain,
  onSubmit, busy, error, submitLabel,
}: {
  requireCurrent: boolean;
  cur: string;
  next: string;
  again: string;
  onCur: (v: string) => void;
  onNext: (v: string) => void;
  onAgain: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string;
  submitLabel: string;
}) {
  const mismatch = again.length > 0 && next.length > 0 && again !== next;
  return (
    <form className="stack g-4" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      {requireCurrent ? (
        <Field label="Current password" required>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="current-password"
              value={cur}
              onChange={(e) => onCur(e.target.value)}
            />
          )}
        </Field>
      ) : null}

      <Field label="New password" hint="At least 8 characters." required>
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => onNext(e.target.value)}
          />
        )}
      </Field>

      <Field
        label="Type it again"
        error={mismatch ? "These two don't match yet." : undefined}
        required
      >
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => onAgain(e.target.value)}
          />
        )}
      </Field>

      {error ? <Note tone="error">{error}</Note> : null}

      <div>
        <Button type="submit" variant="primary" size="lg" icon="lock" loading={busy} block>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export default function VendorDashboard() {
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [isFood, setIsFood] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pwCur, setPwCur] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwNew2, setPwNew2] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pushDevices, setPushDevices] = useState<number | null>(null);
  const [pushKey, setPushKey] = useState("");
  const [pushMsg, setPushMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [inbox, setInbox] = useState<Thread[]>([]);
  const [inboxLoaded, setInboxLoaded] = useState(false);
  const [inboxErr, setInboxErr] = useState("");
  const [openThread, setOpenThread] = useState<OpenThread | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [inboxMsg, setInboxMsg] = useState("");
  const [pubPre, setPubPre] = useState(false);
  const [pubReq, setPubReq] = useState(false);
  const [pubBlurb, setPubBlurb] = useState("");
  const [pubSelf, setPubSelf] = useState(true);
  const [myPhotos, setMyPhotos] = useState<Photo[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [po, setPo] = useState<{ status: string; description: string; subtotalCents: number; taxCents: number; totalCents: number; expectedDate: string; payUrl: string } | null>(null);
  const [poDesc, setPoDesc] = useState("");
  const [poAmt, setPoAmt] = useState("");
  const [poDate, setPoDate] = useState("");
  const [poErr, setPoErr] = useState("");
  const [tab, setTab] = useHashTab(VENDOR_TABS, "home");
  const [moreOpen, setMoreOpen] = useState(false);
  const [editItem, setEditItem] = useState<string | null>(null);
  const [editIF, setEditIF] = useState({ name: "", price: "", qty: "", sale: "0", food: false });
  const [cardMsg, setCardMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [chat, setChat] = useState<{ id: string; vendorId: string; name: string; body: string; createdAt: string }[]>([]);
  const [chatMe, setChatMe] = useState("");
  const [chatBody, setChatBody] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [postBody, setPostBody] = useState("");
  const [notifyFollowers, setNotifyFollowers] = useState(false);

  type ItemStat = {
    itemId: string; sku: string; name: string; priceCents: number; quantity: number;
    unitsSold: number; revenueCents: number; daysOnFloor: number; daysSinceLastSale: number | null;
    sellThroughPercent: number; unitsPerWeek: number; runsOutInDays: number | null;
    status: "NEW" | "STRONG" | "STEADY" | "SLOW" | "DEAD" | "OUT";
  };
  type Stats = {
    items: ItemStat[];
    summary: { itemCount: number; unitsSold: number; revenueCents: number; deadCount: number; deadValueCents: number; runningOutCount: number; outOfStockCount: number };
    runningOut: ItemStat[]; deadStock: ItemStat[]; bestSellers: ItemStat[];
    busiestLabel: string | null; busiest: { sharePercent: number } | null;
  };
  const [stats, setStats] = useState<Stats | null>(null);

  type Statement = {
    year: number; years: number[];
    months: { month: number; name: string; salesCents: number; rentCents: number; payoutCents: number; adjustmentCents: number; netCents: number }[];
    totals: { grossShelfCents: number; commissionCents: number; salesCreditedCents: number; rentCents: number; payoutCents: number; adjustmentCents: number; netCents: number };
  };
  const [statement, setStatement] = useState<Statement | null>(null);
  const [statementYear, setStatementYear] = useState<number | null>(null);
  const [myPosts, setMyPosts] = useState<{ id: string; body: string; photoId: string | null; createdAt: string }[]>([]);
  const dialog = useDialog();
  const toast = useToast();

  const loadChat = useCallback(async () => {
    const r = await fetch("/api/vendor/chat");
    if (r.ok) { const d = await r.json(); setChat(d.messages); setChatMe(d.me); }
  }, []);
  const loadPosts = useCallback(async () => {
    const r = await fetch("/api/vendor/posts");
    if (r.ok) setMyPosts((await r.json()).posts);
  }, []);
  const loadStats = useCallback(async () => {
    const r = await fetch("/api/vendor/stats");
    if (r.ok) setStats(await r.json());
  }, []);

  const loadStatement = useCallback(async (year?: number) => {
    const r = await fetch(`/api/vendor/statement${year ? `?year=${year}` : ""}`);
    if (r.ok) { const d = await r.json(); setStatement(d); setStatementYear(d.year); }
  }, []);

  useEffect(() => { loadChat(); loadPosts(); }, [loadChat, loadPosts]);

  /* Loaded on demand rather than up front — both scan a vendor's whole sales
     history, and most visits to the portal are "did anything sell". */
  useEffect(() => { if (tab === "insights") void loadStats(); }, [tab, loadStats]);
  useEffect(() => { if (tab === "money" && !statement) void loadStatement(); }, [tab, statement, loadStatement]);

  const load = useCallback(async () => {
    const res = await fetch("/api/vendor/me");
    if (!res.ok) { window.location.href = "/"; return; }
    const data = await res.json();
    setMe(data);
    if (data?.vendor) {
      setPubPre(!!data.vendor.acceptsPreorders);
      setPubReq(!!data.vendor.acceptsRequests);
      setPubBlurb(data.vendor.publicBlurb || "");
      setPubSelf(data.vendor.allowSelfCheckout !== false);
    }
  }, []);

  useEffect(() => {
    const rsid = new URLSearchParams(window.location.search).get("rent_session");
    if (rsid) {
      fetch(`/api/vendor/rent-checkout?session_id=${encodeURIComponent(rsid)}`).then(async (r) => {
        const d = await r.json();
        setCardMsg(r.ok
          ? { ok: true, text: `Rent paid — and card ····${d.last4} is saved for automatic settlement going forward.` }
          : { ok: false, text: d.error || "Couldn't confirm the payment." });
        window.history.replaceState(null, "", "/vendor");
        load();
      });
      return;
    }
    const sid = new URLSearchParams(window.location.search).get("card_session");
    if (!sid) return;
    fetch(`/api/vendor/card?session_id=${encodeURIComponent(sid)}`).then(async (r) => {
      const d = await r.json();
      setCardMsg(r.ok
        ? { ok: true, text: `Card ····${d.last4} saved for automatic rent.` }
        : { ok: false, text: d.error || "Couldn't save the card." });
      window.history.replaceState(null, "", "/vendor");
      load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  usePulse(() => { load(); loadChat(); loadPosts(); });

  const loadInbox = useCallback(async () => {
    try {
      const r = await fetch("/api/vendor/inbox");
      if (r.ok) { setInbox((await r.json()).threads || []); setInboxErr(""); }
      else setInboxErr("Couldn't load your messages.");
    } catch {
      setInboxErr("Couldn't load your messages — check your connection.");
    } finally {
      setInboxLoaded(true);
    }
  }, []);
  useEffect(() => { loadInbox(); }, [loadInbox]);

  const openInboxThread = async (id: string) => {
    setInboxMsg(""); setReplyBody(""); setPo(null); setPoErr("");
    const r = await fetch(`/api/vendor/inbox/${id}`);
    if (r.ok) {
      const t = (await r.json()).thread;
      setOpenThread(t);
      if (t.type === "PREORDER") {
        const pr = await fetch(`/api/vendor/inbox/${id}/preorder`);
        if (pr.ok) setPo((await pr.json()).preorder);
      }
    } else {
      toast.error("Couldn't open that message", "Pull it up again in a moment.");
    }
  };

  const acceptPreorder = async () => {
    if (!openThread) return;
    setPoErr("");
    const r = await fetch(`/api/vendor/inbox/${openThread.id}/preorder`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "accept", description: poDesc, subtotalDollars: poAmt, expectedDate: poDate }),
    });
    const d = await r.json();
    if (!r.ok) { setPoErr(d.error || "Couldn't accept."); return; }
    toast.success("Pre-order accepted", "The payment link is on its way to the customer by email.");
    await openInboxThread(openThread.id);
    await loadInbox();
  };

  const declinePreorder = async () => {
    if (!openThread) return;
    const reason = await dialog.prompt({
      title: "Decline this pre-order",
      body: "The customer gets your reason by email. A sentence is plenty — \"I'm booked that weekend\" saves them guessing.",
      label: "Reason for the customer",
      placeholder: "I'm fully booked that weekend, sorry!",
      multiline: true,
      required: true,
      tone: "warn",
      confirmLabel: "Send the decline",
      validate: (v) => (v.trim().length < 5 ? "Give them at least a short sentence." : null),
    });
    if (reason === null) return;
    setPoErr("");
    const r = await fetch(`/api/vendor/inbox/${openThread.id}/preorder`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "decline", reason }),
    });
    const d = await r.json();
    if (!r.ok) { setPoErr(d.error || "Couldn't decline."); return; }
    toast.info("Pre-order declined", "Your reason has been emailed to the customer.");
    await openInboxThread(openThread.id);
    await loadInbox();
  };

  const sendReply = async () => {
    if (!openThread) return;
    setInboxMsg("");
    const r = await fetch(`/api/vendor/inbox/${openThread.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: replyBody }),
    });
    const d = await r.json();
    if (!r.ok) { setInboxMsg(d.error || "Couldn't send."); return; }
    setReplyBody("");
    toast.success("Reply sent", "They get it by email with a private link back to you.");
    await openInboxThread(openThread.id);
    await loadInbox();
  };

  const setThreadStatus = async (status: "OPEN" | "CLOSED") => {
    if (!openThread) return;
    await fetch(`/api/vendor/inbox/${openThread.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await openInboxThread(openThread.id);
    await loadInbox();
  };

  const loadPhotos = useCallback(async () => {
    const r = await fetch("/api/vendor/photos");
    if (r.ok) setMyPhotos((await r.json()).photos || []);
  }, []);
  useEffect(() => { loadPhotos(); }, [loadPhotos]);

  const compressImage = (file: File): Promise<{ data: string; mime: string }> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const MAX = 1200;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const k = MAX / Math.max(width, height);
          width = Math.round(width * k); height = Math.round(height * k);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("no canvas")); return; }
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        resolve({ data: dataUrl.split(",")[1], mime: "image/jpeg" });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      img.src = url;
    });

  const uploadItemPhoto = async (file: File | undefined, itemId: string) => {
    if (!file) return;
    setBusy(true);
    try {
      const { data, mime } = await compressImage(file);
      const r = await fetch("/api/vendor/photos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, mime, kind: "ITEM", itemId }) });
      const d = await r.json();
      if (!r.ok) { toast.error("Couldn't add that photo", d.error || "Try a JPEG or PNG from your phone."); return; }
      toast.success("Photo added", "It shows on your public page next to this item.");
      await loadPhotos();
    } catch {
      toast.error("That file didn't read as a photo", "Try a JPEG or PNG.");
    } finally { setBusy(false); }
  };

  const uploadPhoto = async (file: File | undefined, kind: "PRODUCT" | "LOGO" = "PRODUCT") => {
    if (!file) return;
    setPhotoBusy(true);
    try {
      const { data, mime } = await compressImage(file);
      const r = await fetch("/api/vendor/photos", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, mime, kind }),
      });
      const d = await r.json();
      if (!r.ok) { toast.error("Couldn't upload that photo", d.error || "Try again."); return; }
      toast.success(kind === "LOGO" ? "Logo updated" : "Photo added", "Customers see it on your public page.");
      await loadPhotos();
    } catch {
      toast.error("That file didn't read as a photo", "Try a JPEG or PNG.");
    } finally { setPhotoBusy(false); }
  };

  const deletePhoto = async (id: string) => {
    const yes = await dialog.confirm({
      title: "Remove this photo?",
      body: "It comes off your public page right away. The photo isn't recoverable — you'd need to upload it again.",
      confirmLabel: "Remove the photo",
      cancelLabel: "Keep it",
      tone: "danger",
    });
    if (!yes) return;
    await fetch(`/api/vendor/photos/${id}`, { method: "DELETE" });
    toast.success("Photo removed");
    await loadPhotos();
  };

  const savePublic = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/vendor/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acceptsPreorders: pubPre, acceptsRequests: pubReq, publicBlurb: pubBlurb, allowSelfCheckout: pubSelf }),
      });
      if (r.ok) toast.success("Public page saved", "Customers see the change immediately.");
      else toast.error("Couldn't save", "Try again in a moment.");
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    fetch("/api/vendor/push").then(async (r) => {
      if (r.ok) { const d = await r.json(); setPushDevices(d.devices); setPushKey(d.publicKey); }
    }).catch(() => {});
  }, []);

  const [pushBusy, setPushBusy] = useState(false);

  const enablePush = async () => {
    setPushMsg(null);
    setPushBusy(true);
    try {
      /* Shared with the admin portal. The old copy awaited
         `navigator.serviceWorker.ready`, which never rejects — if the worker
         wasn't registered it waited forever and the button just sat there. */
      const result = await subscribeToPush(pushKey);
      if (!result.ok) { setPushMsg({ ok: false, text: result.message }); return; }

      const res = await fetch("/api/vendor/push", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result.subscription),
      });
      if (!res.ok) { setPushMsg({ ok: false, text: "Your phone allowed it but we couldn't save this device — try again." }); return; }
      setPushDevices((n) => (n || 0) + 1);
      setPushMsg({ ok: true, text: "Sale alerts are on for this device. You'll get a notification instead of an email." });
      toast.success("Sale alerts on", "This device will buzz the moment something sells.");
    } catch {
      setPushMsg({ ok: false, text: "No connection — try again when you have signal." });
    } finally {
      setPushBusy(false);
    }
  };

  const disablePush = async () => {
    const yes = await dialog.confirm({
      title: "Turn off sale alerts everywhere?",
      body: "Every device you've turned alerts on for stops buzzing. You'll get one summary email at the end of each selling day instead — never an email per sale. You can turn alerts back on from any device.",
      confirmLabel: "Turn alerts off",
      cancelLabel: "Keep them on",
      tone: "warn",
    });
    if (!yes) return;
    const r = await fetch("/api/vendor/push", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true }),
    });
    if (r.ok) {
      setPushDevices(0);
      setPushMsg({ ok: true, text: "Sale alerts are off — you'll get the end-of-day summary email instead." });
      toast.success("Sale alerts off", "Daily summary email instead.");
    } else {
      toast.error("Couldn't turn them off", "Try again in a moment.");
    }
  };

  const addItem = async () => {
    setErr("");
    if (!name.trim()) return setErr("Item name required.");
    if (!price || Number(price) <= 0) return setErr("Enter a price.");
    setBusy(true);
    const res = await fetch("/api/vendor/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, priceDollars: price, quantity: qty || 0, taxClass: isFood ? "FOOD" : "STANDARD" }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json();
      setErr(data.error || "Couldn't add it.");
      return;
    }
    toast.success(`${name.trim()} added`, "Print a label for it and it's ready to scan.");
    setName(""); setPrice(""); setQty(""); setIsFood(false);
    await load();
  };

  const patchItem = async (id: string, body: object): Promise<boolean> => {
    setBusy(true);
    const r = await fetch(`/api/vendor/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({} as { error?: string }));
      toast.error("Couldn't save that change", d.error || "Try again in a moment.");
    }
    await load();
    setBusy(false);
    return r.ok;
  };

  const restockItem = async (it: Item) => {
    const v = await dialog.prompt({
      title: `Restock ${it.name}`,
      body: `There ${it.quantity === 1 ? "is" : "are"} ${plural(it.quantity, "unit")} on the floor right now. Enter how many you're ADDING — the count goes up by that much.`,
      label: "How many are you adding?",
      hint: "To correct a wrong count instead, open the item and edit the floor total.",
      type: "number",
      placeholder: "6",
      required: true,
      confirmLabel: "Add to the floor",
      validate: (raw) => {
        const n = Math.round(Number(raw));
        if (!raw.trim() || Number.isNaN(n)) return "Enter a number.";
        if (n <= 0) return "Enter at least 1.";
        if (n > 999) return "999 at a time is the most the register will take.";
        return null;
      },
    });
    if (v === null) return;
    const ok = await patchItem(it.id, { addQuantity: v });
    if (ok) toast.success("Floor count updated", `${plural(Math.round(Number(v)), "unit")} added to ${it.name}.`);
  };

  const runSaleOnEverything = async () => {
    const v = await dialog.prompt({
      title: "Run a sale on everything",
      body: "Every active item drops by this much. The register and your online page both charge the sale price automatically — your labels don't need reprinting.",
      label: "Percent off",
      hint: "Anything from 0 to 90. Entering 0 puts everything back to full price.",
      type: "number",
      placeholder: "10",
      required: true,
      confirmLabel: "Start the sale",
      validate: (raw) => {
        const n = Math.round(Number(raw));
        if (!raw.trim() || Number.isNaN(n)) return "Enter a number between 0 and 90.";
        if (n < 0 || n > 90) return "A sale has to be between 0% and 90%.";
        return null;
      },
    });
    if (v === null) return;
    setBusy(true);
    try {
      const r = await fetch("/api/vendor/items/sale-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ percent: v }) });
      const d = await r.json();
      if (!r.ok) { toast.error("Couldn't start the sale", d.error || "Try again."); return; }
      toast.success(
        Math.round(Number(v)) === 0 ? "Sales ended" : `${Math.round(Number(v))}% off everything`,
        `${plural(d.updated ?? 0, "item")} updated.`
      );
      await load();
    } finally { setBusy(false); }
  };

  const endAllSales = async () => {
    const yes = await dialog.confirm({
      title: "End every sale?",
      body: "All of your items go back to full price right away, at the register and online. You can start another sale any time.",
      confirmLabel: "Back to full price",
      cancelLabel: "Leave the sale running",
    });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await fetch("/api/vendor/items/sale-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ percent: 0 }) });
      if (r.ok) { toast.success("Sales ended", "Everything is back to full price."); await load(); }
      else toast.error("Couldn't end the sale", "Try again in a moment.");
    } finally { setBusy(false); }
  };

  const retireItem = async (it: Item) => {
    const yes = await dialog.confirm({
      title: `Retire ${it.name}?`,
      body: "It comes off the floor, its count goes to zero, and its barcode stops scanning at the register. Your sales history is kept, and you can bring it back any time.",
      confirmLabel: "Retire it",
      cancelLabel: "Keep it selling",
      tone: "warn",
    });
    if (!yes) return;
    const ok = await patchItem(it.id, { active: false, quantity: 0 });
    if (ok) { toast.success(`${it.name} retired`, "It's off the floor and can't be scanned."); setEditItem(null); }
  };

  const deleteItem = async (it: Item) => {
    const yes = await dialog.confirm({
      title: `Delete ${it.name} completely?`,
      body: "This erases the item and its barcode for good — it can't be undone. If it has ever sold, it gets retired instead so the books stay whole.",
      confirmLabel: "Delete it",
      cancelLabel: "Keep it",
      tone: "danger",
    });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/vendor/items/${it.id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) { toast.error("Couldn't delete it", d.error || "Try again."); return; }
      if (d.retired) {
        await dialog.alert({
          title: "Retired instead of deleted",
          body: d.message,
          tone: "warn",
        });
      } else {
        toast.success(`${it.name} deleted`);
      }
      setEditItem(null);
      await load();
    } finally { setBusy(false); }
  };

  const publishPost = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/vendor/posts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: postBody, notifyFollowers }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't post that", d.error || "Try again."); return; }
      setPostBody(""); setNotifyFollowers(false);
      if (d.error) {
        // Posted, but the notification was held back — say which happened.
        toast.success("Posted to the market feed", String(d.error));
      } else if (typeof d.notified === "number" && notifyFollowers) {
        toast.success(
          "Posted and sent",
          d.notified > 0
            ? `${d.notified} follower${d.notified === 1 ? "" : "s"} emailed.`
            : "Nobody follows you with an email address yet — the post is still up."
        );
      } else {
        toast.success("Posted to the market feed", "Customers see it on the market page now.");
      }
      loadPosts();
    } finally { setBusy(false); }
  };

  const deletePost = async (id: string) => {
    const yes = await dialog.confirm({
      title: "Delete this post?",
      body: "It comes off the market feed for everyone. You can't undo it, but you can always post again.",
      confirmLabel: "Delete the post",
      cancelLabel: "Keep it",
      tone: "danger",
    });
    if (!yes) return;
    await fetch("/api/vendor/posts", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    toast.success("Post deleted");
    loadPosts();
  };

  const startRentCheckout = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/vendor/rent-checkout", { method: "POST" });
      const d = await r.json();
      if (!r.ok) { toast.error("Couldn't start the payment", d.error || "Try again."); return; }
      window.location.href = d.url;
    } finally { setBusy(false); }
  };

  const startCardSetup = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/vendor/card", { method: "POST" });
      const d = await r.json();
      if (!r.ok) { toast.error("Couldn't start card setup", d.error || "Try again."); return; }
      window.location.href = d.url;
    } finally { setBusy(false); }
  };

  const removeCard = async () => {
    const yes = await dialog.confirm({
      title: "Remove your card on file?",
      body: "Rent your sales don't cover would then need cash or a check at the market — nothing will charge automatically. You can add a card again whenever you like.",
      confirmLabel: "Remove the card",
      cancelLabel: "Keep it on file",
      tone: "danger",
    });
    if (!yes) return;
    const r = await fetch("/api/vendor/card", { method: "DELETE" });
    if (r.ok) {
      setCardMsg({ ok: true, text: "Card removed." });
      toast.success("Card removed", "Unpaid rent now needs cash or a check.");
      load();
    } else {
      toast.error("Couldn't remove the card", "Try again in a moment.");
    }
  };

  /* Enter and the Send button ran two near-identical copies of this. */
  const sendChat = async () => {
    const b = chatBody.trim();
    if (!b || chatBusy) return;
    setChatBody("");
    setChatBusy(true);
    try {
      const r = await fetch("/api/vendor/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: b }) });
      if (!r.ok) { setChatBody(b); toast.error("Message didn't send", "Your text is still in the box — try again."); return; }
      await loadChat();
    } finally { setChatBusy(false); }
  };

  const changePw = async () => {
    setPwErr("");
    if (pwNew !== pwNew2) { setPwErr("The two passwords do not match — type them again."); return; }
    setPwBusy(true);
    const res = await fetch("/api/vendor/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: pwCur, newPassword: pwNew }),
    });
    const data = await res.json();
    setPwBusy(false);
    if (!res.ok) { setPwErr(data.error || "Couldn't change your password."); return; }
    toast.success("Password changed", "Use the new one next time you sign in.");
    setPwCur(""); setPwNew(""); setPwNew2("");
    await load();
  };

  const logout = async () => {
    await fetch("/api/vendor/logout", { method: "POST" });
    window.location.href = "/";
  };

  /* ----------------------------------------------------------- loading -- */

  if (!me) {
    return (
      <main className="content" aria-busy="true">
        <div className="stack g-3 mb-5">
          <Skeleton width={140} height={13} />
          <Skeleton width={240} height={26} />
        </div>
        <SkeletonStats count={4} />
        <div className="stack g-4 mt-5">
          <Skeleton height={130} radius="var(--r-lg)" />
          <Skeleton height={220} radius="var(--r-lg)" />
        </div>
      </main>
    );
  }

  /* -------------------------------------------- forced password change -- */

  if (me.vendor.mustChangePassword) {
    return (
      <main className="row center" style={{ minHeight: "100dvh", padding: "var(--sp-6) var(--sp-4)" }}>
        <div style={{ width: "100%", maxWidth: 400 }}>
          <div style={{ textAlign: "center", marginBottom: "var(--sp-6)" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" style={{ width: 88, height: 88, margin: "0 auto var(--sp-3)" }} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wordmark.png" alt="Community Harvest" style={{ width: 190, maxWidth: "70%", height: "auto", margin: "0 auto" }} />
            <p className="t-label mt-2">Food and Craft Market</p>
          </div>

          <Card title="Set your own password">
            <div className="stack g-4">
              <p className="t-sm t-secondary">
                You signed in with the temporary password from your email. Pick your own before
                continuing &mdash; it&rsquo;s the one you&rsquo;ll use from now on.
              </p>
              <PasswordForm
                requireCurrent={false}
                cur={pwCur}
                next={pwNew}
                again={pwNew2}
                onCur={setPwCur}
                onNext={setPwNew}
                onAgain={setPwNew2}
                onSubmit={changePw}
                busy={pwBusy}
                error={pwErr}
                submitLabel="Save and continue"
              />
            </div>
          </Card>
        </div>
      </main>
    );
  }

  /* --------------------------------------------------------- derived -- */

  const needsReply = inbox.filter((t) => t.status === "OPEN" && t.last && t.last.sender !== "VENDOR").length;
  const activeItems = me.items.filter((it) => it.active);
  const retiredItems = me.items.filter((it) => !it.active);
  const floorUnits = me.items.reduce((n, i) => n + (i.active ? i.quantity : 0), 0);
  const lowStock = activeItems.filter((it) => it.quantity <= LOW_STOCK).length;
  const onSale = activeItems.filter((it) => (it.salePercent || 0) > 0).length;
  const meta = TAB_META[tab];
  const editing = activeItems.find((it) => it.id === editItem) || null;
  const navBadge: Partial<Record<VendorTab, number>> = { inbox: needsReply };

  const go = (t: VendorTab) => { setTab(t); setMoreOpen(false); window.scrollTo({ top: 0 }); };

  const itemColumns: Column<Item>[] = [
    {
      key: "name",
      header: "Item",
      primary: true,
      sortBy: (it) => it.name,
      cell: (it) => (
        <div className="stack g-1" style={{ minWidth: 0 }}>
          <b className="truncate">{it.name}</b>
          <span className="t-xs t-muted mono">{it.sku}</span>
        </div>
      ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      sortBy: (it) => effectivePriceCents(it),
      cell: (it) => (
        <span className="row end g-2 wrap">
          {(it.salePercent || 0) > 0 ? (
            <s className="t-muted num">{money(it.priceCents)}</s>
          ) : null}
          <b className={`num ${(it.salePercent || 0) > 0 ? "t-danger" : ""}`}>{money(effectivePriceCents(it))}</b>
          {(it.salePercent || 0) > 0 ? (
            <Badge tone="danger" icon="tag">{it.salePercent}% off</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "stock",
      header: "On the floor",
      align: "right",
      sortBy: (it) => it.quantity,
      cell: (it) => (
        <span className="row end g-2 wrap">
          <span className="num">{it.quantity}</span>
          {it.quantity === 0 ? (
            <Badge tone="danger" dot>Sold out</Badge>
          ) : it.quantity <= LOW_STOCK ? (
            <Badge tone="warn" dot>Low stock</Badge>
          ) : null}
        </span>
      ),
    },
  ];

  const ledgerColumns: Column<Ledger>[] = [
    {
      key: "date",
      header: "Date",
      width: "150px",
      sortBy: (l) => l.createdAt,
      cell: (l) => <span className="t-sm">{fmtDate(l.createdAt)}</span>,
    },
    {
      key: "activity",
      header: "Activity",
      primary: true,
      sortBy: (l) => l.note || l.type,
      cell: (l) => (
        <span className="row g-2" style={{ minWidth: 0 }}>
          <Icon name={LEDGER_ICON(l.type)} size={14} />
          <span className="truncate">{l.note || l.type}</span>
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      sortBy: (l) => l.amountCents,
      cell: (l) => (
        <b className={`num ${l.amountCents >= 0 ? "t-accent" : "t-danger"}`}>
          {l.amountCents >= 0 ? "+" : "−"}{money(Math.abs(l.amountCents))}
        </b>
      ),
    },
  ];

  const logoPhotos = myPhotos.filter((ph) => ph.kind === "LOGO");
  const productPhotos = myPhotos.filter((ph) => ph.kind !== "LOGO");

  return (
    <div className="shell">
      <a href="#main-content" className="btn btn-primary btn-sm sr-only">Skip to content</a>

      {/* ------------------------------------------------------------ sidebar */}
      <nav className="sidebar no-print" aria-label="Vendor portal sections">
        <div className="sidebar-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 30, height: 30, flex: "0 0 auto" }} />
          <div style={{ minWidth: 0 }}>
            <div className="t-card truncate">{me.vendor.businessName}</div>
            <div className="t-xs t-muted truncate">
              Vendor {me.vendor.code}
              {me.vendor.commissionPercent > 0 ? ` · ${me.vendor.commissionPercent}% commission` : ""}
            </div>
          </div>
        </div>

        <div className="sidebar-nav">
          <div className="stack" style={{ gap: 2 }}>
            {VENDOR_TABS.map((t) => (
              <button
                key={t}
                type="button"
                className="nav-item"
                aria-current={tab === t ? "page" : undefined}
                onClick={() => go(t)}
              >
                <Icon name={TAB_META[t].icon} size={16} />
                <span className="truncate">{TAB_META[t].label}</span>
                {navBadge[t] ? <span className="nav-item-count">{navBadge[t]}</span> : null}
              </button>
            ))}
          </div>

          <div className="nav-group-label">Print &amp; share</div>
          <div className="stack" style={{ gap: 2 }}>
            <a className="nav-item" href="/vendor/labels">
              <Icon name="tag" size={16} /><span className="truncate">Barcode labels</span>
            </a>
            <a className="nav-item" href="/vendor/qr">
              <Icon name="print" size={16} /><span className="truncate">Table QR card</span>
            </a>
            <a className="nav-item" href={`/v/${me.vendor.code}`} target="_blank" rel="noopener">
              <Icon name="external" size={16} /><span className="truncate">My public page</span>
            </a>
          </div>
        </div>

        <div className="sidebar-foot stack g-2">
          <div
            className="stack"
            style={{
              padding: "var(--sp-2) var(--sp-3)",
              borderRadius: "var(--r-md)",
              background: "var(--accent-soft)",
              color: "var(--accent-text)",
            }}
          >
            <span className="t-label" style={{ color: "inherit", opacity: 0.8 }}>Your balance</span>
            <span className="num t-sm" style={{ fontWeight: 650 }}>{money(me.balance)}</span>
          </div>
          <Button size="sm" variant="ghost" icon="logout" onClick={logout} block>
            Sign out
          </Button>
        </div>
      </nav>

      {/* --------------------------------------------------------------- main */}
      <div className="shell-main">
        <header className="topbar no-print">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 28, height: 28, flex: "0 0 auto" }} className="topbar-logo" />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="t-card truncate">{meta.label}</div>
          </div>
          <div className="row g-3 shrink0" style={{ textAlign: "right" }}>
            <div>
              <div className="t-label">Balance</div>
              <div className={`num t-sm ${me.balance >= 0 ? "" : "t-danger"}`} style={{ fontWeight: 650 }}>
                {money(me.balance)}
              </div>
            </div>
          </div>
        </header>

        <main className="content" id="main-content">
          <style>{`
            @media (min-width: 901px) { .topbar-logo { display: none; } }
          `}</style>

          <PageHeader title={meta.label} subtitle={meta.sub} />

          {cardMsg ? (
            <div className="mb-4">
              <Note
                tone={cardMsg.ok ? "success" : "error"}
                action={<Button size="sm" variant="ghost" icon="close" onClick={() => setCardMsg(null)}>Dismiss</Button>}
              >
                {cardMsg.text}
              </Note>
            </div>
          ) : null}

          {/* ------------------------------------------------------------ home */}
          {tab === "home" && (
            <div className="stack g-4">
              <div className="grid-auto" style={{ ["--min" as string]: "200px" }}>
                <Stat feature label="Your balance" value={money(me.balance)} sub={me.balance >= 0 ? "Paid out monthly" : "Rent due"} icon="dollar" />
                <Stat label="Sold this month" value={money(me.monthSales)} sub={`Your net ${money(me.monthNet)}`} icon="receipt" />
                <Stat label="On the floor" value={String(floorUnits)} sub={`${plural(activeItems.length, "item")} selling`} icon="box" />
                <Stat
                  label="Needs a reply"
                  value={String(needsReply)}
                  sub={needsReply > 0 ? "open messages" : "all caught up"}
                  icon="inbox"
                />
              </div>

              {activeItems.length === 0 ? (
                <Card title="Welcome — three steps and you're selling">
                  <div className="stack g-4">
                    <ol className="stack g-2 t-body" style={{ margin: 0, paddingLeft: "1.1rem", listStyle: "decimal" }}>
                      <li><b>Add your items</b> with a price and how many you&rsquo;re bringing.</li>
                      <li><b>Print your barcode labels</b> and sticker every item.</li>
                      <li><b>Stock your booth</b> during a restock window — the register does the rest.</li>
                    </ol>
                    <div>
                      <Button variant="primary" icon="plus" onClick={() => go("items")}>
                        Add my first item
                      </Button>
                    </div>
                  </div>
                </Card>
              ) : null}

              {lowStock > 0 ? (
                <Note
                  tone="warn"
                  title={`${plural(lowStock, "item is", "items are")} running low`}
                  action={<Button size="sm" variant="secondary" onClick={() => go("items")}>See items</Button>}
                >
                  Anything at {LOW_STOCK} units or fewer is close to selling out. Restock it on your next trip in.
                </Note>
              ) : null}

              <Card title="Quick actions">
                <div className="row wrap g-2">
                  <LinkButton href="/vendor/sell" variant="primary" icon="register">Ring up a sale</LinkButton>
                  <Button variant="secondary" icon="plus" onClick={() => go("items")}>Add an item</Button>
                  <LinkButton href="/vendor/labels" variant="secondary" icon="tag">Print labels</LinkButton>
                  <LinkButton href="/vendor/qr" variant="secondary" icon="print">Print table QR</LinkButton>
                  <LinkButton href={`/v/${me.vendor.code}`} variant="secondary" icon="eye" external>View my public page</LinkButton>
                  <LinkButton href="/rules" variant="ghost" icon="clipboard" external>Market rules</LinkButton>
                  <LinkButton href="/guide" variant="ghost" icon="help" external>Setup guide</LinkButton>
                  {me.vendor.contracts && me.vendor.contracts[0] ? (
                    <LinkButton
                      href={`/contract/${me.vendor.contracts[0].id}/packet`}
                      variant={me.vendor.contracts[0].vendorSignedAt ? "secondary" : "primary"}
                      icon="contract"
                    >
                      {me.vendor.contracts[0].vendorSignedAt ? "My agreement" : "Sign your agreement"}
                    </LinkButton>
                  ) : null}
                </div>
              </Card>

              <Card
                title="Recent activity"
                actions={
                  <Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => go("money")}>
                    Full statement
                  </Button>
                }
                flush
              >
                <DataTable
                  rows={me.ledger.slice(0, 6)}
                  columns={ledgerColumns}
                  rowKey={(l) => l.id}
                  mobileCards
                  caption="Your six most recent ledger entries"
                  empty={
                    <div className="card-body">
                      <EmptyState
                        icon="receipt"
                        title="Nothing on your statement yet"
                        body="Sales, rent, and payouts show up here once you're rolling."
                      />
                    </div>
                  }
                />
              </Card>
            </div>
          )}

          {/* ----------------------------------------------------------- items */}
          {tab === "items" && (
            <div className="stack g-4">
              <Card
                title="Your items on the floor"
                subtitle={`${plural(activeItems.length, "item")} selling · ${plural(floorUnits, "unit")} in stock${onSale > 0 ? ` · ${onSale} on sale` : ""}`}
                actions={
                  <>
                    {/* Distinct icons: these sat side by side both showing a tag. */}
                    <LinkButton href="/vendor/labels" variant="secondary" icon="print">
                      Print labels
                    </LinkButton>
                    <Button variant="secondary" icon="tag" disabled={busy} onClick={runSaleOnEverything}>
                      Put everything on sale
                    </Button>
                    {onSale > 0 ? (
                      <Button variant="dangerSoft" icon="close" disabled={busy} onClick={endAllSales}>
                        End all sales
                      </Button>
                    ) : null}
                  </>
                }
                flush
              >
                <DataTable
                  rows={activeItems}
                  columns={itemColumns}
                  rowKey={(it) => it.id}
                  defaultSort={{ key: "name", dir: "asc" }}
                  mobileCards
                  caption="Your active items, prices, and floor counts"
                  onRowClick={(it) => {
                    setEditItem(it.id);
                    setEditIF({ name: it.name, price: String(it.priceCents / 100), qty: String(it.quantity), sale: String(it.salePercent || 0), food: String(it.taxClass || "STANDARD").toUpperCase() === "FOOD" });
                  }}
                  empty={
                    <div className="card-body">
                      <EmptyState
                        icon="box"
                        title="No items yet"
                        body="Add your first one below — it takes about twenty seconds, and every item gets its own barcode."
                      />
                    </div>
                  }
                />
              </Card>

              {retiredItems.length > 0 ? (
                <Card
                  title="Retired items"
                  subtitle="Off the floor, history kept. Bringing one back re-activates its barcode — old labels still scan."
                  flush
                >
                  <DataTable
                    rows={retiredItems}
                    columns={[
                      {
                        key: "name",
                        header: "Item",
                        primary: true,
                        sortBy: (it) => it.name,
                        cell: (it) => (
                          <div className="stack g-1" style={{ minWidth: 0 }}>
                            <b className="truncate">{it.name}</b>
                            <span className="t-xs t-muted mono">{it.sku}</span>
                          </div>
                        ),
                      },
                      {
                        key: "price",
                        header: "Price",
                        align: "right",
                        sortBy: (it) => it.priceCents,
                        cell: (it) => <span className="num">{money(it.priceCents)}</span>,
                      },
                      {
                        key: "back",
                        header: "",
                        align: "right",
                        cell: (it) => (
                          <Button
                            size="sm"
                            variant="secondary"
                            icon="refresh"
                            disabled={busy}
                            onClick={async () => {
                              const ok = await patchItem(it.id, { active: true });
                              if (ok) toast.success(`${it.name} is back`, "Restock it and it's selling again.");
                            }}
                          >
                            Bring back
                          </Button>
                        ),
                      },
                    ]}
                    rowKey={(it) => it.id}
                    mobileCards
                    caption="Retired items you can reactivate"
                  />
                </Card>
              ) : null}

              <Card title="Add an item" subtitle="Each item gets its own barcode. Print labels, sticker your goods, restock any time.">
                <form
                  className="stack g-4"
                  onSubmit={(e) => { e.preventDefault(); addItem(); }}
                >
                  <Field label="Item name" hint="This prints on your labels." required>
                    {(p) => (
                      <Input
                        {...p}
                        value={name}
                        placeholder="Hand-poured soy candle"
                        onChange={(e) => { setName(e.target.value); setErr(""); }}
                      />
                    )}
                  </Field>
                  <div className="grid-auto" style={{ ["--min" as string]: "180px" }}>
                    <Field label="Price (dollars)" required>
                      {(p) => (
                        <Input
                          {...p}
                          type="number"
                          min="0.5"
                          step="0.5"
                          inputMode="decimal"
                          placeholder="14"
                          value={price}
                          onChange={(e) => { setPrice(e.target.value); setErr(""); }}
                        />
                      )}
                    </Field>
                    <Field label="Quantity you're putting out" hint="You can restock any time.">
                      {(p) => (
                        <Input
                          {...p}
                          type="number"
                          min="0"
                          step="1"
                          inputMode="numeric"
                          placeholder="6"
                          value={qty}
                          onChange={(e) => setQty(e.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                  {/* Oklahoma dropped the state's 4.5% on food and food
                      ingredients in 2024 but kept the local portion, so this
                      changes the tax the register charges. */}
                  <Checkbox
                    checked={isFood}
                    onCheckedChange={setIsFood}
                    label="This is a food item"
                    hint="Groceries are taxed at a lower rate than crafts. Tick this for anything edible — jam, honey, produce, baked goods, spices."
                  />
                  {err ? <Note tone="error">{err}</Note> : null}
                  <div>
                    <Button type="submit" variant="primary" size="lg" icon="plus" loading={busy}>
                      Add item
                    </Button>
                  </div>
                </form>
              </Card>
            </div>
          )}

          {/* ----------------------------------------------------------- inbox */}
          {tab === "inbox" && (
            <Card
              title="Pre-orders, requests and complaints"
              subtitle={needsReply > 0 ? `${plural(needsReply, "message needs", "messages need")} a reply` : "Everything's answered"}
            >
              {!inboxLoaded ? (
                <div className="stack g-2" aria-busy="true">
                  <Skeleton height={58} radius="var(--r-lg)" />
                  <Skeleton height={58} radius="var(--r-lg)" />
                  <Skeleton height={58} radius="var(--r-lg)" />
                </div>
              ) : inboxErr ? (
                <Note
                  tone="error"
                  title="Your messages didn't load"
                  action={<Button size="sm" variant="secondary" icon="refresh" onClick={loadInbox}>Try again</Button>}
                >
                  {inboxErr}
                </Note>
              ) : inbox.length === 0 ? (
                <EmptyState
                  icon="inbox"
                  title="Nothing here yet"
                  body="Customers reach you from your table QR card and your public page. Anything they send lands here."
                  action={<LinkButton href="/vendor/qr" variant="secondary" icon="print">Print my table QR</LinkButton>}
                />
              ) : (
                <div className="stack g-2">
                  {inbox.map((t) => {
                    const unread = t.status === "OPEN" && !!t.last && t.last.sender !== "VENDOR";
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className="card-link card-pad-sm"
                        onClick={() => openInboxThread(t.id)}
                      >
                        <div className="row between g-2 wrap">
                          <span className="row g-2" style={{ minWidth: 0 }}>
                            <Icon name={THREAD_ICON(t.type)} size={15} />
                            <b className="truncate">{t.customerName}</b>
                          </span>
                          <span className="row g-2 shrink0">
                            {unread ? <Badge tone="danger" dot>Needs a reply</Badge> : null}
                            {t.status === "CLOSED" ? <Badge tone="neutral">Closed</Badge> : null}
                          </span>
                        </div>
                        {t.last ? (
                          <p className="t-sm t-muted clamp-2 mt-1">
                            {t.last.sender === "VENDOR" ? "You: " : ""}{t.last.body}
                          </p>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </Card>
          )}

          {/* ------------------------------------------------------------ page */}
          {tab === "insights" && (
            <div className="stack g-4">
              {!stats ? (
                <div className="stack g-3" aria-busy="true">
                  <Skeleton height={80} radius="var(--r-lg)" />
                  <Skeleton height={220} radius="var(--r-lg)" />
                </div>
              ) : stats.summary.itemCount === 0 ? (
                <EmptyState
                  icon="box"
                  title="Nothing to measure yet"
                  body="Add some items and put them on the floor. Once they start selling, this page tells you which ones are worth making more of."
                  action={<Button variant="primary" icon="plus" onClick={() => go("items")}>Add items</Button>}
                />
              ) : (
                <>
                  <div className="grid-auto" style={{ ["--min" as string]: "200px" }}>
                    <Stat feature label="Sold all time" value={money(stats.summary.revenueCents)} sub={`${plural(stats.summary.unitsSold, "item")} across the counter`} icon="dollar" />
                    <Stat label="About to run out" value={String(stats.summary.runningOutCount)} sub="Within two weeks" icon="alert" />
                    <Stat label="Not selling" value={money(stats.summary.deadValueCents)} sub={`${plural(stats.summary.deadCount, "item")} sitting unsold`} icon="warning" />
                  </div>

                  {/* The most actionable thing on the page goes first: an empty
                      shelf earns nothing, and a vendor who isn't in the
                      building can't see one. */}
                  {stats.runningOut.length > 0 ? (
                    <Card title="Bring more of these" subtitle="At the rate they're selling, these run out soon.">
                      <div className="stack g-2">
                        {stats.runningOut.map((i) => (
                          <div key={i.itemId} className="row g-3" style={{ alignItems: "center" }}>
                            <span className="grow truncate" style={{ minWidth: 0 }}>
                              <b>{i.name}</b>
                              <span className="t-xs t-muted"> · {plural(i.quantity, "left")}, about {i.unitsPerWeek}/week</span>
                            </span>
                            <Badge tone={(i.runsOutInDays ?? 99) <= 5 ? "danger" : "warn"} dot>
                              {i.runsOutInDays === 0 ? "Gone today" : `~${plural(i.runsOutInDays ?? 0, "day")}`}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </Card>
                  ) : null}

                  {stats.bestSellers.length > 0 ? (
                    <Card title="Your best earners" subtitle="By money made, not units — twenty cheap things isn't a hit.">
                      <div className="stack g-2">
                        {stats.bestSellers.map((i, n) => (
                          <div key={i.itemId} className="row g-3" style={{ alignItems: "center" }}>
                            <span className="num t-muted" style={{ width: 20 }}>{n + 1}</span>
                            <span className="grow truncate" style={{ minWidth: 0 }}>
                              <b>{i.name}</b>
                              <span className="t-xs t-muted"> · {plural(i.unitsSold, "sold")} · {i.sellThroughPercent}% of what you brought</span>
                            </span>
                            <span className="num">{money(i.revenueCents)}</span>
                          </div>
                        ))}
                      </div>
                    </Card>
                  ) : null}

                  {stats.deadStock.length > 0 ? (
                    <Card
                      title="Taking up space"
                      subtitle="On the floor two months or more without a single sale. Worth re-pricing, re-photographing, or swapping out."
                    >
                      <div className="stack g-2">
                        {stats.deadStock.map((i) => (
                          <div key={i.itemId} className="row g-3" style={{ alignItems: "center" }}>
                            <span className="grow truncate" style={{ minWidth: 0 }}>
                              <b>{i.name}</b>
                              <span className="t-xs t-muted"> · {plural(i.daysOnFloor, "day")} on the floor · {plural(i.quantity, "unit")} at {money(i.priceCents)}</span>
                            </span>
                            <Badge tone="neutral">{money(i.priceCents * i.quantity)} tied up</Badge>
                          </div>
                        ))}
                      </div>
                    </Card>
                  ) : null}

                  {stats.busiestLabel ? (
                    <Note tone="info" title="Your busiest hour">
                      <b>{stats.busiestLabel}</b> — {stats.busiest?.sharePercent}% of everything you sell goes out then.
                      Worth having a full shelf before it.
                    </Note>
                  ) : null}

                  <Card title="Every item" subtitle="Sorted by money made.">
                    <div className="stack g-2">
                      {stats.items.map((i) => (
                        <div key={i.itemId} className="row g-3" style={{ alignItems: "center" }}>
                          <span className="grow truncate" style={{ minWidth: 0 }}>
                            <b>{i.name}</b>
                            <span className="t-xs t-muted"> · {plural(i.unitsSold, "sold")} · {plural(i.quantity, "left")}</span>
                          </span>
                          <Badge
                            tone={
                              i.status === "STRONG" ? "success"
                              : i.status === "STEADY" ? "info"
                              : i.status === "OUT" ? "warn"
                              : i.status === "NEW" ? "neutral"
                              : i.status === "DEAD" ? "danger" : "warn"
                            }
                            dot
                          >
                            {i.status === "STRONG" ? "Selling well"
                              : i.status === "STEADY" ? "Ticking along"
                              : i.status === "SLOW" ? "Slowed down"
                              : i.status === "DEAD" ? "Not selling"
                              : i.status === "OUT" ? "Sold out"
                              : "Too new to tell"}
                          </Badge>
                          <span className="num" style={{ minWidth: 72, textAlign: "right" }}>{money(i.revenueCents)}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                </>
              )}
            </div>
          )}

          {tab === "page" && (
            <div className="stack g-4">
              <Card
                title="Post to the market feed"
                subtitle="Announcements, new products, what's coming out of the oven — customers see these on the market page instantly."
              >
                <div className="stack g-4">
                  <Field label="What's your news?">
                    {(p) => (
                      <Textarea
                        {...p}
                        rows={3}
                        placeholder="Fresh sourdough hitting the shelf at noon!"
                        value={postBody}
                        onChange={(e) => setPostBody(e.target.value)}
                      />
                    )}
                  </Field>
                  {/* The vendors who sell most are the ones marketing
                      themselves, and most won't, because "post on Instagram" is
                      a job. They already have followers here — one tick does it. */}
                  <Checkbox
                    checked={notifyFollowers}
                    onCheckedChange={setNotifyFollowers}
                    label="Email the customers who follow me"
                    hint="Only people who chose to follow you, never the market's whole list. Once a day at most, so nobody mutes you."
                  />
                  <div>
                    <Button
                      variant="primary"
                      icon={notifyFollowers ? "mail" : "message"}
                      loading={busy}
                      disabled={!postBody.trim()}
                      onClick={publishPost}
                    >
                      {notifyFollowers ? "Post and tell my followers" : "Post to the feed"}
                    </Button>
                  </div>

                  {myPosts.length > 0 ? (
                    <div className="stack g-2">
                      <hr className="divider" />
                      {myPosts.map((p) => (
                        <div key={p.id} className="row-top between g-3">
                          <div className="stack g-1" style={{ minWidth: 0 }}>
                            <span className="t-body">{p.body}</span>
                            <span className="t-xs t-muted">{fmtDateTime(p.createdAt)}</span>
                          </div>
                          <IconButton
                            icon="trash"
                            label={`Delete the post from ${fmtDate(p.createdAt)}`}
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => deletePost(p.id)}
                          />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </Card>

              <Card
                title="Your public page and table QR"
                subtitle="Customers scan your table card to see your goods, review you, and message you."
                footer={
                  <div className="row wrap g-2">
                    <Button variant="primary" icon="check" loading={busy} onClick={savePublic}>Save</Button>
                    <LinkButton href="/vendor/qr" variant="secondary" icon="print">Print my table QR card</LinkButton>
                    <LinkButton href={`/v/${me.vendor.code}`} variant="ghost" icon="eye" external>View my public page</LinkButton>
                  </div>
                }
              >
                <div className="stack g-5">
                  <div className="stack g-2">
                    <p className="t-sm t-secondary">
                      Complaints are always open — that&rsquo;s a market rule — but pre-orders and
                      requests are up to you.
                    </p>
                    <Checkbox checked={pubPre} onCheckedChange={setPubPre} label="Accept pre-orders" />
                    <Checkbox checked={pubReq} onCheckedChange={setPubReq} label="Accept requests" />
                    <Checkbox
                      checked={pubSelf}
                      onCheckedChange={setPubSelf}
                      label="Allow self-checkout"
                      hint="Shoppers can scan and pay for your items on their own phone. Off means register only."
                    />
                  </div>

                  <hr className="divider" />

                  <div className="stack g-3">
                    <Field
                      label="Your logo"
                      hint="Optional — it brands your card on the market directory. Uploading a new logo replaces the old one."
                    >
                      {(p) => (
                        <input
                          {...p}
                          className="input"
                          type="file"
                          accept="image/*"
                          disabled={photoBusy}
                          onChange={(e) => { uploadPhoto(e.target.files?.[0], "LOGO"); e.target.value = ""; }}
                        />
                      )}
                    </Field>
                    <div className="row wrap g-3">
                      {logoPhotos.map((ph) => (
                        <span key={ph.id} style={{ position: "relative", display: "inline-block" }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/public/photo/${ph.id}`}
                            alt="Your logo"
                            style={{ height: 72, width: "auto", border: "1px solid var(--border)", borderRadius: "var(--r-md)", display: "block" }}
                          />
                          {/* 34px minimum — the old × was a 20px target nobody could hit. */}
                          <IconButton
                            icon="close"
                            label="Remove photo"
                            size="sm"
                            variant="secondary"
                            onClick={() => deletePhoto(ph.id)}
                            style={{
                              position: "absolute",
                              top: -10,
                              right: -10,
                              borderRadius: "var(--r-full)",
                              background: "var(--surface)",
                            }}
                          />
                        </span>
                      ))}
                      {logoPhotos.length === 0 ? (
                        <p className="t-sm t-muted">
                          No logo — your card shows your name in market style, which looks sharp too.
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="stack g-3">
                    <Field
                      label="Product photos"
                      hint="Up to six. Phone photos work great — they showcase on your public page."
                    >
                      {(p) => (
                        <input
                          {...p}
                          className="input"
                          type="file"
                          accept="image/*"
                          disabled={photoBusy}
                          onChange={(e) => { uploadPhoto(e.target.files?.[0], "PRODUCT"); e.target.value = ""; }}
                        />
                      )}
                    </Field>
                    <div className="row wrap g-3">
                      {productPhotos.map((ph) => (
                        <span key={ph.id} style={{ position: "relative", display: "inline-block" }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/public/photo/${ph.id}`}
                            alt=""
                            style={{ height: 92, width: "auto", border: "1px solid var(--border)", borderRadius: "var(--r-md)", display: "block" }}
                          />
                          <IconButton
                            icon="close"
                            label="Remove photo"
                            size="sm"
                            variant="secondary"
                            onClick={() => deletePhoto(ph.id)}
                            style={{
                              position: "absolute",
                              top: -10,
                              right: -10,
                              borderRadius: "var(--r-full)",
                              background: "var(--surface)",
                            }}
                          />
                        </span>
                      ))}
                      {productPhotos.length === 0 ? (
                        <p className="t-sm t-muted">No photos yet — phone photos work great.</p>
                      ) : null}
                    </div>
                  </div>

                  <Field label="Short blurb for your public page" hint="What you make, in a sentence. 300 characters max.">
                    {(p) => (
                      <Input
                        {...p}
                        value={pubBlurb}
                        maxLength={300}
                        placeholder="Small-batch sourdough, baked the morning of the market."
                        onChange={(e) => setPubBlurb(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
              </Card>
            </div>
          )}

          {/* ----------------------------------------------------------- money */}
          {tab === "money" && (
            <div className="stack g-4">
              <div className="grid-auto" style={{ ["--min" as string]: "200px" }}>
                <Stat feature label="Your balance" value={money(me.balance)} sub={me.balance >= 0 ? "Pays out monthly" : "Rent due"} icon="dollar" />
                <Stat label="Sold this month" value={money(me.monthSales)} sub={`Your net ${money(me.monthNet)}`} icon="receipt" />
                <Stat label="Market commission" value={`${me.vendor.commissionPercent}%`} sub="Taken off each sale" icon="chart" />
              </div>

              {/* Every vendor in every market does this with a shoebox in
                  January. The numbers are already in the ledger. */}
              <Card
                title="Year-end statement"
                subtitle="Everything that moved through the market for you, month by month — the sheet your accountant asks for."
                actions={
                  statement ? (
                    <Select
                      value={String(statementYear ?? statement.year)}
                      aria-label="Statement year"
                      onChange={(e) => { setStatement(null); void loadStatement(Number(e.target.value)); }}
                    >
                      {statement.years.map((y) => <option key={y} value={y}>{y}</option>)}
                    </Select>
                  ) : undefined
                }
              >
                {!statement ? (
                  <div className="stack g-2" aria-busy="true"><Skeleton height={18} /><Skeleton height={120} /></div>
                ) : (
                  <div className="stack g-4">
                    <div className="grid-auto" style={{ ["--min" as string]: "170px" }}>
                      <Stat label="Sold at the counter" value={money(statement.totals.grossShelfCents)} sub="Shelf price, before commission" icon="receipt" />
                      <Stat label="Market commission" value={money(statement.totals.commissionCents)} sub="Kept by the market" icon="chart" />
                      <Stat label="Credited to you" value={money(statement.totals.salesCreditedCents)} sub="Your share of sales" icon="dollar" />
                      <Stat label="Rent charged" value={money(statement.totals.rentCents)} sub="Booth rent for the year" icon="store" />
                    </div>

                    <div className="stack g-1">
                      {statement.months
                        .filter((m) => m.salesCents || m.rentCents || m.payoutCents || m.adjustmentCents)
                        .map((m) => (
                          <div key={m.month} className="row g-3" style={{ alignItems: "center" }}>
                            <span className="grow" style={{ minWidth: 0 }}>{m.name}</span>
                            <span className="num t-xs t-muted" style={{ minWidth: 90, textAlign: "right" }}>
                              {money(m.salesCents)} sold
                            </span>
                            <span className="num t-xs t-muted" style={{ minWidth: 80, textAlign: "right" }}>
                              {money(m.rentCents)} rent
                            </span>
                          </div>
                        ))}
                      {statement.months.every((m) => !m.salesCents && !m.rentCents && !m.payoutCents && !m.adjustmentCents) ? (
                        <p className="t-sm t-muted">Nothing recorded for {statement.year} yet.</p>
                      ) : null}
                    </div>

                    <div className="row wrap g-2">
                      <LinkButton
                        href={`/api/vendor/statement?year=${statement.year}&format=csv`}
                        variant="primary"
                        icon="download"
                      >
                        Download {statement.year} as a spreadsheet
                      </LinkButton>
                    </div>

                    <p className="t-xs t-muted">
                      This is a record of what went through this market for you — it isn&rsquo;t tax advice and
                      it isn&rsquo;t a 1099. Give it to whoever does your taxes.
                    </p>
                  </div>
                )}
              </Card>

              {me.balance < 0 ? (
                <Card
                  title={`Rent due: ${money(Math.abs(me.balance))}`}
                  subtitle="Your sales pay this down automatically too."
                  footer={
                    <Button variant="primary" icon="card" loading={busy} onClick={startRentCheckout}>
                      Pay {money(Math.round(Math.abs(me.balance) * 1.03))} and save the card
                    </Button>
                  }
                >
                  <Note tone="warn" title="One step pays the rent and saves your card">
                    The same payment saves your card for automatic settlement going forward. A 3%
                    card-processing adjustment applies to card payments; cash or a check at the
                    market is always fee-free.
                  </Note>
                </Card>
              ) : null}

              <Card title="Card on file — automatic rent">
                <div className="stack g-4">
                  <p className="t-sm t-secondary">
                    If your sales don&rsquo;t fully cover a month&rsquo;s rent, the remainder can charge to a
                    saved card. A 3% card-processing adjustment applies to the charged amount only —
                    cash, a check, or your sales balance never pay it. Saving a card authorizes this
                    per your agreement; you can remove it any time.
                  </p>
                  {me.vendor.cardLast4 ? (
                    <div className="row between wrap g-3">
                      <span className="row g-2">
                        <Icon name="card" size={16} />
                        <b>Card ending ····{me.vendor.cardLast4}</b>
                      </span>
                      <Button variant="dangerSoft" icon="trash" disabled={busy} onClick={removeCard}>
                        Remove card
                      </Button>
                    </div>
                  ) : (
                    <div>
                      <Button variant="secondary" icon="card" loading={busy} onClick={startCardSetup}>
                        Add a card — secure, via Stripe
                      </Button>
                    </div>
                  )}
                </div>
              </Card>

              <Card
                title="Your statement"
                subtitle="Every sale (your net after commission), booth rent, adjustment and payout. Balances pay out monthly."
                flush
              >
                <DataTable
                  rows={me.ledger}
                  columns={ledgerColumns}
                  rowKey={(l) => l.id}
                  defaultSort={{ key: "date", dir: "desc" }}
                  mobileCards
                  caption="Your full ledger"
                  empty={
                    <div className="card-body">
                      <EmptyState
                        icon="receipt"
                        title="Nothing on your statement yet"
                        body="Sales, rent, and payouts will show here."
                      />
                    </div>
                  }
                />
              </Card>
            </div>
          )}

          {/* ------------------------------------------------------------ chat */}
          {tab === "chat" && (
            <Card
              title="Vendor chat"
              subtitle="Every vendor and staff member can read this — coordinate menus, cover restocks, plan the weekend."
            >
              <div className="stack g-4">
                <div
                  className="stack g-3"
                  style={{
                    maxHeight: 420,
                    overflowY: "auto",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-md)",
                    background: "var(--bg-sunken)",
                    padding: "var(--sp-3)",
                  }}
                >
                  {chat.length === 0 ? (
                    <EmptyState icon="message" title="No messages yet" body="Say hello — everyone at the market reads this." />
                  ) : (
                    chat.map((mg) => {
                      const mine = mg.vendorId === chatMe;
                      return (
                        <div key={mg.id} style={{ textAlign: mine ? "right" : "left" }}>
                          <div className="t-xs t-muted">{mg.name} · {fmtTime(mg.createdAt)}</div>
                          <div
                            className="t-sm"
                            style={{
                              display: "inline-block",
                              textAlign: "left",
                              maxWidth: "85%",
                              marginTop: 2,
                              padding: "var(--sp-2) var(--sp-3)",
                              borderRadius: "var(--r-md)",
                              border: "1px solid var(--border)",
                              background: mine ? "var(--accent-soft)" : "var(--surface)",
                              color: mine ? "var(--accent-text)" : "inherit",
                            }}
                          >
                            {mg.body}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <Field label="Message the vendors">
                  {(p) => (
                    <div className="row g-2">
                      <Input
                        {...p}
                        className="grow"
                        placeholder="Message the vendors…"
                        value={chatBody}
                        onChange={(e) => setChatBody(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendChat(); } }}
                      />
                      <Button
                        variant="primary"
                        icon="message"
                        loading={chatBusy}
                        disabled={!chatBody.trim()}
                        onClick={sendChat}
                      >
                        Send
                      </Button>
                    </div>
                  )}
                </Field>
              </div>
            </Card>
          )}

          {/* -------------------------------------------------------- settings */}
          {tab === "settings" && (
            <div className="stack g-4">
              <Card
                title="Sale alerts"
                subtitle={
                  pushDevices !== null && pushDevices > 0
                    ? `On for ${plural(pushDevices, "device")}`
                    : "Off — you get one summary email each selling day"
                }
              >
                <div className="stack g-4">
                  <p className="t-sm t-secondary">
                    Get a push notification the moment your items sell. Without this you get one
                    summary email at the end of each selling day — never an email per sale.
                  </p>
                  <div className="row wrap g-2">
                    <Button variant="primary" icon="bell" loading={pushBusy} disabled={pushBusy} onClick={enablePush}>
                      Turn on for this device
                    </Button>
                    {pushDevices !== null && pushDevices > 0 ? (
                      <Button variant="ghost" onClick={disablePush}>
                        Turn off — daily email instead
                      </Button>
                    ) : null}
                  </div>
                  {pushMsg ? <Note tone={pushMsg.ok ? "success" : "error"}>{pushMsg.text}</Note> : null}
                  <p className="t-xs t-muted">
                    iPhone: works on iOS 16.4+ only after you add this site to your home screen
                    (share button → Add to Home Screen) and open it from that icon. Android: works
                    right in Chrome.
                  </p>
                </div>
              </Card>

              <Card title="Change password">
                <PasswordForm
                  requireCurrent
                  cur={pwCur}
                  next={pwNew}
                  again={pwNew2}
                  onCur={setPwCur}
                  onNext={setPwNew}
                  onAgain={setPwNew2}
                  onSubmit={changePw}
                  busy={pwBusy}
                  error={pwErr}
                  submitLabel="Update password"
                />
              </Card>

              <Card title="Your account">
                <div className="stack g-3">
                  <p className="t-sm t-secondary">
                    Signed in as <b>{me.vendor.email}</b> · vendor {me.vendor.code}. Need your email
                    or business name changed? Ask the market — they update it from the admin side.
                  </p>
                  <div>
                    <Button variant="secondary" icon="logout" onClick={logout}>Sign out</Button>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </main>
      </div>

      {/* ------------------------------------------------------ mobile tab bar */}
      <nav className="tabbar no-print" aria-label="Vendor portal sections">
        {PRIMARY_MOBILE.map((t) => (
          <button
            key={t}
            type="button"
            className="tabbar-item"
            aria-current={tab === t ? "page" : undefined}
            onClick={() => go(t)}
          >
            <span style={{ position: "relative", display: "block" }}>
              <Icon name={TAB_META[t].icon} size={20} />
              {navBadge[t] ? (
                <span
                  aria-hidden
                  style={{
                    position: "absolute", top: -3, right: -6,
                    minWidth: 15, height: 15, padding: "0 3px",
                    borderRadius: "var(--r-full)", background: "var(--danger)",
                    color: "#fff", fontSize: 9, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {navBadge[t]}
                </span>
              ) : null}
            </span>
            <span>{TAB_META[t].label}</span>
          </button>
        ))}
        <button
          type="button"
          className="tabbar-item"
          aria-expanded={moreOpen}
          aria-current={MORE_MOBILE.includes(tab) ? "page" : undefined}
          onClick={() => setMoreOpen(true)}
        >
          <Icon name="more" size={20} />
          <span>More</span>
        </button>
      </nav>

      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title="All sections" width="sm">
        <div className="stack g-1">
          {MORE_MOBILE.map((t) => (
            <button
              key={t}
              type="button"
              className="nav-item"
              style={{ minHeight: 46 }}
              aria-current={tab === t ? "page" : undefined}
              onClick={() => go(t)}
            >
              <Icon name={TAB_META[t].icon} size={17} />
              <span className="truncate">{TAB_META[t].label}</span>
            </button>
          ))}
          <div className="divider mt-2 mb-2" />
          <a className="nav-item" style={{ minHeight: 46 }} href="/vendor/labels">
            <Icon name="tag" size={17} /><span>Barcode labels</span>
          </a>
          <a className="nav-item" style={{ minHeight: 46 }} href="/vendor/qr">
            <Icon name="print" size={17} /><span>Table QR card</span>
          </a>
          <div className="divider mt-2 mb-2" />
          <button type="button" className="nav-item" style={{ minHeight: 46 }} onClick={logout}>
            <Icon name="logout" size={17} />
            <span>Sign out</span>
          </button>
        </div>
      </Modal>

      {/* ------------------------------------------------------- item editor */}
      {editing ? (
        <Panel
          open
          onClose={() => setEditItem(null)}
          title={editing.name}
          subtitle={`${editing.sku} · ${plural(editing.quantity, "unit")} on the floor`}
          actions={
            <Button size="sm" variant="secondary" icon="plus" disabled={busy} onClick={() => restockItem(editing)}>
              Restock
            </Button>
          }
          footer={
            <div className="row wrap g-2">
              <Button
                variant="primary"
                icon="check"
                loading={busy}
                onClick={async () => {
                  const ok = await patchItem(editing.id, {
                    name: editIF.name,
                    priceDollars: editIF.price,
                    quantity: editIF.qty,
                    salePercent: editIF.sale,
                    taxClass: editIF.food ? "FOOD" : "STANDARD",
                  });
                  if (ok) { toast.success("Item saved", "Changed the name or price? Print fresh labels so the shelf matches the register."); setEditItem(null); }
                }}
              >
                Save changes
              </Button>
              <Button variant="ghost" onClick={() => setEditItem(null)}>Cancel</Button>
            </div>
          }
        >
          <div className="stack g-5">
            <div className="stack g-3">
              <Field label="Product photo" hint="Shows online — one per product. A new upload replaces it.">
                {(p) => (
                  <input
                    {...p}
                    className="input"
                    type="file"
                    accept="image/*"
                    disabled={busy}
                    onChange={(e) => { uploadItemPhoto(e.target.files?.[0], editing.id); e.target.value = ""; }}
                  />
                )}
              </Field>
              {(() => {
                const ph = myPhotos.find((x) => x.kind === "ITEM" && x.itemId === editing.id);
                return ph ? (
                  <span style={{ position: "relative", display: "inline-block" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/public/photo/${ph.id}`}
                      alt={editing.name}
                      style={{ width: 96, height: 96, objectFit: "cover", borderRadius: "var(--r-md)", border: "1px solid var(--border)", display: "block" }}
                    />
                    <IconButton
                      icon="close"
                      label="Remove photo"
                      size="sm"
                      variant="secondary"
                      onClick={() => deletePhoto(ph.id)}
                      style={{
                        position: "absolute",
                        top: -10,
                        right: -10,
                        borderRadius: "var(--r-full)",
                        background: "var(--surface)",
                      }}
                    />
                  </span>
                ) : (
                  <p className="t-sm t-muted">No photo yet.</p>
                );
              })()}
            </div>

            <Field label="Item name" hint="This prints on your labels.">
              {(p) => (
                <Input
                  {...p}
                  value={editIF.name}
                  onChange={(e) => setEditIF((f) => ({ ...f, name: e.target.value }))}
                />
              )}
            </Field>

            <Checkbox
              checked={editIF.food}
              onCheckedChange={(v) => setEditIF((f) => ({ ...f, food: v }))}
              label="This is a food item"
              hint="Groceries are taxed at a lower rate than crafts. Changing this affects future sales only — tickets already rung keep the tax they were charged."
            />

            <Field label="Price (dollars)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min="0.5"
                  step="0.5"
                  inputMode="decimal"
                  value={editIF.price}
                  onChange={(e) => setEditIF((f) => ({ ...f, price: e.target.value }))}
                />
              )}
            </Field>

            <Field
              label="Sale — % off"
              hint="0 means no sale. The register and your online page both charge the sale price automatically."
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min="0"
                  max="90"
                  step="5"
                  inputMode="numeric"
                  value={editIF.sale}
                  onChange={(e) => setEditIF((f) => ({ ...f, sale: e.target.value }))}
                />
              )}
            </Field>

            <Field
              label="Correct the total on the floor"
              hint="This overrides the count. For a restock use the Restock button instead — it adds to the count."
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  value={editIF.qty}
                  onChange={(e) => setEditIF((f) => ({ ...f, qty: e.target.value }))}
                />
              )}
            </Field>

            <hr className="divider" />

            <div className="stack g-2">
              <span className="t-label">Take it off the floor</span>
              <div className="row wrap g-2">
                <Button variant="secondary" icon="box" disabled={busy} onClick={() => retireItem(editing)}>
                  Retire item
                </Button>
                <Button variant="danger" icon="trash" disabled={busy} onClick={() => deleteItem(editing)}>
                  Delete item
                </Button>
              </div>
              <p className="t-xs t-muted">
                Retiring keeps the sales history and lets you bring the item back. Deleting is
                permanent — and if the item has ever sold, it gets retired instead.
              </p>
            </div>
          </div>
        </Panel>
      ) : null}

      {/* ---------------------------------------------------- inbox thread -- */}
      {openThread ? (
        <Panel
          open
          onClose={() => setOpenThread(null)}
          title={openThread.customerName}
          subtitle={`${openThread.type === "PREORDER" ? "Pre-order" : openThread.type === "REQUEST" ? "Request" : "Complaint"} · ${[openThread.email, openThread.phone].filter(Boolean).join(" · ")}`}
          footer={
            openThread.status === "OPEN" ? (
              <div className="row wrap g-2">
                <Button variant="primary" icon="mail" disabled={!replyBody.trim()} onClick={sendReply}>
                  Send reply
                </Button>
                <Button variant="ghost" onClick={() => setThreadStatus("CLOSED")}>Close conversation</Button>
              </div>
            ) : (
              <Button variant="secondary" icon="refresh" onClick={() => setThreadStatus("OPEN")}>
                Re-open conversation
              </Button>
            )
          }
        >
          <div className="stack g-4">
            <div className="stack g-2">
              {openThread.messages.map((m) => {
                const mine = m.sender === "VENDOR";
                return (
                  <div key={m.id} style={{ textAlign: mine ? "right" : "left" }}>
                    <div className="t-xs t-muted">{mine ? "You" : openThread.customerName} · {fmtDateTime(m.createdAt)}</div>
                    <div
                      className="t-sm"
                      style={{
                        display: "inline-block",
                        textAlign: "left",
                        maxWidth: "88%",
                        marginTop: 2,
                        padding: "var(--sp-2) var(--sp-3)",
                        borderRadius: "var(--r-md)",
                        border: "1px solid var(--border)",
                        background: mine ? "var(--accent-soft)" : "var(--surface)",
                        color: mine ? "var(--accent-text)" : "inherit",
                      }}
                    >
                      {m.body}
                    </div>
                  </div>
                );
              })}
            </div>

            {openThread.type === "PREORDER" ? (
              <div className="stack g-3">
                <hr className="divider" />
                {po && po.status === "PAID" ? (
                  <Note tone="success" title={`Paid — ${money(po.totalCents)} collected online`}>
                    It&rsquo;s in the register tickets and your balance, net of commission.
                    Expected: {po.expectedDate}.
                  </Note>
                ) : po && po.status === "ACCEPTED" ? (
                  <Note tone="info" title={`Accepted — awaiting payment of ${money(po.totalCents)}`}>
                    Expected {po.expectedDate}. The customer has the payment link; accepting again
                    revises the terms.
                  </Note>
                ) : po && po.status === "DECLINED" ? (
                  <Note tone="neutral" title="Declined">
                    Accept below if you change your mind.
                  </Note>
                ) : null}

                {!po || po.status !== "PAID" ? (
                  <div className="stack g-4">
                    <h3 className="t-section">Accept and send a payment link</h3>
                    <Field label="What they're getting" hint="This shows on the payment page.">
                      {(p) => (
                        <Input
                          {...p}
                          value={poDesc}
                          placeholder="2 dozen dinner rolls + 1 apple pie"
                          onChange={(e) => setPoDesc(e.target.value)}
                        />
                      )}
                    </Field>
                    <Field label="Your price, before tax (dollars)" hint="Tax is added automatically at the market rate.">
                      {(p) => (
                        <Input
                          {...p}
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          value={poAmt}
                          onChange={(e) => setPoAmt(e.target.value)}
                        />
                      )}
                    </Field>
                    <Field label="Ready / expected date">
                      {(p) => (
                        <Input
                          {...p}
                          value={poDate}
                          placeholder="Saturday Oct 3, by 10 AM"
                          onChange={(e) => setPoDate(e.target.value)}
                        />
                      )}
                    </Field>
                    {poErr ? <Note tone="error">{poErr}</Note> : null}
                    <div className="row wrap g-2">
                      <Button variant="primary" icon="check" onClick={acceptPreorder}>
                        Accept and send the link
                      </Button>
                      <Button variant="dangerSoft" icon="close" onClick={declinePreorder}>
                        Decline
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {openThread.status === "OPEN" ? (
              <Field label="Reply" hint="They get it by email with a private link back to this conversation.">
                {(p) => (
                  <Textarea
                    {...p}
                    rows={3}
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                  />
                )}
              </Field>
            ) : null}

            {inboxMsg ? <Note tone="error">{inboxMsg}</Note> : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

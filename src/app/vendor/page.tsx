"use client";

import { useCallback, useEffect, useState } from "react";
import { usePulse } from "@/lib/usePulse";

type Item = { id: string; sku: string; name: string; priceCents: number; quantity: number; active: boolean; salePercent?: number };
type Ledger = { id: string; type: string; amountCents: number; note: string; createdAt: string };
type Me = {
  vendor: { code: string; businessName: string; email: string; commissionPercent: number; mustChangePassword?: boolean; acceptsPreorders?: boolean; acceptsRequests?: boolean; publicBlurb?: string; allowSelfCheckout?: boolean; cardLast4?: string; contracts?: { id: string; status: string; vendorSignedAt: string | null }[] };
  items: Item[]; ledger: Ledger[]; balance: number; monthSales: number; monthNet: number;
};

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function VendorDashboard() {
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pwCur, setPwCur] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwNew2, setPwNew2] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [pushDevices, setPushDevices] = useState<number | null>(null);
  const [pushKey, setPushKey] = useState("");
  const [pushMsg, setPushMsg] = useState("");
  const [inbox, setInbox] = useState<{ id: string; type: string; status: string; customerName: string; email: string; phone: string; last: { sender: string; body: string } | null }[]>([]);
  const [openThread, setOpenThread] = useState<{ id: string; type: string; status: string; customerName: string; email: string; phone: string; messages: { id: string; sender: string; body: string; createdAt: string }[] } | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [inboxMsg, setInboxMsg] = useState("");
  const [pubPre, setPubPre] = useState(false);
  const [pubReq, setPubReq] = useState(false);
  const [pubBlurb, setPubBlurb] = useState("");
  const [pubSelf, setPubSelf] = useState(true);
  const [pubMsg, setPubMsg] = useState("");
  const [myPhotos, setMyPhotos] = useState<{ id: string; kind: string; itemId?: string }[]>([]);
  const [photoMsg, setPhotoMsg] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [po, setPo] = useState<{ status: string; description: string; subtotalCents: number; taxCents: number; totalCents: number; expectedDate: string; payUrl: string } | null>(null);
  const [poDesc, setPoDesc] = useState("");
  const [poAmt, setPoAmt] = useState("");
  const [poDate, setPoDate] = useState("");
  const [poMsg, setPoMsg] = useState("");
  const [vtab, setVtab] = useState<"home" | "items" | "inbox" | "page" | "money" | "chat" | "settings">("home");
  const [editItem, setEditItem] = useState<string | null>(null);
  const [editIF, setEditIF] = useState({ name: "", price: "", qty: "", sale: "0" });
  const [cardMsg, setCardMsg] = useState("");
  const [chat, setChat] = useState<{ id: string; vendorId: string; name: string; body: string; createdAt: string }[]>([]);
  const [chatMe, setChatMe] = useState("");
  const [chatBody, setChatBody] = useState("");
  const [postBody, setPostBody] = useState("");
  const [myPosts, setMyPosts] = useState<{ id: string; body: string; photoId: string | null; createdAt: string }[]>([]);
  const loadChat = useCallback(async () => {
    const r = await fetch("/api/vendor/chat");
    if (r.ok) { const d = await r.json(); setChat(d.messages); setChatMe(d.me); }
  }, []);
  const loadPosts = useCallback(async () => {
    const r = await fetch("/api/vendor/posts");
    if (r.ok) setMyPosts((await r.json()).posts);
  }, []);
  useEffect(() => { loadChat(); loadPosts(); }, [loadChat, loadPosts]);
  useEffect(() => {
    const rsid = new URLSearchParams(window.location.search).get("rent_session");
    if (rsid) {
      fetch(`/api/vendor/rent-checkout?session_id=${encodeURIComponent(rsid)}`).then(async (r) => {
        const d = await r.json();
        setCardMsg(r.ok ? `Rent paid \u2713 — and card \u00b7\u00b7\u00b7\u00b7${d.last4} is saved for automatic settlement going forward.` : d.error || "Couldn't confirm the payment.");
        window.history.replaceState(null, "", "/vendor");
        load();
      });
      return;
    }
    const sid = new URLSearchParams(window.location.search).get("card_session");
    if (!sid) return;
    fetch(`/api/vendor/card?session_id=${encodeURIComponent(sid)}`).then(async (r) => {
      const d = await r.json();
      setCardMsg(r.ok ? `Card ····${d.last4} saved for automatic rent \u2713` : d.error || "Couldn't save the card.");
      window.history.replaceState(null, "", "/vendor");
      load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    load();
  }, [load]);
  usePulse(() => { load(); loadChat(); loadPosts(); });

  const loadInbox = useCallback(async () => {
    const r = await fetch("/api/vendor/inbox");
    if (r.ok) setInbox((await r.json()).threads || []);
  }, []);
  useEffect(() => { loadInbox(); }, [loadInbox]);

  const openInboxThread = async (id: string) => {
    setInboxMsg(""); setReplyBody(""); setPo(null); setPoMsg("");
    const r = await fetch(`/api/vendor/inbox/${id}`);
    if (r.ok) {
      const t = (await r.json()).thread;
      setOpenThread(t);
      if (t.type === "PREORDER") {
        const pr = await fetch(`/api/vendor/inbox/${id}/preorder`);
        if (pr.ok) setPo((await pr.json()).preorder);
      }
    }
  };

  const acceptPreorder = async () => {
    if (!openThread) return;
    setPoMsg("");
    const r = await fetch(`/api/vendor/inbox/${openThread.id}/preorder`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "accept", description: poDesc, subtotalDollars: poAmt, expectedDate: poDate }),
    });
    const d = await r.json();
    if (!r.ok) { setPoMsg(d.error || "Couldn't accept."); return; }
    setPoMsg("Accepted — payment link emailed to the customer. ✓");
    await openInboxThread(openThread.id);
    await loadInbox();
  };

  const declinePreorder = async () => {
    if (!openThread) return;
    const reason = prompt("Short reason for the customer:");
    if (reason === null) return;
    setPoMsg("");
    const r = await fetch(`/api/vendor/inbox/${openThread.id}/preorder`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "decline", reason }),
    });
    const d = await r.json();
    if (!r.ok) { setPoMsg(d.error || "Couldn't decline."); return; }
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
      if (!r.ok) { alert(d.error || "Upload failed."); return; }
      await loadPhotos();
    } finally { setBusy(false); }
  };

  const uploadPhoto = async (file: File | undefined, kind: "PRODUCT" | "LOGO" = "PRODUCT") => {
    if (!file) return;
    setPhotoMsg(""); setPhotoBusy(true);
    try {
      const { data, mime } = await compressImage(file);
      const r = await fetch("/api/vendor/photos", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, mime, kind }),
      });
      const d = await r.json();
      if (!r.ok) { setPhotoMsg(d.error || "Couldn't upload."); return; }
      setPhotoMsg("Added. ✓");
      await loadPhotos();
    } catch {
      setPhotoMsg("That file didn't read as a photo — try a JPEG or PNG.");
    } finally { setPhotoBusy(false); }
  };

  const deletePhoto = async (id: string) => {
    if (!confirm("Remove this photo from your public page?")) return;
    await fetch(`/api/vendor/photos/${id}`, { method: "DELETE" });
    await loadPhotos();
  };

  const savePublic = async () => {
    setPubMsg("");
    const r = await fetch("/api/vendor/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acceptsPreorders: pubPre, acceptsRequests: pubReq, publicBlurb: pubBlurb, allowSelfCheckout: pubSelf }),
    });
    setPubMsg(r.ok ? "Saved. ✓" : "Couldn't save.");
  };

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    fetch("/api/vendor/push").then(async (r) => {
      if (r.ok) { const d = await r.json(); setPushDevices(d.devices); setPushKey(d.publicKey); }
    }).catch(() => {});
  }, []);

  const enablePush = async () => {
    setPushMsg("");
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        setPushMsg("This browser can't do notifications. On iPhone: share button → Add to Home Screen, then open the app from there and try again.");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setPushMsg("Notifications were blocked — allow them in your browser settings and try again."); return; }
      const reg = await navigator.serviceWorker.ready;
      const b64 = pushKey.replace(/-/g, "+").replace(/_/g, "/");
      const pad = "=".repeat((4 - (b64.length % 4)) % 4);
      const raw = atob(b64 + pad);
      const key = new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const res = await fetch("/api/vendor/push", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) { setPushMsg("Couldn't save — try again."); return; }
      setPushDevices((n) => (n || 0) + 1);
      setPushMsg("Sale alerts ON for this device. ✓ You'll get a notification instead of an email.");
    } catch {
      setPushMsg("Couldn't turn on notifications here. iPhone: must be iOS 16.4+ AND opened from a home-screen icon (share → Add to Home Screen).");
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
      body: JSON.stringify({ name, priceDollars: price, quantity: qty || 0 }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json();
      setErr(data.error || "Couldn't add it.");
      return;
    }
    setName(""); setPrice(""); setQty("");
    await load();
  };

  const patchItem = async (id: string, body: object) => {
    setBusy(true);
    await fetch(`/api/vendor/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await load();
    setBusy(false);
  };

  const changePw = async () => {
    setPwMsg("");
    if (pwNew !== pwNew2) { setPwMsg("The two passwords do not match - type them again."); return; }
    const res = await fetch("/api/vendor/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: pwCur, newPassword: pwNew }),
    });
    const data = await res.json();
    setPwMsg(res.ok ? "Password changed. ✓" : data.error || "Failed.");
    if (res.ok) { setPwCur(""); setPwNew(""); setPwNew2(""); await load(); }
  };

  const logout = async () => {
    await fetch("/api/vendor/logout", { method: "POST" });
    window.location.href = "/";
  };

  if (!me) return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "22px 16px" }}>
      <div className="skel" style={{ width: 128, height: 24, marginBottom: 10 }} />
      <div className="skel" style={{ width: 220, height: 28, marginBottom: 18 }} />
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <div className="skel" style={{ flex: 1, height: 86 }} />
        <div className="skel" style={{ flex: 1, height: 86 }} />
      </div>
      <div className="skel" style={{ height: 130, marginBottom: 14 }} />
      <div className="skel" style={{ height: 220 }} />
    </main>
  );

  if (me.vendor.mustChangePassword) {
    return (
      <main style={{ maxWidth: 430, margin: "0 auto", padding: "70px 16px" }}>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 110, height: 110, marginBottom: 8 }} />
{/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/wordmark.png" alt="Community Harvest" style={{ width: 210, maxWidth: "70%", height: "auto", margin: "2px auto 2px", display: "block" }} />
          <div style={{ fontWeight: 700, fontSize: 11, letterSpacing: "0.08em" }}>FOOD AND CRAFT MARKET</div>
        </div>
        <div className="card">
          <h2 className="display" style={{ fontSize: 17, marginBottom: 4 }}>SET YOUR OWN PASSWORD</h2>
          <p style={{ fontSize: 13, color: "var(--ash)" }}>
            You signed in with a temporary password from your email. Pick your own before continuing &mdash; you&rsquo;ll use it from now on.
          </p>
          <label>Your new password (8+ characters)</label>
          <input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} />
          <label>Type it again</label>
          <input type="password" value={pwNew2} onChange={(e) => setPwNew2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && changePw()} />
          <div style={{ marginTop: 14 }}><button className="btn" onClick={changePw}>SAVE &amp; CONTINUE</button></div>
          {pwMsg && <p className={pwMsg.includes("✓") ? "ok" : "err"}>{pwMsg}</p>}
        </div>
      </main>
    );
  }

  const needsReply = inbox.filter((t) => t.status === "OPEN" && t.last && t.last.sender !== "VENDOR").length;
  const floorUnits = me.items.reduce((n, i) => n + (i.active ? i.quantity : 0), 0);

  const Tab = (props: { id: "home" | "items" | "inbox" | "page" | "money" | "chat" | "settings"; label: string; badge?: number }) => (
    <button
      className={`btn small ${vtab === props.id ? "" : "ghost"}`}
      style={{ position: "relative", whiteSpace: "nowrap" }}
      onClick={() => { setVtab(props.id); window.scrollTo({ top: 0 }); }}
    >
      {props.label}
      {props.badge ? (
        <span style={{ marginLeft: 6, background: "#dc2626", color: "#fff", borderRadius: 999, fontSize: 10.5, fontWeight: 700, padding: "1px 6px" }}>{props.badge}</span>
      ) : null}
    </button>
  );

  const Stat = (props: { label: string; value: string; sub?: string; color?: string; hero?: boolean; onClick?: () => void }) => (
    <div className={`card${props.hero ? " stat-hero" : ""}`} style={{ flex: "1 1 140px", textAlign: "center", cursor: props.onClick ? "pointer" : "default" }} onClick={props.onClick}>
      <div className="statlabel" style={{ fontSize: 10.5, fontWeight: 700, color: "var(--ash)", letterSpacing: "0.06em" }}>{props.label}</div>
      <div className="display" style={{ fontSize: 24, color: props.hero ? "#fff" : props.color || "var(--ink)" }}>{props.value}</div>
      {props.sub && <div style={{ fontSize: 11, color: props.hero ? "#9ca3af" : "var(--ash)" }}>{props.sub}</div>}
    </div>
  );

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "22px 16px 70px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/wordmark.png" alt="Community Harvest" style={{ width: 128, height: "auto", display: "block", marginBottom: 4 }} />
          <div className="display" style={{ fontSize: 21 }}>{me.vendor.businessName.toUpperCase()}</div>
          <div style={{ fontSize: 12, color: "var(--ash)", fontWeight: 600 }}>
            Vendor {me.vendor.code}
            {me.vendor.commissionPercent > 0 ? ` · ${me.vendor.commissionPercent}% market commission` : ""}
          </div>
        </div>
        <button className="btn small ghost" onClick={logout}>LOG OUT</button>
      </div>

      <div className="glassbar" style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 16, WebkitOverflowScrolling: "touch" }}>
        <Tab id="home" label="🏠 HOME" />
        <Tab id="items" label="📦 MY ITEMS" />
        <Tab id="inbox" label="📩 INBOX" badge={needsReply} />
        <Tab id="page" label="⭐ MY PAGE" />
        <Tab id="money" label="💵 MONEY" />
        <Tab id="chat" label="💬 CHAT" />
        <Tab id="settings" label="⚙️ SETTINGS" />
      </div>

      {vtab === "home" && (
        <div>
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <Stat label="YOUR BALANCE" value={`$${(me.balance / 100).toFixed(2)}`} hero onClick={() => setVtab("money")} />
            <Stat label="SOLD THIS MONTH" value={`$${(me.monthSales / 100).toFixed(2)}`} sub={`your net: $${(me.monthNet / 100).toFixed(2)}`} />
            <Stat label="ON THE FLOOR" value={String(floorUnits)} sub="units in stock" onClick={() => setVtab("items")} />
            <Stat label="NEEDS A REPLY" value={String(needsReply)} color={needsReply > 0 ? "var(--red)" : "var(--green)"} sub={needsReply > 0 ? "open messages" : "all caught up"} onClick={() => setVtab("inbox")} />
          </div>

          {me.items.filter((i) => i.active).length === 0 && (
            <div className="card" style={{ marginBottom: 16, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
              <h2 className="display" style={{ fontSize: 16, marginBottom: 6 }}>WELCOME! THREE STEPS AND YOU&rsquo;RE SELLING 🌾</h2>
              <ol style={{ margin: "0 0 10px 18px", fontSize: 13.5, lineHeight: 1.9, listStyle: "decimal" }}>
                <li><b>Add your items</b> with a price and how many you&rsquo;re bringing.</li>
                <li><b>Print your barcode labels</b> and sticker every item.</li>
                <li><b>Stock your booth</b> during a restock window — the register does the rest.</li>
              </ol>
              <button className="btn small" onClick={() => setVtab("items")}>START — ADD MY FIRST ITEM</button>
            </div>
          )}

          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 15, marginBottom: 8 }}>QUICK ACTIONS</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn small" onClick={() => setVtab("items")}>＋ ADD AN ITEM</button>
              <a className="btn small ghost" href="/vendor/labels">🏷 PRINT LABELS</a>
              <a className="btn small ghost" href="/vendor/qr">📱 PRINT TABLE QR</a>
              <a className="btn small ghost" href={`/v/${me.vendor.code}`} target="_blank" rel="noopener">👀 VIEW MY PUBLIC PAGE</a>
              <a className="btn small ghost" href="/rules" target="_blank" rel="noopener">📋 MARKET RULES</a>
              <a className="btn small ghost" href="/guide" target="_blank" rel="noopener">📖 SETUP GUIDE</a>
              {me.vendor.contracts && me.vendor.contracts[0] && (
                <a className="btn small" href={`/contract/${me.vendor.contracts[0].id}/packet`}>
                  📄 {me.vendor.contracts[0].vendorSignedAt ? "MY CONTRACT" : "SIGN YOUR CONTRACT"}
                </a>
              )}
            </div>
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <h2 className="display" style={{ fontSize: 15 }}>RECENT ACTIVITY</h2>
              <button className="btn small ghost" onClick={() => setVtab("money")}>FULL STATEMENT →</button>
            </div>
            <ul style={{ listStyle: "none", marginTop: 4 }}>
              {me.ledger.slice(0, 6).map((l) => (
                <li key={l.id} style={{ padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: 13, display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>{l.type === "SALE" ? "🛒" : l.type === "PAYOUT" ? "💸" : l.type === "RENT" ? "🏠" : "✏️"} {l.note || l.type}</span>
                  <b style={{ color: l.amountCents >= 0 ? "var(--green)" : "var(--red)", whiteSpace: "nowrap" }}>
                    {l.amountCents >= 0 ? "+" : "−"}${(Math.abs(l.amountCents) / 100).toFixed(2)}
                  </b>
                </li>
              ))}
              {me.ledger.length === 0 && <li style={{ color: "var(--ash)", fontSize: 13, paddingTop: 6 }}>Sales, rent, and payouts will show here once you&rsquo;re rolling.</li>}
            </ul>
          </div>
        </div>
      )}

      {vtab === "items" && (
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <h2 className="display" style={{ fontSize: 17 }}>YOUR ITEMS ON THE FLOOR</h2>
              <a className="btn small" href="/vendor/labels">🏷 PRINT BARCODE LABELS</a>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <button className="btn small ghost" disabled={busy} onClick={async () => {
                const v = prompt("Run a sale on EVERYTHING — % off all your items (5–90):");
                if (v === null || !v.trim()) return;
                const r = await fetch("/api/vendor/items/sale-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ percent: v }) });
                const d = await r.json();
                if (!r.ok) { alert(d.error || "Couldn't start the sale."); return; }
                load();
              }}>🏷️ RUN A SALE ON EVERYTHING</button>
              {me.items.some((it) => it.active && (it.salePercent || 0) > 0) && (
                <button className="btn small ghost" disabled={busy} onClick={async () => {
                  if (!confirm("End all sales and go back to full price?")) return;
                  const r = await fetch("/api/vendor/items/sale-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ percent: 0 }) });
                  if (r.ok) load();
                }}>END ALL SALES</button>
              )}
            </div>
            <ul style={{ listStyle: "none", marginTop: 8 }}>
              {me.items.filter((it) => it.active).map((it) => (
                <li key={it.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div>
                      <span className="display" style={{ fontSize: 15 }}>{it.name.toUpperCase()}</span>{" "}
                      {(it.salePercent || 0) > 0 && (
                        <s style={{ color: "var(--ash)", fontSize: 13 }}>${(it.priceCents / 100).toFixed(2)}</s>
                      )}{" "}
                      <span className="display" style={{ fontSize: 15, color: (it.salePercent || 0) > 0 ? "var(--red)" : "var(--green)" }}>
                        ${(() => { const e = Math.max(0, Math.round(it.priceCents * (100 - Math.min(90, Math.max(0, it.salePercent || 0))) / 100)) / 100; return e % 1 === 0 ? e.toFixed(0) : e.toFixed(2); })()}
                      </span>{" "}
                      {(it.salePercent || 0) > 0 && (
                        <span style={{ background: "#fef2f2", color: "var(--red)", border: "1px solid #fecaca", borderRadius: 999, fontSize: 10, fontWeight: 800, padding: "1px 7px" }}>🏷️ {it.salePercent}% OFF</span>
                      )}
                      <div style={{ fontSize: 11.5, color: "var(--ash)" }}>{it.sku} · <b style={{ color: it.quantity > 0 ? "var(--green)" : "var(--red)" }}>{it.quantity} on the floor</b></div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button className="btn small" disabled={busy} onClick={() => {
                        const v = prompt(`RESTOCKING ${it.name} — how many are you ADDING to the floor? (currently ${it.quantity})`);
                        if (v !== null && v.trim()) patchItem(it.id, { addQuantity: v });
                      }}>➕ RESTOCK</button>
                      <button className="btn small ghost" disabled={busy} onClick={() => {
                        if (editItem === it.id) { setEditItem(null); return; }
                        setEditItem(it.id);
                        setEditIF({ name: it.name, price: String(it.priceCents / 100), qty: String(it.quantity), sale: String(it.salePercent || 0) });
                      }}>✏️ EDIT</button>
                    </div>
                  </div>
                  {editItem === it.id && (
                    <div style={{ border: "1px solid var(--border)", borderRadius: 12, background: "#fafafa", padding: "10px 12px", marginTop: 8 }}>
                      <label>Product photo (shows online — one per product; new upload replaces it)</label>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                        {(() => { const ph = myPhotos.find((x) => x.kind === "ITEM" && x.itemId === it.id); return ph ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`/api/public/photo/${ph.id}`} alt={it.name} style={{ width: 54, height: 54, objectFit: "cover", borderRadius: 10, border: "1px solid var(--border)" }} />
                        ) : <span style={{ fontSize: 11.5, color: "var(--ash)" }}>No photo yet</span>; })()}
                        <input type="file" accept="image/*" style={{ width: "auto" }} onChange={(e) => uploadItemPhoto(e.target.files?.[0], it.id)} />
                      </div>
                      <label>Item name (prints on your labels)</label>
                      <input value={editIF.name} onChange={(e) => setEditIF((f) => ({ ...f, name: e.target.value }))} />
                      <label>Sale — % off (0 = no sale; register &amp; online charge the sale price automatically)</label>
                      <input type="number" min="0" max="90" step="5" value={editIF.sale} onChange={(e) => setEditIF((f) => ({ ...f, sale: e.target.value }))} />
                      <label>Price (dollars)</label>
                      <input type="number" min="0.5" step="0.5" value={editIF.price} onChange={(e) => setEditIF((f) => ({ ...f, price: e.target.value }))} />
                      <label>Correct the total on the floor (overrides the count — for restocks use ➕ RESTOCK instead)</label>
                      <input type="number" min="0" step="1" value={editIF.qty} onChange={(e) => setEditIF((f) => ({ ...f, qty: e.target.value }))} />
                      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                        <button className="btn small" disabled={busy} onClick={async () => {
                          await patchItem(it.id, { name: editIF.name, priceDollars: editIF.price, quantity: editIF.qty, salePercent: editIF.sale });
                          setEditItem(null);
                        }}>SAVE</button>
                        <button className="btn small ghost" onClick={() => setEditItem(null)}>CANCEL</button>
                        <button className="btn small ghost" disabled={busy} onClick={() => {
                          if (confirm(`Retire ${it.name}? It comes off the floor and stops scanning (history kept).`)) { patchItem(it.id, { active: false, quantity: 0 }); setEditItem(null); }
                        }}>RETIRE</button>
                        <button className="btn small ghost" style={{ color: "var(--red)", borderColor: "#fecaca" }} disabled={busy} onClick={async () => {
                          if (!confirm(`Delete ${it.name} completely? This can't be undone.`)) return;
                          const r = await fetch(`/api/vendor/items/${it.id}`, { method: "DELETE" });
                          const d = await r.json();
                          if (!r.ok) { alert(d.error || "Couldn't delete."); return; }
                          if (d.retired) alert(d.message);
                          setEditItem(null);
                          load();
                        }}>🗑 DELETE</button>
                      </div>
                      <p style={{ fontSize: 11, color: "var(--ash)", marginTop: 8 }}>Changed the name or price? Print fresh labels so the shelf matches the register.</p>
                    </div>
                  )}
                </li>
              ))}
              {me.items.filter((it) => it.active).length === 0 && <li style={{ color: "var(--ash)", paddingTop: 8, fontSize: 14 }}>No items yet — add your first below. It takes 20 seconds.</li>}
            </ul>
            {me.items.some((it) => !it.active) && (
              <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "var(--ash)" }}>RETIRED ITEMS</div>
                <ul style={{ listStyle: "none", marginTop: 4 }}>
                  {me.items.filter((it) => !it.active).map((it) => (
                    <li key={it.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, opacity: 0.75 }}>
                      <span style={{ fontSize: 13.5 }}>
                        <b>{it.name}</b> <span style={{ color: "var(--ash)", fontSize: 11.5 }}>{it.sku} · ${(it.priceCents / 100).toFixed(2)}</span>
                      </span>
                      <button className="btn small ghost" disabled={busy} onClick={() => patchItem(it.id, { active: true })}>♻️ BRING BACK</button>
                    </li>
                  ))}
                </ul>
                <p style={{ fontSize: 11, color: "var(--ash)", marginTop: 4 }}>Bringing an item back re-activates its barcode — then ➕ RESTOCK it and it&rsquo;s selling again. Old labels still scan.</p>
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>ADD AN ITEM</h2>
            <label>Item name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Hand-poured soy candle" />
            <label>Price (dollars)</label>
            <input value={price} onChange={(e) => setPrice(e.target.value)} type="number" min="0.5" step="0.5" placeholder="14" />
            <label>Quantity you&rsquo;re putting out</label>
            <input value={qty} onChange={(e) => setQty(e.target.value)} type="number" min="0" step="1" placeholder="6" />
            <div style={{ marginTop: 14 }}>
              <button className="btn" disabled={busy} onClick={addItem}>ADD ITEM</button>
            </div>
            {err && <p className="err">{err}</p>}
            <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 10 }}>
              Each item gets a barcode. Print labels, sticker your items, restock anytime with SET QTY.
            </p>
          </div>
        </div>
      )}

      {vtab === "inbox" && (
      <div className="card">
        <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>INBOX — PRE-ORDERS, REQUESTS &amp; COMPLAINTS</h2>
        {openThread ? (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
              <b style={{ fontSize: 14 }}>{openThread.type} — {openThread.customerName}</b>
              <button className="btn small ghost" onClick={() => setOpenThread(null)}>← ALL MESSAGES</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--ash)", margin: "2px 0 8px" }}>{openThread.email} · {openThread.phone}</div>
            {openThread.messages.map((m) => (
              <div key={m.id} style={{
                margin: "6px 0", padding: "8px 11px", border: "1px solid var(--border)", fontSize: 13,
                background: m.sender === "VENDOR" ? "#111827" : "#f9fafb", color: m.sender === "VENDOR" ? "#fff" : "#111827", borderRadius: 12,
                marginLeft: m.sender === "VENDOR" ? 20 : 0, marginRight: m.sender === "VENDOR" ? 0 : 20,
              }}>
                {m.body}
              </div>
            ))}
            {openThread.type === "PREORDER" && (
              <div style={{ border: "1px solid var(--border)", borderRadius: 12, background: "#f9fafb", padding: "10px 12px", margin: "10px 0" }}>
                {po && po.status === "PAID" ? (
                  <p className="ok" style={{ margin: 0 }}>PAID ✓ — {money(po.totalCents)} collected online. It&rsquo;s in the register tickets and your balance (net of commission). Expected: {po.expectedDate}.</p>
                ) : po && po.status === "ACCEPTED" ? (
                  <p style={{ fontSize: 13, margin: 0 }}><b>ACCEPTED — awaiting payment.</b> {money(po.totalCents)} total, expected {po.expectedDate}. The customer has the payment link (accept again to revise terms).</p>
                ) : po && po.status === "DECLINED" ? (
                  <p style={{ fontSize: 13, margin: 0 }}><b>DECLINED.</b> Accept below if you change your mind.</p>
                ) : null}
                {(!po || po.status !== "PAID") && (
                  <div style={{ marginTop: po ? 10 : 0 }}>
                    <b style={{ fontSize: 13 }}>ACCEPT &amp; SEND PAYMENT LINK</b>
                    <label>What they&rsquo;re getting (shows on the payment page)</label>
                    <input value={poDesc} onChange={(e) => setPoDesc(e.target.value)} placeholder="2 dozen dinner rolls + 1 apple pie" />
                    <label>Your price, before tax ($) — tax is added automatically at the market rate</label>
                    <input type="number" min="0" step="0.01" value={poAmt} onChange={(e) => setPoAmt(e.target.value)} />
                    <label>Ready / expected date</label>
                    <input value={poDate} onChange={(e) => setPoDate(e.target.value)} placeholder="Saturday Oct 3, by 10 AM" />
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                      <button className="btn small" onClick={acceptPreorder}>✅ ACCEPT &amp; SEND LINK</button>
                      <button className="btn small ghost" onClick={declinePreorder}>❌ DECLINE</button>
                    </div>
                  </div>
                )}
                {poMsg && <p className={poMsg.includes("✓") ? "ok" : "err"}>{poMsg}</p>}
              </div>
            )}
            {openThread.status === "OPEN" ? (
              <>
                <label>Reply (they get it by email with a private link)</label>
                <textarea rows={3} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} />
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button className="btn" style={{ flex: 1 }} onClick={sendReply}>SEND REPLY</button>
                  <button className="btn small ghost" onClick={() => setThreadStatus("CLOSED")}>CLOSE</button>
                </div>
              </>
            ) : (
              <div style={{ marginTop: 8 }}>
                <button className="btn small ghost" onClick={() => setThreadStatus("OPEN")}>RE-OPEN CONVERSATION</button>
              </div>
            )}
            {inboxMsg && <p className="err">{inboxMsg}</p>}
          </div>
        ) : (
          <ul style={{ margin: "6px 0" }}>
            {inbox.map((t) => (
              <li key={t.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--border)", cursor: "pointer" }} onClick={() => openInboxThread(t.id)}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                  <b>{t.type === "PREORDER" ? "🛒" : t.type === "REQUEST" ? "🙋" : "⚠️"} {t.customerName}
                    {t.status === "OPEN" && t.last && t.last.sender !== "VENDOR" && <span style={{ marginLeft: 6, background: "#dc2626", color: "#fff", borderRadius: 999, fontSize: 10, fontWeight: 700, padding: "1px 6px" }}>REPLY</span>}
                  </b>
                  <span style={{ fontWeight: 600, color: "var(--ash)", fontSize: 11.5 }}>{t.status === "CLOSED" ? "CLOSED" : ""}</span>
                </div>
                {t.last && <div style={{ fontSize: 12, color: "var(--ash)" }}>{t.last.sender === "VENDOR" ? "You: " : ""}{t.last.body}</div>}
              </li>
            ))}
            {inbox.length === 0 && <li style={{ fontSize: 13, color: "var(--ash)" }}>Nothing yet. Customers reach you here from your table QR card and public page.</li>}
          </ul>
        )}
      </div>
      )}

      {vtab === "page" && (
      <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>📣 POST TO THE MARKET FEED</h2>
            <p style={{ fontSize: 12.5, color: "var(--ash)" }}>Announcements, new products, what&rsquo;s coming out of the oven — customers see these on the market page instantly.</p>
            <textarea rows={3} placeholder="Fresh sourdough hitting the shelf at noon! 🍞" value={postBody} onChange={(e) => setPostBody(e.target.value)} />
            <button className="btn small" style={{ marginTop: 6 }} disabled={busy || !postBody.trim()} onClick={async () => {
              setBusy(true);
              try {
                const r = await fetch("/api/vendor/posts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: postBody }) });
                if (r.ok) { setPostBody(""); loadPosts(); }
                else alert((await r.json()).error || "Couldn't post.");
              } finally { setBusy(false); }
            }}>POST 📣</button>
            {myPosts.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {myPosts.map((po) => (
                  <div key={po.id} style={{ borderTop: "1px solid var(--border)", padding: "8px 0", display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontSize: 13 }}>{po.body}<br /><span style={{ fontSize: 11, color: "var(--ash)" }}>{new Date(po.createdAt).toLocaleString()}</span></span>
                    <button className="btn small ghost" disabled={busy} onClick={async () => {
                      if (!confirm("Delete this post?")) return;
                      await fetch("/api/vendor/posts", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: po.id }) });
                      loadPosts();
                    }}>🗑</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="card">
        <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>YOUR PUBLIC PAGE &amp; TABLE QR</h2>
        <p style={{ fontSize: 12.5, color: "var(--ash)" }}>
          Customers scan your table card to see your goods, review you, and message you. Complaints are always open — that&rsquo;s a market rule — but pre-orders and requests are up to you:
        </p>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8 }}>
          <input type="checkbox" checked={pubPre} onChange={(e) => setPubPre(e.target.checked)} style={{ width: "auto" }} />
          Accept PRE-ORDERS
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={pubReq} onChange={(e) => setPubReq(e.target.checked)} style={{ width: "auto" }} />
          Accept REQUESTS
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={pubSelf} onChange={(e) => setPubSelf(e.target.checked)} style={{ width: "auto" }} />
          Allow SELF-CHECKOUT <span style={{ fontWeight: 400, color: "var(--ash)" }}>(shoppers can scan &amp; pay your items on their phone — off means register only)</span>
        </label>
        <label>Your logo (optional — brands your card on the market directory)</label>
        <div style={{ display: "flex", gap: 10, alignItems: "center", margin: "4px 0 8px", flexWrap: "wrap" }}>
          {myPhotos.filter((ph) => ph.kind === "LOGO").map((ph) => (
            <span key={ph.id} style={{ position: "relative", display: "inline-block" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/public/photo/${ph.id}`} alt="Your logo" style={{ height: 64, width: "auto", border: "1px solid var(--border)", borderRadius: 8, display: "block" }} />
              <button className="btn small" style={{ position: "absolute", top: -8, right: -8, padding: "2px 7px", lineHeight: 1 }} onClick={() => deletePhoto(ph.id)}>×</button>
            </span>
          ))}
          {myPhotos.filter((ph) => ph.kind === "LOGO").length === 0 && <span style={{ fontSize: 12, color: "var(--ash)" }}>No logo — your card shows your name in market style (which looks sharp too).</span>}
        </div>
        <input type="file" accept="image/*" disabled={photoBusy} onChange={(e) => { uploadPhoto(e.target.files?.[0], "LOGO"); e.target.value = ""; }} />
        <p style={{ fontSize: 11, color: "var(--ash)", margin: "2px 0 8px" }}>Uploading a new logo replaces the old one.</p>

        <label>Product photos (up to 6 — these showcase on your public page)</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "4px 0 8px" }}>
          {myPhotos.filter((ph) => ph.kind !== "LOGO").map((ph) => (
            <span key={ph.id} style={{ position: "relative", display: "inline-block" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/public/photo/${ph.id}`} alt="" style={{ height: 84, width: "auto", border: "1px solid var(--border)", borderRadius: 8, display: "block" }} />
              <button className="btn small" style={{ position: "absolute", top: -8, right: -8, padding: "2px 7px", lineHeight: 1 }} onClick={() => deletePhoto(ph.id)}>×</button>
            </span>
          ))}
          {myPhotos.filter((ph) => ph.kind !== "LOGO").length === 0 && <span style={{ fontSize: 12, color: "var(--ash)" }}>No photos yet — phone photos work great.</span>}
        </div>
        <input type="file" accept="image/*" disabled={photoBusy} onChange={(e) => { uploadPhoto(e.target.files?.[0], "PRODUCT"); e.target.value = ""; }} />
        {photoMsg && <p className={photoMsg.includes("✓") ? "ok" : "err"} style={{ marginTop: 4 }}>{photoMsg}</p>}

        <label>Short blurb for your public page (what you make, in a sentence)</label>
        <input value={pubBlurb} onChange={(e) => setPubBlurb(e.target.value)} maxLength={300} />
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="btn small" onClick={savePublic}>SAVE</button>
          <a className="btn small ghost" href="/vendor/qr">🖨 PRINT MY TABLE QR CARD</a>
          {me && <a className="btn small ghost" href={`/v/${me.vendor.code}`} target="_blank" rel="noopener">VIEW MY PUBLIC PAGE</a>}
        </div>
        {pubMsg && <p className={pubMsg.includes("✓") ? "ok" : "err"}>{pubMsg}</p>}
      </div>
        </div>
      )}
      {vtab === "money" && (
        <div>
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <Stat label="YOUR BALANCE" value={`$${(me.balance / 100).toFixed(2)}`} color={me.balance >= 0 ? "var(--green)" : "var(--red)"} />
            <Stat label="SOLD THIS MONTH" value={`$${(me.monthSales / 100).toFixed(2)}`} sub={`your net: $${(me.monthNet / 100).toFixed(2)}`} />
          </div>
          {me.balance < 0 && (
            <div className="card" style={{ marginBottom: 16, background: "#fef2f2", border: "1px solid #fecaca" }}>
              <h2 className="display" style={{ fontSize: 16, marginBottom: 4, color: "var(--red)" }}>RENT DUE: ${(Math.abs(me.balance) / 100).toFixed(2)}</h2>
              <p style={{ fontSize: 12.5, color: "var(--ash)" }}>
                Pay it by card in one step — <b>the same payment saves your card for automatic settlement</b> going forward (a 3% card-processing adjustment applies to card payments; cash or check at the market is always fee-free). Your sales also pay this down automatically.
              </p>
              <button className="btn small" style={{ marginTop: 8 }} disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  const r = await fetch("/api/vendor/rent-checkout", { method: "POST" });
                  const d = await r.json();
                  if (!r.ok) { alert(d.error || "Couldn't start."); return; }
                  window.location.href = d.url;
                } finally { setBusy(false); }
              }}>💳 PAY ${((Math.abs(me.balance) * 1.03) / 100).toFixed(2)} &amp; SAVE CARD</button>
            </div>
          )}
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>💳 CARD ON FILE — AUTOMATIC RENT</h2>
            <p style={{ fontSize: 12.5, color: "var(--ash)" }}>
              If your sales don&rsquo;t fully cover a month&rsquo;s rent, the remainder can charge to a saved card (a 3% card-processing adjustment applies to the charged amount only — cash, check, or sales balance never pay it). Saving a card authorizes this per your agreement; remove it anytime.
            </p>
            {me.vendor.cardLast4 ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                <b style={{ fontSize: 14 }}>💳 Card ending ····{me.vendor.cardLast4}</b>
                <button className="btn small ghost" disabled={busy} onClick={async () => {
                  if (!confirm("Remove your card on file? Unpaid rent would then need cash or check.")) return;
                  const r = await fetch("/api/vendor/card", { method: "DELETE" });
                  if (r.ok) { setCardMsg("Card removed \u2713"); load(); }
                }}>REMOVE</button>
              </div>
            ) : (
              <button className="btn small" style={{ marginTop: 8 }} disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  const r = await fetch("/api/vendor/card", { method: "POST" });
                  const d = await r.json();
                  if (!r.ok) { alert(d.error || "Couldn't start."); return; }
                  window.location.href = d.url;
                } finally { setBusy(false); }
              }}>ADD A CARD (SECURE — VIA STRIPE)</button>
            )}
            {cardMsg && <p className="ok" style={{ marginTop: 6 }}>{cardMsg}</p>}
          </div>
          <div className="card">
            <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>YOUR STATEMENT</h2>
            <p style={{ fontSize: 12, color: "var(--ash)" }}>Every sale (your net after commission), booth rent, adjustment, and payout. Balance pays out monthly.</p>
            <ul style={{ listStyle: "none", marginTop: 6 }}>
              {me.ledger.map((l) => (
                <li key={l.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 13, display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>{l.type === "SALE" ? "🛒" : l.type === "PAYOUT" ? "💸" : l.type === "RENT" ? "🏠" : "✏️"} {l.note || l.type}
                    <span style={{ color: "var(--ash)", fontSize: 11 }}> · {new Date(l.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                  </span>
                  <b style={{ color: l.amountCents >= 0 ? "var(--green)" : "var(--red)", whiteSpace: "nowrap" }}>
                    {l.amountCents >= 0 ? "+" : "−"}${(Math.abs(l.amountCents) / 100).toFixed(2)}
                  </b>
                </li>
              ))}
              {me.ledger.length === 0 && <li style={{ color: "var(--ash)", fontSize: 13, paddingTop: 6 }}>Sales, rent, and payouts will show here.</li>}
            </ul>
          </div>
        </div>
      )}

      {vtab === "chat" && (
        <div className="card">
          <h2 className="display" style={{ fontSize: 17, marginBottom: 4 }}>VENDOR CHAT 💬</h2>
          <p style={{ fontSize: 12, color: "var(--ash)" }}>All market vendors + staff can read this — coordinate menus, cover restocks, plan the weekend.</p>
          <div style={{ maxHeight: 380, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 12, padding: "8px 10px", margin: "8px 0", background: "#fafafa" }}>
            {chat.length === 0 && <p style={{ fontSize: 13, color: "var(--ash)" }}>No messages yet — say hi! 👋</p>}
            {chat.map((mg) => (
              <div key={mg.id} style={{ marginBottom: 8, textAlign: mg.vendorId === chatMe ? "right" : "left" }}>
                <div style={{ fontSize: 10.5, color: "var(--ash)" }}>{mg.name} · {new Date(mg.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
                <div style={{ display: "inline-block", background: mg.vendorId === chatMe ? "#111827" : "#fff", color: mg.vendorId === chatMe ? "#fff" : "inherit", border: "1px solid var(--border)", borderRadius: 12, padding: "6px 10px", fontSize: 13.5, maxWidth: "85%", textAlign: "left" }}>{mg.body}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input placeholder="Message the vendors…" value={chatBody} onChange={(e) => setChatBody(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && chatBody.trim() && (async () => {
                const b = chatBody; setChatBody("");
                await fetch("/api/vendor/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: b }) });
                loadChat();
              })()} />
            <button className="btn small" style={{ flex: "0 0 auto" }} disabled={busy || !chatBody.trim()} onClick={async () => {
              const b = chatBody; setChatBody("");
              await fetch("/api/vendor/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: b }) });
              loadChat();
            }}>SEND</button>
          </div>
        </div>
      )}

      {vtab === "settings" && (
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>SALE ALERTS 🔔</h2>
            <p style={{ fontSize: 13, color: "var(--ash)" }}>
              Get a push notification the moment your items sell. Without this you get one summary email at the end of each selling day — never an email per sale.
              {pushDevices !== null && pushDevices > 0 ? ` Currently ON for ${pushDevices} device${pushDevices === 1 ? "" : "s"}.` : ""}
            </p>
            <div style={{ margin: "10px 0 4px", display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn small" onClick={enablePush}>TURN ON FOR THIS DEVICE</button>
              {pushDevices !== null && pushDevices > 0 && (
                <button className="btn small ghost" onClick={async () => {
                  if (!confirm("Turn off sale alert pushes on all your devices? You'll get the daily summary email instead.")) return;
                  const r = await fetch("/api/vendor/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true }) });
                  if (r.ok) { setPushDevices(0); setPushMsg("Sale alerts off \u2014 you'll get the end-of-day summary email instead. \u2713"); }
                }}>TURN OFF \u2014 DAILY EMAIL INSTEAD</button>
              )}
            </div>
            <p style={{ fontSize: 11.5, color: "var(--ash)" }}>
              iPhone: works on iOS 16.4+ only after you add this site to your home screen (share button → Add to Home Screen) and open it from that icon. Android: works right in Chrome.
            </p>
            {pushMsg && <p className={pushMsg.includes("✓") ? "ok" : "err"}>{pushMsg}</p>}
          </div>

          <div className="card">
            <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>CHANGE PASSWORD</h2>
            <label>Current password</label>
            <input type="password" value={pwCur} onChange={(e) => setPwCur(e.target.value)} />
            <label>New password (8+ characters)</label>
            <input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} />
            <label>Type it again</label>
            <input type="password" value={pwNew2} onChange={(e) => setPwNew2(e.target.value)} />
            <div style={{ marginTop: 12 }}>
              <button className="btn small" onClick={changePw}>UPDATE PASSWORD</button>
            </div>
            {pwMsg && <p className={pwMsg.includes("✓") ? "ok" : "err"}>{pwMsg}</p>}
          </div>
        </div>
      )}
    </main>
  );
}

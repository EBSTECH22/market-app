"use client";

import { useCallback, useEffect, useState } from "react";

type Item = { id: string; sku: string; name: string; priceCents: number; quantity: number; active: boolean };
type Ledger = { id: string; type: string; amountCents: number; note: string; createdAt: string };
type Me = {
  vendor: { code: string; businessName: string; email: string; commissionPercent: number; mustChangePassword?: boolean; acceptsPreorders?: boolean; acceptsRequests?: boolean; publicBlurb?: string };
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
  const [pubMsg, setPubMsg] = useState("");
  const [po, setPo] = useState<{ status: string; description: string; subtotalCents: number; taxCents: number; totalCents: number; expectedDate: string; payUrl: string } | null>(null);
  const [poDesc, setPoDesc] = useState("");
  const [poAmt, setPoAmt] = useState("");
  const [poDate, setPoDate] = useState("");
  const [poMsg, setPoMsg] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/vendor/me");
    if (!res.ok) { window.location.href = "/"; return; }
    const data = await res.json();
    setMe(data);
    if (data?.vendor) {
      setPubPre(!!data.vendor.acceptsPreorders);
      setPubReq(!!data.vendor.acceptsRequests);
      setPubBlurb(data.vendor.publicBlurb || "");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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

  const savePublic = async () => {
    setPubMsg("");
    const r = await fetch("/api/vendor/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acceptsPreorders: pubPre, acceptsRequests: pubReq, publicBlurb: pubBlurb }),
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

  if (!me) return <main style={{ padding: 60, textAlign: "center" }}>Loading…</main>;

  if (me.vendor.mustChangePassword) {
    return (
      <main style={{ maxWidth: 430, margin: "0 auto", padding: "70px 16px" }}>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 110, height: 110, marginBottom: 8 }} />
          <div className="display" style={{ fontSize: 24 }}>COMMUNITY HARVEST</div>
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

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "26px 16px 70px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" style={{ width: 34, height: 34 }} />
            <div className="display" style={{ fontSize: 22 }}>{me.vendor.businessName.toUpperCase()}</div>
          </div>
          <div style={{ fontSize: 12, color: "var(--ash)", fontWeight: 600 }}>
            Vendor {me.vendor.code}
            {me.vendor.commissionPercent > 0 ? ` · ${me.vendor.commissionPercent}% market commission` : ""}
          </div>
        </div>
        <button className="btn small ghost" onClick={logout}>LOG OUT</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <div className="card" style={{ flex: "1 1 150px", textAlign: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ash)", letterSpacing: "0.05em" }}>YOUR BALANCE</div>
          <div className="display" style={{ fontSize: 26, color: me.balance >= 0 ? "var(--green)" : "var(--red)" }}>
            ${(me.balance / 100).toFixed(2)}
          </div>
        </div>
        <div className="card" style={{ flex: "1 1 150px", textAlign: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ash)", letterSpacing: "0.05em" }}>SOLD THIS MONTH</div>
          <div className="display" style={{ fontSize: 26 }}>${(me.monthSales / 100).toFixed(2)}</div>
          <div style={{ fontSize: 11, color: "var(--ash)" }}>your net: ${(me.monthNet / 100).toFixed(2)}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <h2 className="display" style={{ fontSize: 18 }}>YOUR ITEMS ON THE FLOOR</h2>
          <a className="btn small" href="/vendor/labels">🏷 PRINT BARCODE LABELS</a>
        </div>
        <ul style={{ listStyle: "none", marginTop: 8 }}>
          {me.items.map((it) => (
            <li key={it.id} style={{ padding: "11px 0", borderBottom: "2px dashed var(--ink)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <span className="display" style={{ fontSize: 15 }}>{it.name.toUpperCase()}</span>{" "}
                  <span className="display" style={{ fontSize: 15, color: "var(--red)" }}>
                    ${(it.priceCents / 100) % 1 === 0 ? (it.priceCents / 100).toFixed(0) : (it.priceCents / 100).toFixed(2)}
                  </span>
                  <div style={{ fontSize: 11.5, color: "var(--ash)" }}>{it.sku} · <b style={{ color: it.quantity > 0 ? "var(--green)" : "var(--ink)" }}>{it.quantity} on the floor</b></div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button className="btn small ghost" disabled={busy} onClick={() => {
                    const v = prompt(`New quantity on the floor for ${it.name}:`, String(it.quantity));
                    if (v !== null) patchItem(it.id, { quantity: v });
                  }}>SET QTY</button>
                  <button className="btn small ghost" disabled={busy} onClick={() => {
                    const v = prompt(`New price for ${it.name} (dollars):`, String(it.priceCents / 100));
                    if (v !== null) patchItem(it.id, { priceDollars: v });
                  }}>PRICE</button>
                  <button className="btn small ghost" disabled={busy} onClick={() => {
                    if (confirm(`Retire ${it.name}? It stops scanning at the register.`)) patchItem(it.id, { active: false });
                  }}>RETIRE</button>
                </div>
              </div>
            </li>
          ))}
          {me.items.length === 0 && <li style={{ color: "var(--ash)", paddingTop: 8, fontSize: 14 }}>No items yet — add your first below.</li>}
        </ul>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="display" style={{ fontSize: 17, marginBottom: 4 }}>ADD AN ITEM</h2>
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

      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="display" style={{ fontSize: 17, marginBottom: 4 }}>RECENT ACTIVITY</h2>
        <ul style={{ listStyle: "none" }}>
          {me.ledger.map((l) => (
            <li key={l.id} style={{ padding: "7px 0", borderBottom: "1px dashed var(--ink)", fontSize: 13, display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>{l.type === "SALE" ? "🛒" : l.type === "PAYOUT" ? "💸" : l.type === "RENT" ? "🏠" : "✏️"} {l.note || l.type}</span>
              <b style={{ color: l.amountCents >= 0 ? "var(--green)" : "var(--red)", whiteSpace: "nowrap" }}>
                {l.amountCents >= 0 ? "+" : "−"}${(Math.abs(l.amountCents) / 100).toFixed(2)}
              </b>
            </li>
          ))}
          {me.ledger.length === 0 && <li style={{ color: "var(--ash)", fontSize: 13, paddingTop: 6 }}>Sales, rent, and payouts will show here.</li>}
        </ul>
      </div>

      <div className="card">
        <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>INBOX 📩 — PRE-ORDERS, REQUESTS &amp; COMPLAINTS</h2>
        {openThread ? (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
              <b style={{ fontSize: 14 }}>{openThread.type} — {openThread.customerName}</b>
              <button className="btn small ghost" onClick={() => setOpenThread(null)}>← ALL MESSAGES</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--ash)", margin: "2px 0 8px" }}>{openThread.email} · {openThread.phone}</div>
            {openThread.messages.map((m) => (
              <div key={m.id} style={{
                margin: "6px 0", padding: "7px 9px", border: "1px solid #000", fontSize: 13,
                background: m.sender === "VENDOR" ? "#000" : "#fff", color: m.sender === "VENDOR" ? "#fff" : "#000",
                marginLeft: m.sender === "VENDOR" ? 20 : 0, marginRight: m.sender === "VENDOR" ? 0 : 20,
              }}>
                {m.body}
              </div>
            ))}
            {openThread.type === "PREORDER" && (
              <div style={{ border: "2px solid #000", padding: "10px 12px", margin: "10px 0" }}>
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
              <li key={t.id} style={{ padding: "8px 0", borderBottom: "1px dashed var(--ink)", cursor: "pointer" }} onClick={() => openInboxThread(t.id)}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                  <b>{t.type === "PREORDER" ? "🛒" : t.type === "REQUEST" ? "🙋" : "⚠️"} {t.customerName}</b>
                  <span style={{ fontWeight: 700 }}>{t.status === "CLOSED" ? "CLOSED" : ""}</span>
                </div>
                {t.last && <div style={{ fontSize: 12, color: "var(--ash)" }}>{t.last.sender === "VENDOR" ? "You: " : ""}{t.last.body}</div>}
              </li>
            ))}
            {inbox.length === 0 && <li style={{ fontSize: 13, color: "var(--ash)" }}>Nothing yet. Customers reach you here from your table QR card.</li>}
          </ul>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>YOUR PUBLIC PAGE &amp; TABLE QR 📱</h2>
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
        <label>Short blurb for your public page (what you make, in a sentence)</label>
        <input value={pubBlurb} onChange={(e) => setPubBlurb(e.target.value)} maxLength={300} />
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="btn small" onClick={savePublic}>SAVE</button>
          <a className="btn small ghost" href="/vendor/qr">🖨 PRINT MY TABLE QR CARD</a>
          {me && <a className="btn small ghost" href={`/v/${me.vendor.code}`} target="_blank" rel="noopener">VIEW MY PUBLIC PAGE</a>}
        </div>
        {pubMsg && <p className={pubMsg.includes("✓") ? "ok" : "err"}>{pubMsg}</p>}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>SALE ALERTS 🔔</h2>
        <p style={{ fontSize: 13, color: "var(--ash)" }}>
          Get a push notification the moment your items sell. Without this you get one summary email at the end of each selling day — never an email per sale.
          {pushDevices !== null && pushDevices > 0 ? ` Currently ON for ${pushDevices} device${pushDevices === 1 ? "" : "s"}.` : ""}
        </p>
        <div style={{ margin: "10px 0 4px" }}>
          <button className="btn small" onClick={enablePush}>TURN ON FOR THIS DEVICE</button>
        </div>
        <p style={{ fontSize: 11.5, color: "var(--ash)" }}>
          iPhone: works on iOS 16.4+ only after you add this site to your home screen (share button → Add to Home Screen) and open it from that icon. Android: works right in Chrome.
        </p>
        {pushMsg && <p className={pushMsg.includes("✓") ? "ok" : "err"}>{pushMsg}</p>}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
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
    </main>
  );
}

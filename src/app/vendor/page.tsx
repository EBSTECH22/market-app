"use client";

import { useCallback, useEffect, useState } from "react";

type Item = { id: string; sku: string; name: string; priceCents: number; quantity: number; active: boolean };
type Ledger = { id: string; type: string; amountCents: number; note: string; createdAt: string };
type Me = {
  vendor: { code: string; businessName: string; email: string; commissionPercent: number; mustChangePassword?: boolean };
  items: Item[]; ledger: Ledger[]; balance: number; monthSales: number; monthNet: number;
};

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

  const load = useCallback(async () => {
    const res = await fetch("/api/vendor/me");
    if (!res.ok) { window.location.href = "/"; return; }
    setMe(await res.json());
  }, []);

  useEffect(() => { load(); }, [load]);

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
          <div className="display" style={{ fontSize: 22 }}>{me.vendor.businessName.toUpperCase()}</div>
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

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Vendor = { id: string; code: string; businessName: string; contactName: string; email: string; phone: string; commissionPercent: number; active: boolean; balance: number };
type FloorItem = { id: string; sku: string; name: string; priceCents: number; quantity: number; vendorName: string; vendorCode: string };
type Overview = { today: { count: number; totalCents: number; taxCents: number }; month: { count: number; totalCents: number; taxCents: number }; vendors: number; floor: FloorItem[] };
type CartLine = { itemId: string; sku: string; name: string; vendorName: string; priceCents: number; quantity: number; floorQty: number };
type Contract = { id: string; boothLabel: string; monthlyRentCents: number; startDate: string; status: string; noticeGivenAt: string | null; endDate: string | null; vendor: { businessName: string; code: string } };
type Receipt = { subtotalCents: number; taxCents: number; totalCents: number; taxRate: number; paymentMethod: string; lines: CartLine[] };

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function AdminPage() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [tab, setTab] = useState<"register" | "floor" | "vendors" | "contracts" | "settings">("register");
  const [busy, setBusy] = useState(false);

  // register
  const [cart, setCart] = useState<CartLine[]>([]);
  const [scan, setScan] = useState("");
  const [scanErr, setScanErr] = useState("");
  const [taxRate, setTaxRate] = useState(9.0);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  // data
  const [overview, setOverview] = useState<Overview | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);

  // vendor form
  const [vName, setVName] = useState("");
  const [vContact, setVContact] = useState("");
  const [vEmail, setVEmail] = useState("");
  const [vPhone, setVPhone] = useState("");
  const [vComm, setVComm] = useState("0");
  const [vMsg, setVMsg] = useState("");

  // contract form
  const [cVendor, setCVendor] = useState("");
  const [cBooth, setCBooth] = useState("");
  const [cRent, setCRent] = useState("150");
  const [cStart, setCStart] = useState("");
  const [cMsg, setCMsg] = useState("");

  const [settingsMsg, setSettingsMsg] = useState("");

  const loadAll = useCallback(async () => {
    const [o, v, c, s] = await Promise.all([
      fetch("/api/admin/overview"),
      fetch("/api/admin/vendors"),
      fetch("/api/admin/contracts"),
      fetch("/api/admin/settings"),
    ]);
    if (o.status === 401) { setAuthed(false); return; }
    setAuthed(true);
    if (o.ok) setOverview(await o.json());
    if (v.ok) setVendors((await v.json()).vendors || []);
    if (c.ok) setContracts((await c.json()).contracts || []);
    if (s.ok) setTaxRate((await s.json()).taxRatePercent);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (authed && tab === "register") scanRef.current?.focus();
  }, [authed, tab, cart, receipt]);

  const login = async () => {
    setLoginError("");
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) { setLoginError("Wrong password."); return; }
    await loadAll();
  };

  // ---------- register ----------
  const addScan = async () => {
    const code = scan.trim().toUpperCase();
    setScan("");
    if (!code) return;
    setScanErr("");
    const existing = cart.find((l) => l.sku === code);
    if (existing) {
      setCart((c) => c.map((l) => (l.sku === code ? { ...l, quantity: l.quantity + 1 } : l)));
      return;
    }
    const res = await fetch(`/api/admin/lookup?sku=${encodeURIComponent(code)}`);
    const data = await res.json();
    if (!res.ok) { setScanErr(data.error || `Nothing found for ${code}.`); return; }
    setCart((c) => [...c, {
      itemId: data.item.id, sku: data.item.sku, name: data.item.name,
      vendorName: data.item.vendor.businessName, priceCents: data.item.priceCents,
      quantity: 1, floorQty: data.item.quantity,
    }]);
  };

  const subtotal = cart.reduce((n, l) => n + l.priceCents * l.quantity, 0);
  const taxCents = Math.round((subtotal * taxRate) / 100);
  const total = subtotal + taxCents;

  const completeSale = async (paymentMethod: "CASH" | "CARD") => {
    if (!cart.length) return;
    setBusy(true);
    const res = await fetch("/api/admin/sale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentMethod, lines: cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity })) }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setScanErr(data.error || "Sale failed."); return; }
    setReceipt({ ...data.sale, paymentMethod, lines: cart });
    setCart([]);
    loadAll();
  };

  // ---------- vendors ----------
  const addVendor = async () => {
    setVMsg("");
    setBusy(true);
    const res = await fetch("/api/admin/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessName: vName, contactName: vContact, email: vEmail, phone: vPhone, commissionPercent: vComm }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setVMsg(data.error || "Couldn't add vendor."); return; }
    setVMsg(`Added ${data.vendor.businessName} (${data.vendor.code}). Temp password: ${data.tempPassword} — also emailed to them.`);
    setVName(""); setVContact(""); setVEmail(""); setVPhone(""); setVComm("0");
    await loadAll();
  };

  const patchVendor = async (id: string, body: object, doneMsg?: string) => {
    setBusy(true);
    const res = await fetch(`/api/admin/vendors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { alert(data.error || "Update failed."); return; }
    if (data.tempPassword) alert(`New temp password for ${data.vendor.businessName}: ${data.tempPassword}`);
    else if (doneMsg) alert(doneMsg);
    await loadAll();
  };

  const ledgerEntry = async (v: Vendor, type: "RENT" | "PAYOUT" | "ADJUST") => {
    const label = type === "RENT" ? "Rent amount to charge" : type === "PAYOUT" ? "Payout amount you're paying them" : "Adjustment (use minus sign to subtract)";
    const raw = prompt(`${label} for ${v.businessName} (dollars):`, type === "PAYOUT" ? String(Math.max(0, v.balance) / 100) : "");
    if (raw === null) return;
    const note = prompt("Note (shows on their statement):", type === "RENT" ? "Monthly booth rent" : type === "PAYOUT" ? "Payout" : "") || "";
    setBusy(true);
    const res = await fetch(`/api/admin/vendors/${v.id}/ledger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, amountDollars: raw, note }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { alert(data.error || "Failed."); return; }
    await loadAll();
  };

  // ---------- contracts ----------
  const addContract = async () => {
    setCMsg("");
    setBusy(true);
    const res = await fetch("/api/admin/contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId: cVendor, boothLabel: cBooth, monthlyRentDollars: cRent, startDate: cStart }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setCMsg(data.error || "Couldn't create it."); return; }
    setCMsg("Contract created — open PRINT to sign it.");
    setCBooth(""); setCStart("");
    await loadAll();
  };

  const contractAction = async (id: string, action: string, confirmText: string) => {
    if (!confirm(confirmText)) return;
    setBusy(true);
    await fetch(`/api/admin/contracts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    await loadAll();
  };

  const saveTax = async () => {
    setSettingsMsg("");
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taxRatePercent: taxRate }),
    });
    const data = await res.json();
    setSettingsMsg(res.ok ? "Saved. ✓" : data.error || "Failed.");
  };

  if (!authed) {
    return (
      <main style={{ maxWidth: 380, margin: "0 auto", padding: "80px 18px" }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div className="display" style={{ fontSize: 26 }}>THE MARKET AT NOBLE</div>
          <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ash)" }}>Register &amp; Management</div>
        </div>
        <div className="card">
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()} />
          <div style={{ marginTop: 14 }}>
            <button className="btn" onClick={login}>UNLOCK</button>
          </div>
          {loginError && <p className="err">{loginError}</p>}
        </div>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "22px 14px 70px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <span className="display" style={{ fontSize: 20 }}>THE MARKET AT NOBLE</span>
        {overview && (
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ash)" }}>
            Today: {money(overview.today.totalCents)} · {overview.today.count} sales
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}>
        {(["register", "floor", "vendors", "contracts", "settings"] as const).map((t) => (
          <button key={t} className={`btn small ${tab === t ? "" : "ghost"}`} onClick={() => { setTab(t); setReceipt(null); }}>
            {t === "register" ? "🛒 REGISTER" : t === "floor" ? "FLOOR" : t.toUpperCase()}
          </button>
        ))}
      </div>

      {tab === "register" && !receipt && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <label htmlFor="scan">Scan or type a code, then Enter</label>
            <input
              id="scan" ref={scanRef} value={scan} autoComplete="off"
              onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addScan()}
              placeholder="V01-0001"
              style={{ fontSize: 20, fontFamily: "monospace" }}
            />
            {scanErr && <p className="err">{scanErr}</p>}
          </div>

          <div className="card">
            {cart.length === 0 && <p style={{ color: "var(--ash)", fontSize: 14 }}>Ticket is empty — scan the first item.</p>}
            {cart.map((l) => (
              <div key={l.sku} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "2px dashed var(--ink)", gap: 8, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{l.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--ash)" }}>{l.vendorName} · {l.sku} · {money(l.priceCents)} each</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button className="btn small ghost" onClick={() => setCart((c) => c.map((x) => x.sku === l.sku ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x))}>−</button>
                  <b>{l.quantity}</b>
                  <button className="btn small ghost" onClick={() => setCart((c) => c.map((x) => x.sku === l.sku ? { ...x, quantity: x.quantity + 1 } : x))}>+</button>
                  <b style={{ minWidth: 64, textAlign: "right" }}>{money(l.priceCents * l.quantity)}</b>
                  <button className="btn small ghost" style={{ color: "var(--red)", borderColor: "var(--red)" }} onClick={() => setCart((c) => c.filter((x) => x.sku !== l.sku))}>✕</button>
                </div>
              </div>
            ))}
            {cart.length > 0 && (
              <>
                <div style={{ textAlign: "right", marginTop: 12, fontSize: 15 }}>
                  <div>Subtotal: <b>{money(subtotal)}</b></div>
                  <div>Tax ({taxRate}%): <b>{money(taxCents)}</b></div>
                  <div className="display" style={{ fontSize: 26 }}>TOTAL: {money(total)}</div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => completeSale("CASH")}>💵 CASH</button>
                  <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => completeSale("CARD")}>💳 CARD</button>
                </div>
                <button className="btn small ghost" style={{ marginTop: 10 }} onClick={() => setCart([])}>CLEAR TICKET</button>
              </>
            )}
          </div>
        </>
      )}

      {tab === "register" && receipt && (
        <div className="card" style={{ textAlign: "center" }}>
          <h2 className="display" style={{ fontSize: 22, color: "var(--green)" }}>SALE COMPLETE ✓</h2>
          <div style={{ textAlign: "left", maxWidth: 340, margin: "12px auto" }}>
            {receipt.lines.map((l) => (
              <div key={l.sku} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "4px 0" }}>
                <span>{l.quantity}× {l.name}</span><b>{money(l.priceCents * l.quantity)}</b>
              </div>
            ))}
            <div style={{ borderTop: "2px solid var(--ink)", marginTop: 6, paddingTop: 6, fontSize: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>Subtotal</span><b>{money(receipt.subtotalCents)}</b></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>Tax ({receipt.taxRate}%)</span><b>{money(receipt.taxCents)}</b></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18 }} className="display"><span>TOTAL ({receipt.paymentMethod})</span><span>{money(receipt.totalCents)}</span></div>
            </div>
          </div>
          <p style={{ fontSize: 12, color: "var(--ash)" }}>Vendors have been notified and their inventory updated.</p>
          <button className="btn" style={{ marginTop: 10 }} onClick={() => setReceipt(null)}>NEXT CUSTOMER →</button>
        </div>
      )}

      {tab === "floor" && overview && (
        <div className="card">
          <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>EVERYTHING ON THE FLOOR</h2>
          <table className="grid">
            <thead><tr><th>Vendor</th><th>Item</th><th>Code</th><th>Price</th><th>Qty</th></tr></thead>
            <tbody>
              {overview.floor.map((i) => (
                <tr key={i.id} style={i.quantity === 0 ? { opacity: 0.45 } : undefined}>
                  <td>{i.vendorCode} {i.vendorName}</td>
                  <td style={{ fontWeight: 700 }}>{i.name}</td>
                  <td style={{ fontFamily: "monospace" }}>{i.sku}</td>
                  <td>{money(i.priceCents)}</td>
                  <td style={{ fontWeight: 700 }}>{i.quantity}</td>
                </tr>
              ))}
              {overview.floor.length === 0 && <tr><td colSpan={5}>Nothing yet — vendors add items from their portal.</td></tr>}
            </tbody>
          </table>
          <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 10 }}>
            This month: {money(overview.month.totalCents)} across {overview.month.count} sales · sales tax collected: <b>{money(overview.month.taxCents)}</b>
          </p>
        </div>
      )}

      {tab === "vendors" && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>VENDORS ({vendors.filter((v) => v.active).length} ACTIVE)</h2>
            <ul style={{ listStyle: "none" }}>
              {vendors.map((v) => (
                <li key={v.id} style={{ padding: "11px 0", borderBottom: "2px dashed var(--ink)", opacity: v.active ? 1 : 0.5 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <span className="display" style={{ fontSize: 15 }}>{v.code} · {v.businessName.toUpperCase()}</span>
                      <div style={{ fontSize: 11.5, color: "var(--ash)" }}>
                        {v.contactName}{v.contactName && " · "}{v.email}{v.phone && ` · ${v.phone}`}
                        {" · "}{v.commissionPercent}% commission
                        {" · balance "}<b style={{ color: v.balance >= 0 ? "var(--green)" : "var(--red)" }}>{money(v.balance)}</b>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                      <button className="btn small ghost" disabled={busy} onClick={() => {
                        const c = prompt(`Commission % for ${v.businessName}:`, String(v.commissionPercent));
                        if (c !== null) patchVendor(v.id, { commissionPercent: c });
                      }}>COMM %</button>
                      <button className="btn small ghost" disabled={busy} onClick={() => ledgerEntry(v, "RENT")}>CHARGE RENT</button>
                      <button className="btn small ghost" disabled={busy} onClick={() => ledgerEntry(v, "PAYOUT")}>RECORD PAYOUT</button>
                      <button className="btn small ghost" disabled={busy} onClick={() => ledgerEntry(v, "ADJUST")}>ADJUST</button>
                      <button className="btn small ghost" disabled={busy} onClick={() => {
                        if (confirm(`Reset ${v.businessName}'s password?`)) patchVendor(v.id, { resetPassword: true });
                      }}>RESET PW</button>
                      <button className="btn small ghost" disabled={busy} onClick={() => patchVendor(v.id, { active: !v.active }, v.active ? "Deactivated." : "Reactivated.")}>
                        {v.active ? "DEACTIVATE" : "REACTIVATE"}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
              {vendors.length === 0 && <li style={{ color: "var(--ash)", fontSize: 14, paddingTop: 8 }}>No vendors yet — add your first below.</li>}
            </ul>
          </div>

          <div className="card">
            <h2 className="display" style={{ fontSize: 17, marginBottom: 4 }}>ADD A VENDOR</h2>
            <label>Business name</label>
            <input value={vName} onChange={(e) => setVName(e.target.value)} placeholder="Prairie Rose Candle Co." />
            <label>Contact name</label>
            <input value={vContact} onChange={(e) => setVContact(e.target.value)} />
            <label>Email (their login — welcome email goes here)</label>
            <input value={vEmail} onChange={(e) => setVEmail(e.target.value)} type="email" />
            <label>Phone</label>
            <input value={vPhone} onChange={(e) => setVPhone(e.target.value)} />
            <label>Commission % (0 for none — you can change it anytime)</label>
            <input value={vComm} onChange={(e) => setVComm(e.target.value)} type="number" min="0" max="50" step="0.5" />
            <div style={{ marginTop: 14 }}>
              <button className="btn" disabled={busy} onClick={addVendor}>ADD VENDOR &amp; SEND WELCOME EMAIL</button>
            </div>
            {vMsg && <p className={vMsg.includes("Added") ? "ok" : "err"}>{vMsg}</p>}
          </div>
        </>
      )}

      {tab === "contracts" && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>BOOTH CONTRACTS</h2>
            <ul style={{ listStyle: "none" }}>
              {contracts.map((c) => (
                <li key={c.id} style={{ padding: "11px 0", borderBottom: "2px dashed var(--ink)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <span className="display" style={{ fontSize: 15 }}>BOOTH {c.boothLabel.toUpperCase()} · {c.vendor.businessName.toUpperCase()}</span>
                      <div style={{ fontSize: 11.5, color: "var(--ash)" }}>
                        {money(c.monthlyRentCents)}/mo · started {new Date(c.startDate).toLocaleDateString()}
                        {" · "}
                        <b style={{ color: c.status === "ACTIVE" ? "var(--green)" : c.status === "TERMINATING" ? "var(--red)" : "var(--ash)" }}>
                          {c.status === "TERMINATING" && c.endDate ? `ENDS ${new Date(c.endDate).toLocaleDateString()}` : c.status}
                        </b>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                      <a className="btn small ghost" href={`/admin/contracts/${c.id}/print`} target="_blank" rel="noopener">🖨 PRINT</a>
                      {c.status === "ACTIVE" && (
                        <>
                          <button className="btn small ghost" disabled={busy} onClick={() => {
                            const r = prompt("New monthly rent (dollars):", String(c.monthlyRentCents / 100));
                            if (r !== null) fetch(`/api/admin/contracts/${c.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthlyRentDollars: r }) }).then(loadAll);
                          }}>EDIT RENT</button>
                          <button className="btn small ghost" disabled={busy} onClick={() => contractAction(c.id, "give_notice", "Record 30-day termination notice today? The contract ends 30 days from now.")}>GIVE 30-DAY NOTICE</button>
                        </>
                      )}
                      {c.status !== "ENDED" && (
                        <button className="btn small ghost" style={{ color: "var(--red)", borderColor: "var(--red)" }} disabled={busy} onClick={() => contractAction(c.id, "end_now", "End this contract immediately?")}>END NOW</button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
              {contracts.length === 0 && <li style={{ color: "var(--ash)", fontSize: 14, paddingTop: 8 }}>No contracts yet.</li>}
            </ul>
          </div>

          <div className="card">
            <h2 className="display" style={{ fontSize: 17, marginBottom: 4 }}>NEW BOOTH CONTRACT</h2>
            <label>Vendor</label>
            <select value={cVendor} onChange={(e) => setCVendor(e.target.value)}>
              <option value="">Choose a vendor…</option>
              {vendors.filter((v) => v.active).map((v) => (
                <option key={v.id} value={v.id}>{v.code} — {v.businessName}</option>
              ))}
            </select>
            <label>Booth (e.g. A3, 5, NW Corner)</label>
            <input value={cBooth} onChange={(e) => setCBooth(e.target.value)} />
            <label>Monthly rent (dollars — 0 allowed, every booth can differ)</label>
            <input value={cRent} onChange={(e) => setCRent(e.target.value)} type="number" min="0" step="5" />
            <label>Start date</label>
            <input value={cStart} onChange={(e) => setCStart(e.target.value)} type="date" />
            <div style={{ marginTop: 14 }}>
              <button className="btn" disabled={busy} onClick={addContract}>CREATE CONTRACT</button>
            </div>
            {cMsg && <p className={cMsg.includes("created") ? "ok" : "err"}>{cMsg}</p>}
            <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 10 }}>
              Month-to-month, auto-renews, 30-day written notice to end — the printed contract spells it out for signatures.
              Use CHARGE RENT on the VENDORS tab each month to post rent against their balance.
            </p>
          </div>
        </>
      )}

      {tab === "settings" && (
        <div className="card">
          <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>SETTINGS</h2>
          <label>Sales tax rate (%) — combined state + county + city for Noble</label>
          <input type="number" min="0" max="15" step="0.125" value={taxRate} onChange={(e) => setTaxRate(Number(e.target.value))} />
          <div style={{ marginTop: 14 }}>
            <button className="btn small" onClick={saveTax}>SAVE</button>
          </div>
          {settingsMsg && <p className={settingsMsg.includes("✓") ? "ok" : "err"}>{settingsMsg}</p>}
          <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 12 }}>
            Verify Noble&rsquo;s current combined rate with the Oklahoma Tax Commission before opening day — one setting here, applied to every sale.
          </p>
        </div>
      )}
    </main>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Vendor = { id: string; code: string; businessName: string; contactName: string; email: string; phone: string; commissionPercent: number; active: boolean; balance: number };
type FloorItem = { id: string; sku: string; name: string; priceCents: number; quantity: number; vendorName: string; vendorCode: string };
type Overview = { today: { count: number; totalCents: number; taxCents: number }; month: { count: number; totalCents: number; taxCents: number }; vendors: number; floor: FloorItem[] };
type CartLine = { itemId: string; sku: string; name: string; vendorName: string; priceCents: number; quantity: number };
type Contract = { id: string; vendorId: string; boothLabel: string; monthlyRentCents: number; startDate: string; status: string; noticeGivenAt: string | null; endDate: string | null; vendor: { businessName: string; code: string } };
type Receipt = { id: string; number: number; employee: string; cardName: string; createdAt: string; subtotalCents: number; taxCents: number; totalCents: number; taxRate: number; paymentMethod: string; lines: CartLine[] };
type Drawer = { id: string; employee: string; openedAt: string; openTotalCents: number; cashSalesCents: number } | null;
type Ticket = { id: string; number: number; dateStr: string; timeStr: string; paymentMethod: string; cardName: string; employee: string; totalCents: number; vendorCodes: string[] };
type Employee = { id: string; name: string };
type Report = {
  start: string; end: string; gross: number; tax: number; cash: number; card: number; tickets: number;
  vGross: number; vNet: number; units: number;
  byVendor: { vendor: { code: string; businessName: string }; cents: number }[];
  byItem: { name: string; q: number; c: number }[];
  byHour: Record<string, number>;
};

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const DENOMS: [string, string, number][] = [
  ["b100", "$100 bills", 10000], ["b50", "$50 bills", 5000], ["b20", "$20 bills", 2000],
  ["b10", "$10 bills", 1000], ["b5", "$5 bills", 500], ["b1", "$1 bills", 100],
  ["q", "Quarters", 25], ["d", "Dimes", 10], ["n", "Nickels", 5], ["p", "Pennies", 1],
];

export default function AdminPage() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [tab, setTab] = useState<"register" | "reports" | "bank" | "floor" | "vendors" | "contracts" | "settings">("register");
  const [busy, setBusy] = useState(false);

  // register / drawer
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [drawerLoaded, setDrawerLoaded] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [empName, setEmpName] = useState("");
  const [empPin, setEmpPin] = useState("");
  const [drawerErr, setDrawerErr] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [closing, setClosing] = useState(false);
  const [closeReport, setCloseReport] = useState<{ employee: string; openTotalCents: number; cashSalesCents: number; expected: number; counted: number; diff: number } | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [scan, setScan] = useState("");
  const [scanErr, setScanErr] = useState("");
  const [search, setSearch] = useState("");
  const [openVendor, setOpenVendor] = useState<string | null>(null);
  const [cardName, setCardName] = useState("");
  const [taxRate, setTaxRate] = useState(9.0);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [autoPrint, setAutoPrint] = useState(true);
  const scanRef = useRef<HTMLInputElement>(null);
  const printRef = useRef<HTMLDivElement>(null);

  // tickets
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketQ, setTicketQ] = useState("");

  // data
  const [overview, setOverview] = useState<Overview | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);

  // reports
  const [repPeriod, setRepPeriod] = useState("day");
  const [repVendor, setRepVendor] = useState("all");
  const [repFrom, setRepFrom] = useState("");
  const [repTo, setRepTo] = useState("");
  const [report, setReport] = useState<Report | null>(null);

  // bank
  const [bank, setBank] = useState<{ configured: boolean; available?: number; pending?: number; payouts?: { id: string; amount: number; status: string; arrival: string }[]; error?: string } | null>(null);

  // vendor form
  const [vName, setVName] = useState(""); const [vContact, setVContact] = useState("");
  const [vEmail, setVEmail] = useState(""); const [vPhone, setVPhone] = useState("");
  const [vComm, setVComm] = useState("0"); const [vMsg, setVMsg] = useState("");

  // contract form
  const [cVendor, setCVendor] = useState(""); const [cBooth, setCBooth] = useState("");
  const [cRent, setCRent] = useState("150"); const [cStart, setCStart] = useState("");
  const [cMsg, setCMsg] = useState("");

  // settings
  const [settingsMsg, setSettingsMsg] = useState("");
  const [newEmpName, setNewEmpName] = useState("");
  const [newEmpPin, setNewEmpPin] = useState("");
  const [empMsg, setEmpMsg] = useState("");

  const loadDrawer = useCallback(async () => {
    const res = await fetch("/api/admin/drawer");
    if (res.status === 401) { setAuthed(false); return; }
    setAuthed(true);
    const data = await res.json();
    setDrawer(data.session);
    setDrawerLoaded(true);
  }, []);

  const loadAll = useCallback(async () => {
    const [o, v, c, s, e] = await Promise.all([
      fetch("/api/admin/overview"), fetch("/api/admin/vendors"),
      fetch("/api/admin/contracts"), fetch("/api/admin/settings"),
      fetch("/api/admin/employees"),
    ]);
    if (o.status === 401) { setAuthed(false); return; }
    setAuthed(true);
    if (o.ok) setOverview(await o.json());
    if (v.ok) setVendors((await v.json()).vendors || []);
    if (c.ok) setContracts((await c.json()).contracts || []);
    if (s.ok) setTaxRate((await s.json()).taxRatePercent);
    if (e.ok) setEmployees((await e.json()).employees || []);
  }, []);

  const loadTickets = useCallback(async (q: string) => {
    const res = await fetch(`/api/admin/tickets?q=${encodeURIComponent(q)}`);
    if (res.ok) setTickets((await res.json()).tickets || []);
  }, []);

  const loadReport = useCallback(async () => {
    const params = new URLSearchParams({ period: repPeriod, vendor: repVendor });
    if (repPeriod === "custom") { if (repFrom) params.set("from", repFrom); if (repTo) params.set("to", repTo); }
    const res = await fetch(`/api/admin/reports?${params}`);
    if (res.ok) setReport(await res.json());
  }, [repPeriod, repVendor, repFrom, repTo]);

  useEffect(() => { loadDrawer(); loadAll(); }, [loadDrawer, loadAll]);
  useEffect(() => { if (authed && tab === "register") loadTickets(ticketQ); }, [authed, tab, ticketQ, loadTickets]);
  useEffect(() => { if (authed && tab === "reports") loadReport(); }, [authed, tab, loadReport]);
  useEffect(() => {
    if (authed && tab === "bank") fetch("/api/admin/stripe").then(async (r) => setBank(await r.json()));
  }, [authed, tab]);
  useEffect(() => {
    try { const v = window.localStorage.getItem("nm_autoprint"); if (v !== null) setAutoPrint(v === "1"); } catch {}
  }, []);
  useEffect(() => {
    if (authed && tab === "register" && drawer && !receipt && !closing) scanRef.current?.focus();
  }, [authed, tab, drawer, cart, receipt, closing]);

  const login = async () => {
    setLoginError("");
    const res = await fetch("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) { setLoginError("Wrong password."); return; }
    await loadDrawer(); await loadAll();
  };

  // ---------- drawer ----------
  const countTotal = () => DENOMS.reduce((t, [k, , cents]) => t + Math.max(0, Math.round(Number(counts[k]) || 0)) * cents, 0);

  const openDrawer = async () => {
    setDrawerErr("");
    setBusy(true);
    const res = await fetch("/api/admin/drawer", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee: empName || employees[0]?.name, pin: empPin, counts, totalCents: countTotal() }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setDrawerErr(data.error || "Couldn't open."); return; }
    setCounts({}); setEmpPin("");
    await loadDrawer();
  };

  const closeDrawer = async () => {
    setBusy(true);
    const res = await fetch("/api/admin/drawer", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ counts, countedCents: countTotal() }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setDrawerErr(data.error || "Couldn't close."); return; }
    setCloseReport({
      employee: data.session.employee,
      openTotalCents: data.session.openTotalCents,
      cashSalesCents: data.session.cashSalesCents,
      expected: data.expected,
      counted: data.session.countedCents,
      diff: data.session.diffCents,
    });
    setCounts({}); setClosing(false); setDrawer(null);
  };

  // ---------- register ----------
  const addItemToCart = (item: { id: string; sku: string; name: string; priceCents: number; vendorName: string }) => {
    setScanErr(""); setSearch(""); setOpenVendor(null);
    setCart((c) => {
      const line = c.find((l) => l.sku === item.sku);
      if (line) return c.map((l) => (l.sku === item.sku ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { itemId: item.id, sku: item.sku, name: item.name, vendorName: item.vendorName, priceCents: item.priceCents, quantity: 1 }];
    });
  };

  const doScan = async () => {
    const code = scan.trim().toUpperCase();
    setScan("");
    if (!code) return;
    const inCart = cart.find((l) => l.sku === code);
    if (inCart) { addItemToCart({ id: inCart.itemId, sku: inCart.sku, name: inCart.name, priceCents: inCart.priceCents, vendorName: inCart.vendorName }); return; }
    const res = await fetch(`/api/admin/lookup?sku=${encodeURIComponent(code)}`);
    const data = await res.json();
    if (!res.ok) { setScanErr(data.error || `Nothing found for ${code}.`); return; }
    addItemToCart({ id: data.item.id, sku: data.item.sku, name: data.item.name, priceCents: data.item.priceCents, vendorName: data.item.vendor.businessName });
  };

  const floor = overview?.floor || [];
  const searchHits = search.trim()
    ? floor.filter((i) => i.name.toLowerCase().includes(search.trim().toLowerCase()) || i.sku.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 10)
    : [];

  const subtotal = cart.reduce((n, l) => n + l.priceCents * l.quantity, 0);
  const taxCents = Math.round((subtotal * taxRate) / 100);
  const total = subtotal + taxCents;

  const printSale = useCallback(async (saleId: string) => {
    const res = await fetch(`/api/admin/tickets/${saleId}`);
    if (!res.ok) return;
    const { sale } = await res.json();
    if (!printRef.current) return;
    printRef.current.innerHTML = `
      <div style="width:280px;margin:0 auto;font-size:12px;line-height:1.5;text-align:center;font-family:'IBM Plex Mono',monospace;color:#000">
        <div style="font-weight:700;font-size:14px">${(process.env.NEXT_PUBLIC_MARKET_NAME || "THE MARKET AT NOBLE").toUpperCase()}</div>
        <div>Noble, Oklahoma</div>
        <div style="margin:6px 0;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:4px 0">
          RECEIPT #${sale.number}<br>${new Date(sale.createdAt).toLocaleDateString("en-US")} ${new Date(sale.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}${sale.employee ? "<br>CLERK: " + sale.employee : ""}
        </div>
        <div style="text-align:left">
          ${sale.lines.map((l: { quantity: number; name: string; priceCents: number }) => `<div style="display:flex;justify-content:space-between"><span>${l.quantity}x ${l.name.slice(0, 26)}</span><span>${money(l.priceCents * l.quantity)}</span></div>`).join("")}
        </div>
        <div style="border-top:1px dashed #000;margin-top:4px;padding-top:4px;text-align:left">
          <div style="display:flex;justify-content:space-between"><span>SUBTOTAL</span><span>${money(sale.subtotalCents)}</span></div>
          <div style="display:flex;justify-content:space-between"><span>TAX</span><span>${money(sale.taxCents)}</span></div>
          <div style="display:flex;justify-content:space-between;font-weight:700;font-size:14px"><span>TOTAL</span><span>${money(sale.totalCents)}</span></div>
          <div>${sale.paymentMethod}${sale.cardName ? " - " + sale.cardName : ""}</div>
        </div>
        <div style="margin-top:8px">THANK YOU!<br>homegrown + homemade</div>
      </div>`;
    document.body.classList.add("receiptmode");
    window.print();
    setTimeout(() => document.body.classList.remove("receiptmode"), 400);
  }, []);

  const completeSale = async (paymentMethod: "CASH" | "CARD") => {
    if (!cart.length) return;
    setBusy(true);
    const res = await fetch("/api/admin/sale", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentMethod, cardName, lines: cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity })) }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setScanErr(data.error || "Sale failed."); return; }
    setReceipt({ ...data.sale, paymentMethod, lines: cart });
    setCart([]); setCardName("");
    loadDrawer(); loadAll(); loadTickets(ticketQ);
    if (autoPrint) setTimeout(() => printSale(data.sale.id), 250);
  };

  const toggleAutoPrint = () => {
    setAutoPrint((v) => {
      try { window.localStorage.setItem("nm_autoprint", v ? "0" : "1"); } catch {}
      return !v;
    });
  };

  // ---------- vendors ----------
  const addVendor = async () => {
    setVMsg(""); setBusy(true);
    const res = await fetch("/api/admin/vendors", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessName: vName, contactName: vContact, email: vEmail, phone: vPhone, commissionPercent: vComm }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setVMsg(data.error || "Couldn't add vendor."); return; }
    setVMsg(`Added ${data.vendor.businessName} (${data.vendor.code}). Temp password: ${data.tempPassword} — also emailed to them.`);
    setVName(""); setVContact(""); setVEmail(""); setVPhone(""); setVComm("0");
    await loadAll();
  };

  const patchVendor = async (id: string, body: object) => {
    setBusy(true);
    const res = await fetch(`/api/admin/vendors/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { alert(data.error || "Update failed."); return; }
    if (data.tempPassword) alert(`New temp password for ${data.vendor.businessName}: ${data.tempPassword}`);
    await loadAll();
  };

  const ledgerEntry = async (v: Vendor, type: "RENT" | "PAYOUT" | "ADJUST") => {
    const label = type === "RENT" ? "Rent amount to charge" : type === "PAYOUT" ? "Payout amount you're paying them" : "Adjustment (minus sign to subtract)";
    const raw = prompt(`${label} for ${v.businessName} (dollars):`, type === "PAYOUT" ? String(Math.max(0, v.balance) / 100) : "");
    if (raw === null) return;
    const note = prompt("Note (shows on their statement):", type === "RENT" ? "Booth rent" : type === "PAYOUT" ? "Payout" : "") || "";
    setBusy(true);
    const res = await fetch(`/api/admin/vendors/${v.id}/ledger`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, amountDollars: raw, note }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { alert(data.error || "Failed."); return; }
    await loadAll();
  };

  // ---------- contracts ----------
  const addContract = async () => {
    setCMsg(""); setBusy(true);
    const res = await fetch("/api/admin/contracts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId: cVendor, boothLabel: cBooth, monthlyRentDollars: cRent, startDate: cStart }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setCMsg(data.error || "Couldn't create it."); return; }
    setCMsg(`Contract created. First month prorated: ${money(data.firstMonthCents)} — posted to their balance. Full rent auto-charges every 1st after that.`);
    setCBooth(""); setCStart("");
    await loadAll();
  };

  const giveNotice = async (c: Contract) => {
    const d = prompt("Date the 30-day notice was given (YYYY-MM-DD):", new Date().toISOString().slice(0, 10));
    if (d === null) return;
    setBusy(true);
    const res = await fetch(`/api/admin/contracts/${c.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "give_notice", noticeDate: d }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { alert(data.error || "Failed."); return; }
    alert(`Notice recorded. Lease ends ${new Date(data.contract.endDate).toLocaleDateString()}. Final month rent prorates to ${money(data.finalRentCents)}.`);
    await loadAll();
  };

  const finalStatement = (c: Contract) => {
    const v = vendors.find((x) => x.id === c.vendorId);
    if (!v || !c.endDate) return;
    const end = new Date(c.endDate);
    const dim = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
    const finalRent = Math.round((c.monthlyRentCents * end.getDate()) / dim);
    const net = v.balance - finalRent;
    alert(
      `FINAL STATEMENT — ${v.businessName}\nLease ends: ${end.toLocaleDateString()}\nCurrent balance: ${money(v.balance)}\nFinal month rent (prorated, auto-charges on the 1st): ${money(finalRent)}\n--------------------------\n${net >= 0 ? "WE OWE THEM: " + money(net) : "THEY OWE US: " + money(-net)}`
    );
  };

  const contractAction = async (id: string, action: string, confirmText: string) => {
    if (!confirm(confirmText)) return;
    setBusy(true);
    await fetch(`/api/admin/contracts/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    await loadAll();
  };

  // ---------- settings ----------
  const saveTax = async () => {
    setSettingsMsg("");
    const res = await fetch("/api/admin/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taxRatePercent: taxRate }),
    });
    const data = await res.json();
    setSettingsMsg(res.ok ? "Saved. ✓" : data.error || "Failed.");
  };

  const addEmployee = async () => {
    setEmpMsg("");
    const res = await fetch("/api/admin/employees", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newEmpName, pin: newEmpPin }),
    });
    const data = await res.json();
    if (!res.ok) { setEmpMsg(data.error || "Failed."); return; }
    setEmpMsg(`${data.employee.name} can now open the register. ✓`);
    setNewEmpName(""); setNewEmpPin("");
    await loadAll();
  };

  const removeEmployee = async (e: Employee) => {
    if (!confirm(`Remove ${e.name} from the register?`)) return;
    await fetch(`/api/admin/employees?id=${e.id}`, { method: "DELETE" });
    await loadAll();
  };

  const countForm = (
    <div>
      <table className="grid">
        <thead><tr><th>Denomination</th><th style={{ textAlign: "right" }}>Count</th></tr></thead>
        <tbody>
          {DENOMS.map(([k, label]) => (
            <tr key={k}>
              <td>{label}</td>
              <td style={{ textAlign: "right" }}>
                <input type="number" min="0" step="1" value={counts[k] ?? ""}
                  onChange={(e) => setCounts((c) => ({ ...c, [k]: e.target.value }))}
                  style={{ width: 90, textAlign: "right", padding: "6px 8px" }} placeholder="0" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ background: "var(--ink)", color: "var(--cream)", padding: "12px 16px", marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>DRAWER TOTAL</span>
        <span className="display" style={{ fontSize: 26 }}>{money(countTotal())}</span>
      </div>
    </div>
  );

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
          <div style={{ marginTop: 14 }}><button className="btn" onClick={login}>UNLOCK</button></div>
          {loginError && <p className="err">{loginError}</p>}
        </div>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 780, margin: "0 auto", padding: "22px 14px 70px" }}>
      <style>{`
        #printzone { display:none; }
        @media print {
          body.receiptmode main > *:not(#printzone) { display:none !important; }
          body.receiptmode #printzone { display:block !important; }
        }
      `}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <span className="display" style={{ fontSize: 20 }}>THE MARKET AT NOBLE</span>
        {overview && (
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ash)" }}>
            Today: {money(overview.today.totalCents)} · {overview.today.count} sales
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}>
        {(["register", "reports", "bank", "floor", "vendors", "contracts", "settings"] as const).map((t) => (
          <button key={t} className={`btn small ${tab === t ? "" : "ghost"}`} onClick={() => { setTab(t); setReceipt(null); }}>
            {t === "register" ? "🛒 REGISTER" : t.toUpperCase()}
          </button>
        ))}
      </div>

      {tab === "register" && closeReport && (
        <div className="card">
          <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>DRAWER CLOSED — COUNT REPORT</h2>
          <table className="grid"><tbody>
            <tr><td>Employee</td><td style={{ textAlign: "right" }}>{closeReport.employee}</td></tr>
            <tr><td>Opening drawer</td><td style={{ textAlign: "right" }}>{money(closeReport.openTotalCents)}</td></tr>
            <tr><td>+ Cash sales this shift</td><td style={{ textAlign: "right" }}>{money(closeReport.cashSalesCents)}</td></tr>
            <tr><td style={{ fontWeight: 700 }}>EXPECTED IN DRAWER</td><td style={{ textAlign: "right", fontWeight: 700 }}>{money(closeReport.expected)}</td></tr>
            <tr><td>Counted at close</td><td style={{ textAlign: "right" }}>{money(closeReport.counted)}</td></tr>
            <tr><td style={{ fontWeight: 700 }}>{closeReport.diff === 0 ? "BALANCED ✓" : closeReport.diff > 0 ? "OVER" : "SHORT"}</td>
              <td style={{ textAlign: "right", fontWeight: 700, color: closeReport.diff === 0 ? "var(--green)" : "var(--red)" }}>
                {closeReport.diff === 0 ? "—" : money(Math.abs(closeReport.diff))}
              </td></tr>
          </tbody></table>
          <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 8 }}>This count is saved with the shift — over/shorts have a paper trail.</p>
          <div style={{ marginTop: 10 }}><button className="btn" onClick={() => setCloseReport(null)}>DONE</button></div>
        </div>
      )}

      {tab === "register" && !closeReport && drawerLoaded && !drawer && (
        <div className="card">
          <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>OPEN THE REGISTER</h2>
          <p style={{ fontSize: 13, color: "var(--ash)" }}>Locked until an employee signs in and counts the starting drawer.</p>
          {employees.length === 0 ? (
            <p className="err" style={{ marginTop: 10 }}>No employees yet — add yourself in SETTINGS first (name + PIN).</p>
          ) : (
            <>
              <label>Employee</label>
              <select value={empName || employees[0]?.name} onChange={(e) => setEmpName(e.target.value)}>
                {employees.map((e) => <option key={e.id}>{e.name}</option>)}
              </select>
              <label>PIN</label>
              <input type="password" inputMode="numeric" value={empPin} onChange={(e) => setEmpPin(e.target.value)} />
              <h2 className="display" style={{ fontSize: 15, margin: "16px 0 8px" }}>COUNT THE STARTING DRAWER</h2>
              {countForm}
              <div style={{ marginTop: 12 }}>
                <button className="btn" disabled={busy} onClick={openDrawer}>SIGN IN + OPEN DRAWER</button>
              </div>
              {drawerErr && <p className="err">{drawerErr}</p>}
            </>
          )}
        </div>
      )}

      {tab === "register" && !closeReport && drawer && closing && (
        <div className="card">
          <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>CLOSE THE DRAWER — COUNT WHAT&rsquo;S IN IT</h2>
          <p style={{ fontSize: 13, color: "var(--ash)" }}>
            {drawer.employee}&rsquo;s shift · opening {money(drawer.openTotalCents)} + cash sales {money(drawer.cashSalesCents)} → expected {money(drawer.openTotalCents + drawer.cashSalesCents)}
          </p>
          {countForm}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={closeDrawer}>FINISH COUNT + CLOSE</button>
            <button className="btn small ghost" onClick={() => { setClosing(false); setCounts({}); }}>BACK</button>
          </div>
          {drawerErr && <p className="err">{drawerErr}</p>}
        </div>
      )}

      {tab === "register" && !closeReport && drawer && !closing && receipt && (
        <div className="card" style={{ textAlign: "center" }}>
          <h2 className="display" style={{ fontSize: 22, color: "var(--green)" }}>SALE COMPLETE — #{receipt.number}</h2>
          <div style={{ textAlign: "left", maxWidth: 340, margin: "12px auto" }}>
            {receipt.lines.map((l) => (
              <div key={l.sku} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "4px 0" }}>
                <span>{l.quantity}× {l.name}</span><b>{money(l.priceCents * l.quantity)}</b>
              </div>
            ))}
            <div style={{ borderTop: "2px solid var(--ink)", marginTop: 6, paddingTop: 6, fontSize: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>Subtotal</span><b>{money(receipt.subtotalCents)}</b></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>Tax ({receipt.taxRate}%)</span><b>{money(receipt.taxCents)}</b></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18 }} className="display">
                <span>TOTAL ({receipt.paymentMethod}{receipt.cardName ? ` — ${receipt.cardName}` : ""})</span><span>{money(receipt.totalCents)}</span>
              </div>
            </div>
          </div>
          <p style={{ fontSize: 12, color: "var(--ash)" }}>
            Vendors notified, inventory updated.{autoPrint ? " Receipt sent to the printer." : ""}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10 }}>
            <button className="btn" onClick={() => setReceipt(null)}>NEXT CUSTOMER →</button>
            <button className="btn small ghost" onClick={() => printSale(receipt.id)}>REPRINT</button>
          </div>
        </div>
      )}

      {tab === "register" && !closeReport && drawer && !closing && !receipt && (
        <>
          <div style={{ display: "flex", gap: 0, border: "3px solid var(--ink)", borderRadius: 14, overflow: "hidden", marginBottom: 14, flexWrap: "wrap", background: "var(--cream)" }}>
            <div style={{ flex: "1 1 140px", padding: "10px 12px", borderRight: "2px solid var(--ink)" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700 }}>SIGNED IN</div>
              <div className="display" style={{ fontSize: 15 }}>{drawer.employee}</div>
            </div>
            <div style={{ flex: "1 1 160px", padding: "10px 12px", background: "var(--ink)", color: "var(--cream)" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700 }}>DRAWER NOW (start + cash)</div>
              <div className="display" style={{ fontSize: 20 }}>{money(drawer.openTotalCents + drawer.cashSalesCents)}</div>
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <button className="btn small ghost" onClick={() => { setClosing(true); setCounts({}); }}>CLOSE DRAWER (COUNT OUT)</button>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <label htmlFor="scan">Scan or type a code, then Enter</label>
            <input id="scan" ref={scanRef} value={scan} autoComplete="off"
              onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doScan()}
              placeholder="V01-0001" style={{ fontSize: 20, fontFamily: "monospace" }} />
            {scanErr && <p className="err">{scanErr}</p>}

            <label style={{ marginTop: 12 }}>No scanner? Search by item name or code</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="honey / V02 / cutting board" />
            {search.trim() && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
                {searchHits.map((i) => (
                  <button key={i.id} className="btn small ghost" onClick={() => addItemToCart({ id: i.id, sku: i.sku, name: i.name, priceCents: i.priceCents, vendorName: i.vendorName })}>
                    {i.sku} · {i.name} · {money(i.priceCents)}{i.quantity === 0 ? " · OUT" : ""}
                  </button>
                ))}
                {searchHits.length === 0 && <span style={{ fontSize: 13, color: "var(--ash)" }}>No matches.</span>}
              </div>
            )}

            <label style={{ marginTop: 12 }}>Or browse a vendor&rsquo;s whole line</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {[...new Map(floor.map((i) => [i.vendorCode, i.vendorName])).entries()].map(([code, name]) => (
                <button key={code} className={`btn small ${openVendor === code ? "" : "ghost"}`} onClick={() => setOpenVendor(openVendor === code ? null : code)}>
                  {code} {name}
                </button>
              ))}
            </div>
            {openVendor && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
                {floor.filter((i) => i.vendorCode === openVendor).map((i) => (
                  <button key={i.id} className="btn small ghost" onClick={() => addItemToCart({ id: i.id, sku: i.sku, name: i.name, priceCents: i.priceCents, vendorName: i.vendorName })}>
                    {i.name} · {money(i.priceCents)}{i.quantity === 0 ? " · OUT" : ""}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            {cart.length === 0 && <p style={{ color: "var(--ash)", fontSize: 14 }}>Ticket is empty — scan, search, or tap an item.</p>}
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
                <label>Customer name for CARD (the Stripe reader will fill this automatically in phase 2)</label>
                <input value={cardName} onChange={(e) => setCardName(e.target.value)} placeholder="J. Whitaker" />
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => completeSale("CASH")}>💵 CASH</button>
                  <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => completeSale("CARD")}>💳 CARD</button>
                </div>
                <button className="btn small ghost" style={{ marginTop: 10 }} onClick={() => setCart([])}>CLEAR TICKET</button>
              </>
            )}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <h2 className="display" style={{ fontSize: 16 }}>TICKETS — LAST 30 DAYS</h2>
              <button className="btn small ghost" onClick={toggleAutoPrint}>AUTO-PRINT: {autoPrint ? "ON" : "OFF"}</button>
            </div>
            <label>Search by receipt #, date, vendor, or card customer name</label>
            <input value={ticketQ} onChange={(e) => setTicketQ(e.target.value)} placeholder="1041 / Sep 8 / honey / Whitaker" />
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table className="grid">
                <thead><tr><th>#</th><th>Date</th><th>Pay</th><th>Vendors</th><th style={{ textAlign: "right" }}>Total</th><th></th></tr></thead>
                <tbody>
                  {tickets.map((t) => (
                    <tr key={t.id}>
                      <td style={{ fontWeight: 700 }}>{t.number}</td>
                      <td>{t.dateStr} {t.timeStr}</td>
                      <td>{t.paymentMethod}{t.cardName ? ` — ${t.cardName}` : ""}</td>
                      <td>{t.vendorCodes.join(" ")}</td>
                      <td style={{ textAlign: "right" }}>{money(t.totalCents)}</td>
                      <td><button className="btn small ghost" onClick={() => printSale(t.id)}>REPRINT</button></td>
                    </tr>
                  ))}
                  {tickets.length === 0 && <tr><td colSpan={6}>No tickets match.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === "reports" && (
        <div className="card">
          <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>SALES REPORTS</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
            {[["day", "TODAY"], ["week", "WEEK"], ["month", "MONTH"], ["quarter", "QUARTER"], ["year", "YEAR"], ["custom", "CUSTOM"]].map(([k, lbl]) => (
              <button key={k} className={`btn small ${repPeriod === k ? "" : "ghost"}`} onClick={() => setRepPeriod(k)}>{lbl}</button>
            ))}
          </div>
          {repPeriod === "custom" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span style={{ flex: 1, minWidth: 140 }}><label>From</label><input type="date" value={repFrom} onChange={(e) => setRepFrom(e.target.value)} /></span>
              <span style={{ flex: 1, minWidth: 140 }}><label>To</label><input type="date" value={repTo} onChange={(e) => setRepTo(e.target.value)} /></span>
            </div>
          )}
          <label>Scope</label>
          <select value={repVendor} onChange={(e) => setRepVendor(e.target.value)}>
            <option value="all">WHOLE SHOP</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.code} — {v.businessName}</option>)}
          </select>

          {report && (
            <div style={{ marginTop: 14 }}>
              {repVendor === "all" ? (
                <>
                  <table className="grid">
                    <tbody>
                      <tr><td>Gross sales (pre-tax)</td><td style={{ textAlign: "right" }}>{money(report.gross)}</td></tr>
                      <tr><td>Tickets</td><td style={{ textAlign: "right" }}>{report.tickets}</td></tr>
                      <tr><td>Cash taken (drawer + bank)</td><td style={{ textAlign: "right", fontWeight: 700 }}>{money(report.cash)}</td></tr>
                      <tr><td>Card taken</td><td style={{ textAlign: "right" }}>{money(report.card)}</td></tr>
                    </tbody>
                  </table>
                  <h3 className="display" style={{ fontSize: 15, margin: "14px 0 6px" }}>SALES TAX — WHAT YOU OWE FOR THIS PERIOD</h3>
                  <table className="grid">
                    <tbody>
                      <tr><td>Taxable sales</td><td style={{ textAlign: "right" }}>{money(report.gross)}</td></tr>
                      <tr><td style={{ fontWeight: 700 }}>TAX COLLECTED — REMIT TO OTC</td><td style={{ textAlign: "right", fontWeight: 700 }}>{money(report.tax)}</td></tr>
                    </tbody>
                  </table>
                  <h3 className="display" style={{ fontSize: 15, margin: "14px 0 6px" }}>BY VENDOR</h3>
                  <table className="grid">
                    <thead><tr><th>Vendor</th><th style={{ textAlign: "right" }}>Gross</th><th style={{ textAlign: "right" }}>Share</th></tr></thead>
                    <tbody>
                      {report.byVendor.map((r) => (
                        <tr key={r.vendor?.code}><td>{r.vendor?.code} {r.vendor?.businessName}</td>
                          <td style={{ textAlign: "right" }}>{money(r.cents)}</td>
                          <td style={{ textAlign: "right" }}>{report.vGross ? Math.round((r.cents / report.vGross) * 100) : 0}%</td></tr>
                      ))}
                      {report.byVendor.length === 0 && <tr><td colSpan={3}>No sales in this period.</td></tr>}
                    </tbody>
                  </table>
                </>
              ) : (
                <table className="grid">
                  <tbody>
                    <tr><td>Vendor gross</td><td style={{ textAlign: "right" }}>{money(report.vGross)}</td></tr>
                    <tr><td>Their net (after commission)</td><td style={{ textAlign: "right", fontWeight: 700 }}>{money(report.vNet)}</td></tr>
                    <tr><td>Units sold</td><td style={{ textAlign: "right" }}>{report.units}</td></tr>
                    <tr><td>Tickets containing their items</td><td style={{ textAlign: "right" }}>{report.tickets}</td></tr>
                  </tbody>
                </table>
              )}
              <h3 className="display" style={{ fontSize: 15, margin: "14px 0 6px" }}>BY ITEM</h3>
              <table className="grid">
                <thead><tr><th>Item</th><th style={{ textAlign: "right" }}>Units</th><th style={{ textAlign: "right" }}>Gross</th></tr></thead>
                <tbody>
                  {report.byItem.map((r) => (
                    <tr key={r.name}><td>{r.name}</td><td style={{ textAlign: "right" }}>{r.q}</td><td style={{ textAlign: "right" }}>{money(r.c)}</td></tr>
                  ))}
                  {report.byItem.length === 0 && <tr><td colSpan={3}>—</td></tr>}
                </tbody>
              </table>
              <h3 className="display" style={{ fontSize: 15, margin: "14px 0 6px" }}>BY HOUR</h3>
              <table className="grid">
                <thead><tr><th>Hour</th><th style={{ textAlign: "right" }}>Gross</th></tr></thead>
                <tbody>
                  {Array.from({ length: 14 }, (_, k) => k + 7).map((hh) => {
                    const c = report.byHour[String(hh)] || 0;
                    if (!c) return null;
                    const hr = ((hh + 11) % 12 + 1) + (hh >= 12 ? "P" : "A");
                    return <tr key={hh}><td>{hr}</td><td style={{ textAlign: "right" }}>{money(c)}</td></tr>;
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "bank" && (
        <div className="card">
          <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>HEADED TO THE BANK — STRIPE</h2>
          {!bank && <p style={{ color: "var(--ash)" }}>Loading…</p>}
          {bank && !bank.configured && (
            <p style={{ fontSize: 13, color: "var(--ash)" }}>
              Not connected yet — add <b>STRIPE_SECRET_KEY</b> (from your Daily Bread Stripe account) to this project&rsquo;s Vercel environment variables and redeploy. Once the Stripe card reader lands in phase 2, this tab shows exactly what&rsquo;s on its way to the bank.
            </p>
          )}
          {bank && bank.configured && bank.error && <p className="err">{bank.error}</p>}
          {bank && bank.configured && !bank.error && (
            <>
              <table className="grid">
                <tbody>
                  <tr><td style={{ fontWeight: 700 }}>ON ITS WAY (pending)</td><td style={{ textAlign: "right", fontWeight: 700 }}>{money(bank.pending || 0)}</td></tr>
                  <tr><td>Available for payout</td><td style={{ textAlign: "right" }}>{money(bank.available || 0)}</td></tr>
                </tbody>
              </table>
              <h3 className="display" style={{ fontSize: 15, margin: "14px 0 6px" }}>RECENT DEPOSITS</h3>
              <table className="grid">
                <thead><tr><th>Arrives</th><th>Status</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
                <tbody>
                  {(bank.payouts || []).map((p) => (
                    <tr key={p.id}>
                      <td>{new Date(p.arrival).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
                      <td>{p.status.toUpperCase()}</td>
                      <td style={{ textAlign: "right" }}>{money(p.amount)}</td>
                    </tr>
                  ))}
                  {(!bank.payouts || bank.payouts.length === 0) && <tr><td colSpan={3}>No payouts yet.</td></tr>}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 8 }}>
                Heads up: this reads the shared Stripe account, so until the market gets its own card reader these numbers include Daily Bread&rsquo;s card money too.
              </p>
            </>
          )}
        </div>
      )}

      {tab === "floor" && overview && (
        <div className="card">
          <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>EVERYTHING ON THE FLOOR</h2>
          <div style={{ overflowX: "auto" }}>
            <table className="grid">
              <thead><tr><th>Vendor</th><th>Item</th><th>Code</th><th style={{ textAlign: "right" }}>Price</th><th style={{ textAlign: "right" }}>Qty</th></tr></thead>
              <tbody>
                {overview.floor.map((i) => (
                  <tr key={i.id} style={i.quantity === 0 ? { opacity: 0.45 } : undefined}>
                    <td>{i.vendorCode} {i.vendorName}</td>
                    <td style={{ fontWeight: 700 }}>{i.name}</td>
                    <td style={{ fontFamily: "monospace" }}>{i.sku}</td>
                    <td style={{ textAlign: "right" }}>{money(i.priceCents)}</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{i.quantity}</td>
                  </tr>
                ))}
                {overview.floor.length === 0 && <tr><td colSpan={5}>Nothing yet — vendors add items from their portal.</td></tr>}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 10 }}>
            This month: {money(overview.month.totalCents)} across {overview.month.count} sales · tax collected: <b>{money(overview.month.taxCents)}</b>
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
                      <button className="btn small ghost" disabled={busy} onClick={() => patchVendor(v.id, { active: !v.active })}>
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
            <label>Commission % (0 for none — change anytime)</label>
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
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>BOOTH CONTRACTS</h2>
            <p style={{ fontSize: 12, color: "var(--ash)", marginBottom: 8 }}>
              Rent auto-charges on the 1st of every month at midnight — first and final months prorate by day. Nothing for you to remember.
            </p>
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
                          <button className="btn small ghost" disabled={busy} onClick={() => giveNotice(c)}>ENTER 30-DAY NOTICE</button>
                        </>
                      )}
                      {c.status === "TERMINATING" && (
                        <button className="btn small ghost" disabled={busy} onClick={() => finalStatement(c)}>FINAL STATEMENT</button>
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
            <label>Lease start date (first month prorates from this day)</label>
            <input value={cStart} onChange={(e) => setCStart(e.target.value)} type="date" />
            <div style={{ marginTop: 14 }}>
              <button className="btn" disabled={busy} onClick={addContract}>CREATE CONTRACT</button>
            </div>
            {cMsg && <p className={cMsg.includes("created") ? "ok" : "err"}>{cMsg}</p>}
          </div>
        </>
      )}

      {tab === "settings" && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>SALES TAX</h2>
            <label>Rate (%) — combined state + county + city for Noble</label>
            <input type="number" min="0" max="15" step="0.125" value={taxRate} onChange={(e) => setTaxRate(Number(e.target.value))} />
            <div style={{ marginTop: 14 }}><button className="btn small" onClick={saveTax}>SAVE</button></div>
            {settingsMsg && <p className={settingsMsg.includes("✓") ? "ok" : "err"}>{settingsMsg}</p>}
            <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 12 }}>
              Verify Noble&rsquo;s current combined rate with the Oklahoma Tax Commission before opening day.
            </p>
          </div>

          <div className="card">
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>REGISTER EMPLOYEES</h2>
            <p style={{ fontSize: 12, color: "var(--ash)" }}>Anyone who can sign in and open/close the cash drawer.</p>
            <ul style={{ listStyle: "none", margin: "10px 0" }}>
              {employees.map((e) => (
                <li key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px dashed var(--ink)" }}>
                  <b>{e.name}</b>
                  <button className="btn small ghost" onClick={() => removeEmployee(e)}>REMOVE</button>
                </li>
              ))}
              {employees.length === 0 && <li style={{ color: "var(--ash)", fontSize: 13 }}>None yet — add yourself first.</li>}
            </ul>
            <label>Name</label>
            <input value={newEmpName} onChange={(e) => setNewEmpName(e.target.value)} placeholder="Kalie" />
            <label>PIN (4–6 digits)</label>
            <input value={newEmpPin} onChange={(e) => setNewEmpPin(e.target.value)} inputMode="numeric" />
            <div style={{ marginTop: 12 }}><button className="btn small" onClick={addEmployee}>ADD / UPDATE EMPLOYEE</button></div>
            {empMsg && <p className={empMsg.includes("✓") ? "ok" : "err"}>{empMsg}</p>}
          </div>
        </>
      )}

      <div id="printzone" ref={printRef}></div>
    </main>
  );
}

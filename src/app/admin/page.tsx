"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Vendor = { id: string; code: string; businessName: string; contactName: string; email: string; phone: string; commissionPercent: number; active: boolean; allowSelfCheckout: boolean; balance: number };
type FloorItem = { id: string; sku: string; name: string; priceCents: number; quantity: number; vendorName: string; vendorCode: string };
type Overview = { today: { count: number; totalCents: number; taxCents: number }; month: { count: number; totalCents: number; taxCents: number }; vendors: number; floor: FloorItem[] };
type CartLine = { itemId: string; sku: string; name: string; vendorName: string; priceCents: number; quantity: number };
type Contract = { id: string; vendorId: string; boothLabel: string; monthlyRentCents: number; startDate: string; status: string; noticeGivenAt: string | null; endDate: string | null; vendorSignedAt: string | null; marketSignedAt: string | null; vendor: { businessName: string; code: string } };
type Receipt = { id: string; number: number; employee: string; cardName: string; createdAt: string; subtotalCents: number; taxCents: number; totalCents: number; taxRate: number; paymentMethod: string; lines: CartLine[]; discountCents?: number; cardAdjustCents?: number; customerPoints?: number | null; customerContact?: string;
};
type Drawer = { id: string; employee: string; openedAt: string; openTotalCents: number; cashSalesCents: number } | null;
type Ticket = { id: string; number: number; dateStr: string; timeStr: string; status: string; paymentMethod: string; cardName: string; employee: string; totalCents: number; vendorCodes: string[] };
type Employee = { id: string; name: string };
type W4 = { filingStatus?: string; dependentsDollars?: string; otherIncomeDollars?: string; extraWithholdingDollars?: string; notes?: string };
type TeamMember = { id: string; name: string; payRateCents: number; w4: W4; deductions: { id: string; name: string; amountCents: number }[]; docs: { id: string; kind: string; filename: string; createdAt: string }[] };
type PayrollRow = { id: string; name: string; payRateCents: number; hours: number; grossCents: number; dedCents: number; netCents: number; deductions: { name: string; amountCents: number }[]; openEntries: number };
type Report = {
  start: string; end: string; gross: number; tax: number; cash: number; card: number; tickets: number; refundTotal?: number;
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
  const [role, setRole] = useState<"admin" | "staff" | null>(null);
  const [staffName, setStaffName] = useState("");
  const [loginMode, setLoginMode] = useState<"staff" | "admin">("staff");
  const [password, setPassword] = useState("");
  const [loginName, setLoginName] = useState("");
  const [loginPin, setLoginPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [timeData, setTimeData] = useState<{ open: { id: string; clockIn: string } | null; entries: { id: string; dayStr: string; inStr: string; outStr: string | null; hours: number | null }[] } | null>(null);
  const [timeMsg, setTimeMsg] = useState("");
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [payFrom, setPayFrom] = useState("");
  const [payTo, setPayTo] = useState("");
  const [payroll, setPayroll] = useState<PayrollRow[] | null>(null);
  const [teamMsg, setTeamMsg] = useState("");
  const [applications, setApplications] = useState<{ id: string; status: string; businessName: string; contactName: string; email: string; phone: string; category: string; products: string; madeByYou: string; links: string; licenses: string; insurance: string; availability: string; boothRequest: string; heardFrom: string; phoneType?: string; notes: string; createdAt: string }[]>([]);
  const [appOpen, setAppOpen] = useState<string | null>(null);
  const [complaints, setComplaints] = useState<{ id: string; status: string; customerName: string; email: string; phone: string; vendor: { code: string; businessName: string } | null; messages: { sender: string; body: string }[] }[]>([]);
  const [punchName, setPunchName] = useState("");
  const [punchPin, setPunchPin] = useState("");
  const [punchMsg, setPunchMsg] = useState("");
  const [refundTarget, setRefundTarget] = useState<{ ticket: Ticket; lines: { id: string; name: string; priceCents: number; quantity: number }[]; refunded: Record<string, number> } | null>(null);
  const [refundQty, setRefundQty] = useState<Record<string, number>>({});
  const [refundRestock, setRefundRestock] = useState(true);
  const [refundMsg, setRefundMsg] = useState("");
  const [tab, setTab] = useState<"register" | "time" | "reports" | "bank" | "floor" | "vendors" | "customers" | "contracts" | "tents" | "team" | "links" | "settings">("register");
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
  const [cW, setCW] = useState("5"); const [cD, setCD] = useState("5");
  const [cMode, setCMode] = useState<"standard" | "custom">("standard");
  const [rentPerSqft, setRentPerSqft] = useState(6);
  const [scPaused, setScPaused] = useState(false);
  const [cardAdj, setCardAdj] = useState("0");
  const [rateMsg, setRateMsg] = useState("");
  const [adminPushDevices, setAdminPushDevices] = useState<number | null>(null);
  const [adminPushKey, setAdminPushKey] = useState("");
  const [adminPushMsg, setAdminPushMsg] = useState("");
  const [cMsg, setCMsg] = useState("");

  // settings
  const [settingsMsg, setSettingsMsg] = useState("");
  const [banEnabled, setBanEnabled] = useState(false);
  const [banTitle, setBanTitle] = useState("");
  const [banDate, setBanDate] = useState("");
  const [banMessage, setBanMessage] = useState("");
  const [banMsg, setBanMsg] = useState("");
  const [newEmpName, setNewEmpName] = useState("");
  const [newEmpPin, setNewEmpPin] = useState("");
  const [empMsg, setEmpMsg] = useState("");

  const safeFetch = async (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> => {
    try {
      const res = await fetch(url, init);
      let data: Record<string, unknown> = {};
      try { data = await res.json(); } catch { data = { error: `Server error (${res.status}). If you just deployed, check that all the SQL ran in Supabase.` }; }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: "Network problem — try again." } };
    }
  };

  const loadDrawer = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/drawer");
      if (res.status === 401) { setAuthed(false); return; }
      setAuthed(true);
      let data: { session?: Drawer; error?: string } = {};
      try { data = await res.json(); } catch { data = { error: "Server error." }; }
      if (!res.ok) {
        setDrawerErr(`Register can't reach the drawer system (${data.error || res.status}). If you just deployed, make sure the SQL for Employee + DrawerSession ran in Supabase.`);
      } else {
        setDrawerErr("");
        setDrawer(data.session ?? null);
      }
    } catch {
      setDrawerErr("Network problem loading the register — refresh to retry.");
    } finally {
      setDrawerLoaded(true);
    }
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
    // 401s here are normal for employee sessions — those tabs are admin-only
    if (v.ok) setVendors((await v.json()).vendors || []);
    if (c.ok) setContracts((await c.json()).contracts || []);
    if (s.ok) { const sd = await s.json(); setTaxRate(sd.taxRatePercent); if (sd.rentPerSqft) setRentPerSqft(sd.rentPerSqft); setScPaused(!!sd.selfCheckoutPaused); if (sd.cardAdjustPercent !== undefined) setCardAdj(String(sd.cardAdjustPercent)); }
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

  const probeRole = useCallback(async () => {
    const res = await fetch("/api/admin/whoami");
    if (!res.ok) { setAuthed(false); setRole(null); return; }
    const data = await res.json();
    setRole(data.role); setStaffName(data.name || ""); setAuthed(true);
  }, []);

  const loadTime = useCallback(async () => {
    const res = await fetch("/api/staff/time");
    if (res.ok) setTimeData(await res.json());
  }, []);

  const loadTeam = useCallback(async () => {
    const t = await fetch("/api/admin/team");
    if (t.ok) setTeam((await t.json()).employees || []);
  }, []);

  useEffect(() => { probeRole(); loadDrawer(); loadAll(); }, [probeRole, loadDrawer, loadAll]);
  useEffect(() => { if (authed && tab === "time") loadTime(); }, [authed, tab, loadTime]);
  useEffect(() => { if (authed && role === "admin" && tab === "team") loadTeam(); }, [authed, role, tab, loadTeam]);
  useEffect(() => {
    if (authed && role === "admin" && tab === "vendors") {
      fetch("/api/admin/complaints").then(async (r) => { if (r.ok) setComplaints((await r.json()).complaints || []); });
      fetch("/api/admin/applications").then(async (r) => { if (r.ok) setApplications((await r.json()).applications || []); });
    }
  }, [authed, role, tab]);
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
    if (loginMode === "admin") {
      const res = await fetch("/api/admin/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) { setLoginError("Wrong password."); return; }
    } else {
      const res = await fetch("/api/staff/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: loginName, pin: loginPin }),
      });
      if (!res.ok) { setLoginError("Wrong name or PIN."); return; }
    }
    await probeRole(); await loadDrawer(); await loadAll();
  };

  const staffLogout = async () => {
    await fetch("/api/staff/login", { method: "DELETE" });
    window.location.reload();
  };

  const clock = async (action: "in" | "out") => {
    setTimeMsg("");
    const { ok, data } = await safeFetch("/api/staff/time", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!ok) { setTimeMsg(String(data.error || "Failed.")); return; }
    await loadTime();
  };

  const patchTeam = async (body: object) => {
    setTeamMsg("");
    const { ok, data } = await safeFetch("/api/admin/team", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!ok) { setTeamMsg(String(data.error || "Failed.")); return; }
    await loadTeam();
  };

  const addDeduction = async (employeeId: string) => {
    const name = prompt("Deduction name (e.g. Health insurance, Advance repayment):");
    if (name === null || !name.trim()) return;
    const amt = prompt("Amount per pay period (dollars):");
    if (amt === null) return;
    const { ok, data } = await safeFetch("/api/admin/team", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeId, name, amountDollars: amt }),
    });
    if (!ok) { setTeamMsg(String(data.error || "Failed.")); return; }
    await loadTeam();
  };

  const dropDeduction = async (id: string) => {
    if (!confirm("Remove this deduction going forward?")) return;
    await safeFetch(`/api/admin/team?id=${id}`, { method: "DELETE" });
    await loadTeam();
  };

  const uploadDoc = async (employeeId: string, kind: string, file: File) => {
    setTeamMsg("");
    if (file.size > 5 * 1024 * 1024) { setTeamMsg("File too big — 5 MB max."); return; }
    const dataB64: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(file);
    });
    const { ok, data } = await safeFetch("/api/admin/team/docs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeId, kind, filename: file.name, mime: file.type, dataB64 }),
    });
    if (!ok) { setTeamMsg(String(data.error || "Upload failed.")); return; }
    await loadTeam();
  };

  const dropDoc = async (id: string) => {
    if (!confirm("Delete this document?")) return;
    await safeFetch(`/api/admin/team/docs/${id}`, { method: "DELETE" });
    await loadTeam();
  };

  type TentD = { id: string; date: string; capacity: number; open: boolean; bookings: { id: string; name: string; businessName: string; email: string; phone: string; status: string }[] };
  const [tentDates, setTentDates] = useState<TentD[]>([]);
  const [tentFrom, setTentFrom] = useState("");
  const [tentTo, setTentTo] = useState("");
  const [tentCap, setTentCap] = useState("4");
  const [tentDows, setTentDows] = useState<number[]>([5, 6]); // Fri, Sat default
  const [tentMsg, setTentMsg] = useState("");
  const [tentPaused, setTentPaused] = useState(false);
  const [tentPauseMsg, setTentPauseMsg] = useState("");

  const loadTents = useCallback(async () => {
    const r = await fetch("/api/admin/tents");
    if (r.ok) {
      const d = await r.json();
      setTentDates(d.dates || []);
      if (d.pause) { setTentPaused(!!d.pause.paused); setTentPauseMsg(d.pause.message || ""); }
    }
  }, []);
  useEffect(() => { if (authed && role === "admin" && tab === "tents") loadTents(); }, [authed, role, tab, loadTents]);

  const tentAct = async (body: Record<string, unknown>, confirmMsg?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setTentMsg("");
    const { ok, data } = await safeFetch("/api/admin/tents", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!ok) { setTentMsg(String(data.error || "Failed.")); return; }
    await loadTents();
  };

  const openTentRange = async () => {
    if (!tentFrom || !tentTo) { setTentMsg("Pick a from and to date."); return; }
    const out: string[] = [];
    const d = new Date(tentFrom + "T12:00:00"), end = new Date(tentTo + "T12:00:00");
    while (d <= end && out.length < 62) {
      if (tentDows.includes(d.getDay())) out.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    if (out.length === 0) { setTentMsg("No days matched — check the weekday boxes."); return; }
    await tentAct({ action: "openDates", dates: out, capacity: Number(tentCap) || 4 });
    setTentMsg(`Opened ${out.length} date${out.length === 1 ? "" : "s"}. ✓`);
  };

  const decideApplication = async (id: string, action: "accept" | "decline") => {
    let reason = "";
    if (action === "decline") {
      const r = prompt("Optional note for the decline email (leave blank for the standard message):", "");
      if (r === null) return;
      reason = r;
    } else if (!confirm("Accept this application? They'll get the 'welcome — someone will be calling you' email.")) return;
    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/applications/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      if (!ok) { alert(String(data.error || "Failed.")); return; }
      const r2 = await fetch("/api/admin/applications");
      if (r2.ok) setApplications((await r2.json()).applications || []);
    } finally { setBusy(false); }
  };

  const punch = async () => {
    setPunchMsg("");
    const { ok, data } = await safeFetch("/api/staff/punch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: punchName || employees[0]?.name, pin: punchPin }),
    });
    setPunchPin("");
    if (!ok) { setPunchMsg(String(data.error || "Failed.")); return; }
    setPunchMsg(String(data.msg));
  };

  const openRefund = async (t: Ticket) => {
    setRefundMsg("");
    const { ok, data } = await safeFetch(`/api/admin/tickets/${t.id}`);
    if (!ok) { setScanErr(String(data.error || "Couldn't load ticket.")); return; }
    const sale = data.sale as { lines: { id: string; name: string; priceCents: number; quantity: number }[] };
    setRefundTarget({ ticket: t, lines: sale.lines, refunded: (data.refunded as Record<string, number>) || {} });
    setRefundQty({});
    setRefundRestock(true);
  };

  const voidSale = async (t: Ticket) => {
    if (!confirm(`VOID ticket #${t.number} entirely? Items go back on the floor, vendor credits reverse, and it drops out of every report.${t.paymentMethod === "CASH" ? ` Hand back ${money(t.totalCents)} cash.` : " Reverse the card charge on your card machine."}`)) return;
    const { ok, data } = await safeFetch("/api/admin/refund", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ saleId: t.id, action: "void" }),
    });
    if (!ok) { alert(String(data.error || "Void failed.")); return; }
    await loadTickets(ticketQ); await loadDrawer(); await loadAll();
  };

  const submitRefund = async () => {
    if (!refundTarget) return;
    setRefundMsg("");
    const lines = Object.entries(refundQty).filter(([, q]) => q > 0).map(([lineId, quantity]) => ({ lineId, quantity }));
    if (!lines.length) { setRefundMsg("Set a quantity on at least one item."); return; }
    const { ok, data } = await safeFetch("/api/admin/refund", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ saleId: refundTarget.ticket.id, action: "refund", lines, restock: refundRestock }),
    });
    if (!ok) { setRefundMsg(String(data.error || "Refund failed.")); return; }
    const back = Number(data.refundCents) || 0;
    const method = refundTarget.ticket.paymentMethod;
    setRefundTarget(null);
    alert(`Refund recorded: ${money(back)}. ${method === "CASH" ? "Hand that back from the drawer." : "Reverse it on your card machine — this system only records it."}`);
    await loadTickets(ticketQ); await loadDrawer(); await loadAll();
  };

  const runPayroll = async () => {
    setTeamMsg("");
    if (!payFrom || !payTo) { setTeamMsg("Pick both dates first."); return; }
    const { ok, data } = await safeFetch(`/api/admin/payroll?from=${payFrom}&to=${payTo}`);
    if (!ok) { setTeamMsg(String(data.error || "Failed.")); return; }
    setPayroll(data.rows as PayrollRow[]);
  };

  // ---------- drawer ----------
  const countTotal = () => DENOMS.reduce((t, [k, , cents]) => t + Math.max(0, Math.round(Number(counts[k]) || 0)) * cents, 0);

  const openDrawer = async () => {
    setDrawerErr("");
    setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/drawer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee: empName || employees[0]?.name, pin: empPin, counts, totalCents: countTotal() }),
      });
      if (!ok) { setDrawerErr(String(data.error || "Couldn't open.")); return; }
      setCounts({}); setEmpPin("");
      await loadDrawer();
    } finally { setBusy(false); }
  };

  const closeDrawer = async () => {
    setBusy(true);
    let res: { ok: boolean; data: Record<string, unknown> };
    try { res = await safeFetch("/api/admin/drawer", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ counts, countedCents: countTotal() }),
    }); } finally { setBusy(false); }
    const data = res.data as { session?: { employee: string; openTotalCents: number; cashSalesCents: number; countedCents: number; diffCents: number }; expected?: number; error?: string };
    if (!res.ok || !data.session) { setDrawerErr(String(data.error || "Couldn't close.")); return; }
    setCloseReport({
      employee: data.session.employee,
      openTotalCents: data.session.openTotalCents,
      cashSalesCents: data.session.cashSalesCents,
      expected: data.expected || 0,
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
        <img src="/logo.png" alt="" style="width:70px;height:70px" />
        <img src="/logo.png" alt="Community Harvest" style="width:100%;max-width:260px;display:block;margin:0 auto 2px" />
        <div>Noble, Oklahoma</div>
        <div style="margin:6px 0;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:4px 0">
          RECEIPT #${sale.number}<br>${new Date(sale.createdAt).toLocaleDateString("en-US")} ${new Date(sale.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}${sale.employee ? "<br>CLERK: " + sale.employee : ""}
        </div>
        <div style="text-align:left">
          ${sale.lines.map((l: { quantity: number; name: string; priceCents: number }) => `<div style="display:flex;justify-content:space-between"><span>${l.quantity}x ${l.name.slice(0, 26)}</span><span>${money(l.priceCents * l.quantity)}</span></div>`).join("")}
        </div>
        <div style="border-top:1px dashed #000;margin-top:4px;padding-top:4px;text-align:left">
          <div style="display:flex;justify-content:space-between"><span>SUBTOTAL</span><span>${money(sale.subtotalCents)}</span></div>
          ${sale.cardAdjustCents ? `<div style="display:flex;justify-content:space-between"><span>NON-CASH ADJ</span><span>${money(sale.cardAdjustCents)}</span></div>` : ""}
          <div style="display:flex;justify-content:space-between"><span>TAX</span><span>${money(sale.taxCents)}</span></div>
          ${sale.discountCents ? `<div style="display:flex;justify-content:space-between"><span>REWARDS</span><span>-${money(sale.discountCents)}</span></div>` : ""}
          <div style="display:flex;justify-content:space-between;font-weight:700;font-size:14px"><span>TOTAL</span><span>${money(sale.totalCents)}</span></div>
          <div>${sale.paymentMethod}${sale.cardName ? " - " + sale.cardName : ""}</div>
        </div>
        <div style="margin-top:8px">THANK YOU!<br>homegrown + homemade</div>
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

  const [customers, setCustomers] = useState<{ id: string; email: string; phone: string; points: number; unsubscribed: boolean; follows: number; createdAt: string; saleCount: number; spentCents: number }[]>([]);
  const [custQ, setCustQ] = useState("");
  const [cust, setCust] = useState<{ id: string; email: string; phone: string; points: number } | null>(null);
  const [redeem, setRedeem] = useState(false);
  const [custMsg, setCustMsg] = useState("");
  const [attachQ, setAttachQ] = useState("");
  const [attachMsg, setAttachMsg] = useState("");

  const attachCustomer = async () => {
    if (!receipt || !attachQ.trim()) return;
    setAttachMsg("");
    const r = await fetch("/api/admin/sale/attach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ saleId: receipt.id, contact: attachQ.trim() }) });
    const d = await r.json();
    if (!r.ok) { setAttachMsg(d.error || "Couldn't add."); return; }
    setAttachMsg(`⭐ ${d.points} points · ${d.contact}${d.contact.includes("@") ? " · receipt emailed" : ""}`);
  };

  const lookupCust = async () => {
    setCustMsg("");
    if (!custQ.trim()) { setCust(null); return; }
    const r = await fetch(`/api/admin/customer?q=${encodeURIComponent(custQ.trim())}`);
    const d = await r.json();
    if (r.ok && d.customer) { setCust(d.customer); }
    else { setCust(null); setCustMsg("New customer — they'll be enrolled with this sale. \u2b50"); }
  };

  const completeSale = async (paymentMethod: "CASH" | "CARD") => {
    if (!cart.length) return;
    setBusy(true);
    let ok = false; let data: Record<string, unknown> = {};
    try { ({ ok, data } = await safeFetch("/api/admin/sale", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentMethod, cardName, lines: cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity , customerContact: custQ.trim(), redeem })) }),
    })); } finally { setBusy(false); }
    if (!ok) { setScanErr(String(data.error || "Sale failed.")); return; }
    setReceipt({ ...(data.sale as Receipt), paymentMethod, lines: cart });
    setCart([]); setCardName("");
    loadDrawer(); loadAll(); loadTickets(ticketQ);
    if (autoPrint) setTimeout(() => printSale((data.sale as { id: string }).id), 250);
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
    try {
      const { ok, data } = await safeFetch("/api/admin/vendors", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessName: vName, contactName: vContact, email: vEmail, phone: vPhone, commissionPercent: vComm }),
      });
      if (!ok) { setVMsg(String(data.error || "Couldn't add vendor.")); return; }
      const v = data.vendor as { businessName: string; code: string };
      setVMsg(`Added ${v.businessName} (${v.code}). Temp password: ${String(data.tempPassword)} — also emailed to them.`);
      setVName(""); setVContact(""); setVEmail(""); setVPhone(""); setVComm("0");
      await loadAll();
    } finally { setBusy(false); }
  };

  const patchVendor = async (id: string, body: object) => {
    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/vendors/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!ok) { alert(String(data.error || "Update failed.")); return; }
      if (data.tempPassword) alert(`New temp password for ${(data.vendor as { businessName: string }).businessName}: ${String(data.tempPassword)}`);
      await loadAll();
    } finally { setBusy(false); }
  };

  const ledgerEntry = async (v: Vendor, type: "RENT" | "PAYOUT" | "ADJUST") => {
    const label = type === "RENT" ? "Rent amount to charge" : type === "PAYOUT" ? "Payout amount you're paying them" : "Adjustment (minus sign to subtract)";
    const raw = prompt(`${label} for ${v.businessName} (dollars):`, type === "PAYOUT" ? String(Math.max(0, v.balance) / 100) : "");
    if (raw === null) return;
    const note = prompt("Note (shows on their statement):", type === "RENT" ? "Booth rent" : type === "PAYOUT" ? "Payout" : "") || "";
    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/vendors/${v.id}/ledger`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, amountDollars: raw, note }),
      });
      if (!ok) { alert(String(data.error || "Failed.")); return; }
      await loadAll();
    } finally { setBusy(false); }
  };

  // ---------- contracts ----------
  const addContract = async () => {
    setCMsg(""); setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/contracts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId: cVendor, boothLabel: cBooth, monthlyRentDollars: cRent, startDate: cStart }),
      });
      if (!ok) { setCMsg(String(data.error || "Couldn't create it.")); return; }
      setCMsg(`Contract created. First month prorated: ${money(Number(data.firstMonthCents) || 0)} — posted to their balance. Full rent auto-charges every 1st after that.`);
      setCBooth(""); setCStart("");
      await loadAll();
    } finally { setBusy(false); }
  };

  const giveNotice = async (c: Contract) => {
    const d = prompt("Date the 30-day notice was given (YYYY-MM-DD):", new Date().toISOString().slice(0, 10));
    if (d === null) return;
    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/contracts/${c.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "give_notice", noticeDate: d }),
      });
      if (!ok) { alert(String(data.error || "Failed.")); return; }
      alert(`Notice recorded. Lease ends ${new Date((data.contract as { endDate: string }).endDate).toLocaleDateString()}. Final month rent prorates to ${money(Number(data.finalRentCents) || 0)}.`);
      await loadAll();
    } finally { setBusy(false); }
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
    try {
      await safeFetch(`/api/admin/contracts/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await loadAll();
    } finally { setBusy(false); }
  };

  // ---------- settings ----------
  useEffect(() => {
    if (!authed || role !== "admin") return;
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    fetch("/api/admin/push").then(async (r) => {
      if (r.ok) { const d = await r.json(); setAdminPushDevices(d.devices); setAdminPushKey(d.publicKey); }
    }).catch(() => {});
  }, [authed, role]);

  const enableAdminPush = async () => {
    setAdminPushMsg("");
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        setAdminPushMsg("This browser can't do notifications. On iPhone: share button → Add to Home Screen (the admin app), open from that icon, then try again.");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setAdminPushMsg("Notifications were blocked — allow them in browser settings and try again."); return; }
      const reg = await navigator.serviceWorker.ready;
      const b64 = adminPushKey.replace(/-/g, "+").replace(/_/g, "/");
      const pad = "=".repeat((4 - (b64.length % 4)) % 4);
      const raw = atob(b64 + pad);
      const key = new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const res = await fetch("/api/admin/push", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) { setAdminPushMsg("Couldn't save — try again."); return; }
      setAdminPushDevices((n) => (n || 0) + 1);
      setAdminPushMsg("Admin alerts ON for this device. ✓");
    } catch {
      setAdminPushMsg("Couldn't turn on notifications here. iPhone: iOS 16.4+ AND opened from a home-screen icon.");
    }
  };

  const loadBanner = useCallback(async () => {
    const r = await fetch("/api/public/banner");
    if (r.ok) {
      const b = (await r.json()).banner;
      setBanEnabled(!!b.enabled); setBanTitle(b.title || ""); setBanDate(b.dateLine || ""); setBanMessage(b.message || "");
    }
  }, []);
  useEffect(() => { if (authed && role === "admin" && tab === "settings") loadBanner(); }, [authed, role, tab, loadBanner]);

  const saveBanner = async () => {
    setBanMsg("");
    const { ok, data } = await safeFetch("/api/admin/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ banner: { enabled: banEnabled, title: banTitle, dateLine: banDate, message: banMessage } }),
    });
    setBanMsg(ok ? "Saved — live on /apply and /market. ✓" : String(data.error || "Failed."));
  };

  const sqft = Math.max(0, (Number(cW) || 0) * (Number(cD) || 0));
  const suggestedRent = Math.round(sqft * rentPerSqft * 100) / 100;

  const saveRate = async () => {
    setRateMsg("");
    const { ok, data } = await safeFetch("/api/admin/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rentPerSqft }),
    });
    setRateMsg(ok ? "Saved. ✓" : String(data.error || "Failed."));
  };

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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Community Harvest" style={{ width: 130, height: 130, marginBottom: 10 }} />
{/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/wordmark.png" alt="Community Harvest" style={{ width: 210, maxWidth: "70%", height: "auto", margin: "2px auto 2px", display: "block" }} />
          <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: "0.08em" }}>FOOD AND CRAFT MARKET</div>
          <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ash)", marginTop: 2 }}>Register &amp; Management</div>
        </div>
        <div className="card">
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <button className={`btn small ${loginMode === "staff" ? "" : "ghost"}`} onClick={() => setLoginMode("staff")}>EMPLOYEE</button>
            <button className={`btn small ${loginMode === "admin" ? "" : "ghost"}`} onClick={() => setLoginMode("admin")}>ADMIN</button>
          </div>
          {loginMode === "admin" ? (
            <>
              <label htmlFor="pw">Admin password</label>
              <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && login()} />
            </>
          ) : (
            <>
              <label>Your name (exactly as the admin added you)</label>
              <input value={loginName} onChange={(e) => setLoginName(e.target.value)} />
              <label>PIN</label>
              <input type="password" inputMode="numeric" value={loginPin} onChange={(e) => setLoginPin(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && login()} />
            </>
          )}
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
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 40, height: 40 }} />
{/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wordmark.png" alt="Community Harvest" style={{ width: 150, height: "auto", display: "block" }} />
        </span>
        {overview && (
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ash)" }}>
            Today: {money(overview.today.totalCents)} · {overview.today.count} sales
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}>
        {(role === "admin"
          ? (["register", "time", "reports", "bank", "floor", "vendors", "customers", "contracts", "tents", "team", "links", "settings"] as const)
          : (["register", "time", "floor"] as const)
        ).map((t) => (
          <button key={t} className={`btn small ${tab === t ? "" : "ghost"}`} onClick={() => { setTab(t); setReceipt(null); }}>
            {t === "register" ? "🛒 REGISTER" : t === "time" ? "⏱ TIME" : t === "customers" ? "⭐ CUSTOMERS" : t.toUpperCase()}
          </button>
        ))}
        {role === "staff" && (
          <button className="btn small ghost" style={{ marginLeft: "auto" }} onClick={staffLogout}>
            {staffName ? staffName.toUpperCase() + " · " : ""}SIGN OUT
          </button>
        )}
      </div>

      {tab === "register" && !drawer && drawerErr && (
        <div className="card" style={{ marginBottom: 14 }}><p className="err" style={{ marginTop: 0 }}>{drawerErr}</p></div>
      )}
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
            <div style={{ borderTop: "2px solid var(--border)", marginTop: 6, paddingTop: 6, fontSize: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>Subtotal</span><b>{money(receipt.subtotalCents)}</b></div>
              {typeof receipt.cardAdjustCents === "number" && receipt.cardAdjustCents > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between" }}><span>Non-cash adjustment</span><b>{money(receipt.cardAdjustCents)}</b></div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>Tax ({receipt.taxRate}%)</span><b>{money(receipt.taxCents)}</b></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18 }} className="display">
                <span>TOTAL ({receipt.paymentMethod}{receipt.cardName ? ` — ${receipt.cardName}` : ""})</span><span>{money(receipt.totalCents)}</span>
              </div>
            </div>
          </div>
          {typeof receipt.discountCents === "number" && receipt.discountCents > 0 && (
            <p style={{ fontSize: 13, color: "var(--green)", fontWeight: 700 }}>⭐ $5 reward applied</p>
          )}
          {receipt.customerContact ? (
            <p style={{ fontSize: 13, color: "var(--green)", fontWeight: 700 }}>⭐ {receipt.customerPoints} points · {receipt.customerContact}{receipt.customerContact.includes("@") ? " · receipt emailed" : ""}</p>
          ) : (
            <div style={{ maxWidth: 340, margin: "8px auto" }}>
              <div style={{ display: "flex", gap: 6 }}>
                <input placeholder="Email or phone for receipt & rewards" value={attachQ} onChange={(e) => setAttachQ(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && attachCustomer()} />
                <button className="btn small" style={{ flex: "0 0 auto" }} onClick={attachCustomer}>ADD</button>
              </div>
              {attachMsg && <p className={attachMsg.includes("⭐") ? "ok" : "err"} style={{ marginTop: 6 }}>{attachMsg}</p>}
            </div>
          )}
          <p style={{ fontSize: 12, color: "var(--ash)" }}>
            Vendors notified, inventory updated.{autoPrint ? " Receipt sent to the printer." : ""}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10 }}>
            <button className="btn" onClick={() => { setReceipt(null); setCustQ(""); setCust(null); setRedeem(false); setCustMsg(""); setAttachQ(""); setAttachMsg(""); }}>NEXT CUSTOMER →</button>
            <button className="btn small ghost" onClick={() => printSale(receipt.id)}>REPRINT</button>
          </div>
        </div>
      )}

      {tab === "register" && !closeReport && drawer && !closing && !receipt && (
        <>
          <div style={{ display: "flex", gap: 0, border: "3px solid var(--ink)", borderRadius: 14, overflow: "hidden", marginBottom: 14, flexWrap: "wrap", background: "var(--cream)" }}>
            <div style={{ flex: "1 1 140px", padding: "10px 12px", borderRight: "2px solid var(--border)" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700 }}>SIGNED IN</div>
              <div className="display" style={{ fontSize: 15 }}>{drawer.employee}</div>
            </div>
            <div style={{ flex: "1 1 160px", padding: "10px 12px", background: "var(--ink)", color: "var(--cream)" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700 }}>DRAWER NOW (start + cash)</div>
              <div className="display" style={{ fontSize: 20 }}>{money(drawer.openTotalCents + drawer.cashSalesCents)}</div>
            </div>
          </div>
          <div style={{ marginBottom: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
            <button className="btn small ghost" onClick={() => { setClosing(true); setCounts({}); }}>CLOSE DRAWER (COUNT OUT)</button>
            <span style={{ flex: "1 1 120px", minWidth: 110 }}>
              <label style={{ margin: "0 0 4px" }}>⏱ Timeclock — who</label>
              <select value={punchName || employees[0]?.name || ""} onChange={(e) => setPunchName(e.target.value)}>
                {employees.map((e) => <option key={e.id}>{e.name}</option>)}
              </select>
            </span>
            <span style={{ flex: "0 1 90px" }}>
              <label style={{ margin: "0 0 4px" }}>PIN</label>
              <input type="password" inputMode="numeric" value={punchPin} onChange={(e) => setPunchPin(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && punch()} />
            </span>
            <button className="btn small" onClick={punch}>PUNCH</button>
          </div>
          {punchMsg && <p className={punchMsg.includes("clocked") ? "ok" : "err"} style={{ marginBottom: 10 }}>{punchMsg}</p>}

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
              <div key={l.sku} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--border)", gap: 8, flexWrap: "wrap" }}>
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
                </div>
                <div style={{ border: "1px solid var(--border)", borderRadius: 12, background: "#fafafa", padding: "10px 12px", margin: "10px 0" }}>
                  <b style={{ fontSize: 12.5 }}>⭐ REWARDS &amp; EMAIL RECEIPT (optional)</b>
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <input placeholder="Customer email or phone" value={custQ} onChange={(e) => { setCustQ(e.target.value); setCust(null); setRedeem(false); }}
                      onKeyDown={(e) => e.key === "Enter" && lookupCust()} />
                    <button className="btn small ghost" style={{ flex: "0 0 auto" }} onClick={lookupCust}>LOOK UP</button>
                  </div>
                  {cust && (
                    <div style={{ fontSize: 12.5, marginTop: 6 }}>
                      <b style={{ color: "var(--green)" }}>⭐ {cust.points} points</b>{cust.email ? ` · ${cust.email}` : ""}{cust.phone ? ` · ${cust.phone}` : ""}
                      {cust.points >= 100 && (
                        <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, cursor: "pointer", fontWeight: 700 }}>
                          <input type="checkbox" checked={redeem} onChange={(e) => setRedeem(e.target.checked)} style={{ width: "auto" }} />
                          REDEEM $5 OFF (100 pts)
                        </label>
                      )}
                    </div>
                  )}
                  {custMsg && <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 4 }}>{custMsg}</p>}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => completeSale("CASH")}>💵 CASH</button>
                  <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => completeSale("CARD")}>💳 CARD</button>
                </div>
                <button className="btn small ghost" style={{ marginTop: 10 }} onClick={() => setCart([])}>CLEAR TICKET</button>
              </>
            )}
          </div>

          {refundTarget && (
            <div className="card" style={{ marginTop: 16, borderWidth: 2 }}>
              <h2 className="display" style={{ fontSize: 16 }}>REFUND — TICKET #{refundTarget.ticket.number} ({refundTarget.ticket.paymentMethod})</h2>
              <table className="grid" style={{ marginTop: 8 }}>
                <thead><tr><th>Item</th><th style={{ textAlign: "right" }}>Sold</th><th style={{ textAlign: "right" }}>Already refunded</th><th style={{ textAlign: "right" }}>Refund qty</th></tr></thead>
                <tbody>
                  {refundTarget.lines.map((l) => {
                    const left = l.quantity - (refundTarget.refunded[l.id] || 0);
                    return (
                      <tr key={l.id}>
                        <td>{l.name} · {money(l.priceCents)}</td>
                        <td style={{ textAlign: "right" }}>{l.quantity}</td>
                        <td style={{ textAlign: "right" }}>{refundTarget.refunded[l.id] || 0}</td>
                        <td style={{ textAlign: "right" }}>
                          {left > 0 ? (
                            <input type="number" min={0} max={left} value={refundQty[l.id] ?? 0}
                              onChange={(e) => setRefundQty((q) => ({ ...q, [l.id]: Math.max(0, Math.min(left, Math.round(Number(e.target.value) || 0))) }))}
                              style={{ width: 70, textAlign: "right", padding: "5px 7px" }} />
                          ) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={refundRestock} onChange={(e) => setRefundRestock(e.target.checked)} style={{ width: "auto" }} />
                Put the item(s) back on the floor (uncheck if damaged/unsellable)
              </label>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button className="btn" style={{ flex: 1 }} onClick={submitRefund}>RECORD REFUND</button>
                <button className="btn small ghost" onClick={() => setRefundTarget(null)}>CANCEL</button>
              </div>
              {refundMsg && <p className="err">{refundMsg}</p>}
            </div>
          )}

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
                    <tr key={t.id} style={t.status === "VOIDED" ? { opacity: 0.45, textDecoration: "line-through" } : undefined}>
                      <td style={{ fontWeight: 700 }}>{t.number}{t.status !== "COMPLETE" ? ` · ${t.status.replace("_", " ")}` : ""}</td>
                      <td>{t.dateStr} {t.timeStr}</td>
                      <td>{t.paymentMethod}{t.cardName ? ` — ${t.cardName}` : ""}</td>
                      <td>{t.vendorCodes.join(" ")}</td>
                      <td style={{ textAlign: "right" }}>{money(t.totalCents)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="btn small ghost" onClick={() => printSale(t.id)}>REPRINT</button>{" "}
                        {t.status !== "VOIDED" && t.status !== "REFUNDED" && (
                          <>
                            <button className="btn small ghost" onClick={() => openRefund(t)}>REFUND</button>{" "}
                            <button className="btn small ghost" style={{ color: "var(--red)", borderColor: "var(--red)" }} onClick={() => voidSale(t)}>VOID</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {tickets.length === 0 && <tr><td colSpan={6}>No tickets match.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === "time" && (
        <div className="card">
          <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>TIMECLOCK{staffName ? ` — ${staffName.toUpperCase()}` : ""}</h2>
          {role === "admin" && !staffName ? (
            <p style={{ fontSize: 13, color: "var(--ash)" }}>Clocking in/out happens under each employee&rsquo;s own sign-in. Hours, punch fixes, and payroll live in the TEAM tab.</p>
          ) : (
            <>
              {timeData?.open ? (
                <>
                  <p style={{ fontSize: 14 }}>Clocked in since <b>{new Date(timeData.open.clockIn).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</b></p>
                  <div style={{ marginTop: 10 }}><button className="btn" onClick={() => clock("out")}>⏱ CLOCK OUT</button></div>
                </>
              ) : (
                <div style={{ marginTop: 4 }}><button className="btn" onClick={() => clock("in")}>⏱ CLOCK IN</button></div>
              )}
              {timeMsg && <p className="err">{timeMsg}</p>}
              <h3 className="display" style={{ fontSize: 15, margin: "16px 0 6px" }}>LAST 14 DAYS</h3>
              <table className="grid">
                <thead><tr><th>Day</th><th>In</th><th>Out</th><th style={{ textAlign: "right" }}>Hours</th></tr></thead>
                <tbody>
                  {(timeData?.entries || []).map((e) => (
                    <tr key={e.id}>
                      <td>{e.dayStr}</td><td>{e.inStr}</td><td>{e.outStr || <b>OPEN</b>}</td>
                      <td style={{ textAlign: "right" }}>{e.hours !== null ? e.hours.toFixed(2) : "—"}</td>
                    </tr>
                  ))}
                  {(!timeData || timeData.entries.length === 0) && <tr><td colSpan={4}>No punches yet.</td></tr>}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 8 }}>Forgot a punch? Tell the admin — they can fix it in TEAM.</p>
            </>
          )}
        </div>
      )}

      {tab === "team" && role === "admin" && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>PAYROLL — PICK A PAY PERIOD</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span style={{ flex: 1, minWidth: 140 }}><label>From</label><input type="date" value={payFrom} onChange={(e) => setPayFrom(e.target.value)} /></span>
              <span style={{ flex: 1, minWidth: 140 }}><label>To</label><input type="date" value={payTo} onChange={(e) => setPayTo(e.target.value)} /></span>
            </div>
            <div style={{ marginTop: 10 }}><button className="btn small" onClick={runPayroll}>RUN PAYROLL REPORT</button></div>
            {payroll && (
              <div style={{ overflowX: "auto", marginTop: 12 }}>
                <table className="grid">
                  <thead><tr><th>Employee</th><th style={{ textAlign: "right" }}>Hours</th><th style={{ textAlign: "right" }}>Rate</th><th style={{ textAlign: "right" }}>Gross</th><th style={{ textAlign: "right" }}>Deductions</th><th style={{ textAlign: "right" }}>Net</th></tr></thead>
                  <tbody>
                    {payroll.map((r) => (
                      <tr key={r.id}>
                        <td>{r.name}{r.openEntries > 0 ? " ⚠ open punch" : ""}</td>
                        <td style={{ textAlign: "right" }}>{r.hours.toFixed(2)}</td>
                        <td style={{ textAlign: "right" }}>{money(r.payRateCents)}/hr</td>
                        <td style={{ textAlign: "right" }}>{money(r.grossCents)}</td>
                        <td style={{ textAlign: "right" }}>{money(r.dedCents)}</td>
                        <td style={{ textAlign: "right", fontWeight: 700 }}>{money(r.netCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 8 }}>
                  Gross = hours × rate. Net = gross − the recurring deductions below. Withholding is yours to compute at Eldridge — this is the timesheet side.
                </p>
              </div>
            )}
            {teamMsg && <p className="err">{teamMsg}</p>}
          </div>

          {team.map((m) => (
            <div className="card" key={m.id} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                <h2 className="display" style={{ fontSize: 16 }}>{m.name.toUpperCase()}</h2>
                <button className="btn small ghost" onClick={() => {
                  const r = prompt(`Hourly pay rate for ${m.name} (dollars):`, (m.payRateCents / 100).toFixed(2));
                  if (r !== null) patchTeam({ employeeId: m.id, payRateDollars: r });
                }}>RATE: {money(m.payRateCents)}/HR</button>
              </div>

              <h3 className="display" style={{ fontSize: 13, margin: "12px 0 4px" }}>W-4 ON FILE</h3>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span style={{ flex: 1, minWidth: 130 }}>
                  <label>Filing status</label>
                  <select value={m.w4.filingStatus || ""} onChange={(e) => patchTeam({ employeeId: m.id, w4: { ...m.w4, filingStatus: e.target.value } })}>
                    <option value="">—</option>
                    <option>Single or MFS</option>
                    <option>Married filing jointly</option>
                    <option>Head of household</option>
                  </select>
                </span>
                <span style={{ flex: 1, minWidth: 110 }}>
                  <label>Step 3 dependents $</label>
                  <input defaultValue={m.w4.dependentsDollars || ""} onBlur={(e) => patchTeam({ employeeId: m.id, w4: { ...m.w4, dependentsDollars: e.target.value } })} />
                </span>
                <span style={{ flex: 1, minWidth: 110 }}>
                  <label>4(c) extra withholding $</label>
                  <input defaultValue={m.w4.extraWithholdingDollars || ""} onBlur={(e) => patchTeam({ employeeId: m.id, w4: { ...m.w4, extraWithholdingDollars: e.target.value } })} />
                </span>
              </div>

              <h3 className="display" style={{ fontSize: 13, margin: "12px 0 4px" }}>RECURRING DEDUCTIONS (PER PAY PERIOD)</h3>
              <ul style={{ margin: "4px 0" }}>
                {m.deductions.map((d) => (
                  <li key={d.id} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                    <span>{d.name}</span>
                    <span>{money(d.amountCents)} <button className="btn small ghost" onClick={() => dropDeduction(d.id)}>✕</button></span>
                  </li>
                ))}
                {m.deductions.length === 0 && <li style={{ fontSize: 12, color: "var(--ash)" }}>None.</li>}
              </ul>
              <button className="btn small ghost" onClick={() => addDeduction(m.id)}>+ ADD DEDUCTION</button>

              <h3 className="display" style={{ fontSize: 13, margin: "12px 0 4px" }}>DOCUMENTS (W-4 / I-9 / ID)</h3>
              <ul style={{ margin: "4px 0" }}>
                {m.docs.map((d) => (
                  <li key={d.id} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 13, gap: 8 }}>
                    <span>[{d.kind}] {d.filename}</span>
                    <span style={{ whiteSpace: "nowrap" }}>
                      <a className="btn small ghost" href={`/api/admin/team/docs/${d.id}`} target="_blank" rel="noopener">VIEW</a>{" "}
                      <button className="btn small ghost" onClick={() => dropDoc(d.id)}>✕</button>
                    </span>
                  </li>
                ))}
                {m.docs.length === 0 && <li style={{ fontSize: 12, color: "var(--ash)" }}>Nothing uploaded.</li>}
              </ul>
              <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
                <span style={{ minWidth: 110 }}>
                  <label>Type</label>
                  <select id={`kind-${m.id}`}>
                    <option>W4</option><option>I9</option><option>ID</option><option>OTHER</option>
                  </select>
                </span>
                <span style={{ flex: 1, minWidth: 180 }}>
                  <label>File (image or PDF, 5 MB max)</label>
                  <input type="file" accept="image/*,application/pdf" onChange={(e) => {
                    const f = e.target.files?.[0];
                    const kindEl = document.getElementById(`kind-${m.id}`) as HTMLSelectElement | null;
                    if (f) uploadDoc(m.id, kindEl?.value || "OTHER", f);
                    e.target.value = "";
                  }} />
                </span>
              </div>
            </div>
          ))}
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
                      {(report.refundTotal || 0) > 0 && <tr><td>Refunds given back</td><td style={{ textAlign: "right" }}>−{money(report.refundTotal || 0)}</td></tr>}
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
                <li key={v.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--border)", opacity: v.active ? 1 : 0.5 }}>
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
                      <button className="btn small ghost" disabled={busy} onClick={() => patchVendor(v.id, { allowSelfCheckout: !v.allowSelfCheckout })}>
                        {v.allowSelfCheckout ? "🛒 SELF-CHECKOUT: ON" : "🛒 SELF-CHECKOUT: OFF"}
                      </button>
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

          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 17, marginBottom: 4 }}>VENDOR APPLICATIONS 📋</h2>
            <p style={{ fontSize: 12, color: "var(--ash)" }}>
              Send hopefuls to <b>market.dailybreadbaked.com/apply</b>. Accepting emails them &ldquo;someone will be calling with next steps&rdquo; — then you call and add them under ADD A VENDOR below.
            </p>
            <ul style={{ margin: "8px 0" }}>
              {applications.map((a) => (
                <li key={a.id} style={{ padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <div style={{ cursor: "pointer" }} onClick={() => setAppOpen(appOpen === a.id ? null : a.id)}>
                      <b style={{ fontSize: 14 }}>{a.businessName}</b>
                      <span style={{ fontSize: 12, color: "var(--ash)" }}> · {a.contactName} · {a.category || "uncategorized"}</span>
                      <b style={{ fontSize: 12 }}> · {a.status}</b>
                    </div>
                    <a className="btn small ghost" href={`/admin/applications/${a.id}/print`} target="_blank" rel="noopener" style={{ marginRight: 5 }}>🖨</a>
                    {a.status === "PENDING" && (
                      <span style={{ display: "flex", gap: 5 }}>
                        <button className="btn small" disabled={busy} onClick={() => decideApplication(a.id, "accept")}>✅ ACCEPT</button>
                        <button className="btn small ghost" disabled={busy} onClick={() => decideApplication(a.id, "decline")}>❌ DECLINE</button>
                      </span>
                    )}
                  </div>
                  {appOpen === a.id && (
                    <div style={{ fontSize: 12.5, marginTop: 6, paddingLeft: 8, borderLeft: "2px solid var(--border)", lineHeight: 1.7 }}>
                      <b>Contact:</b> {a.email} · {a.phone}<br />
                      <b>Products:</b> {a.products}<br />
                      <b>Who makes it:</b> {a.madeByYou}<br />
                      {a.links && <><b>Links:</b> {a.links}<br /></>}
                      {a.licenses && <><b>Licensing:</b> {a.licenses}<br /></>}
                      {a.insurance && <><b>Insurance:</b> {a.insurance}<br /></>}
                      {a.availability && <><b>Restocking:</b> {a.availability}<br /></>}
                      {a.boothRequest && <><b>Booth requested:</b> {a.boothRequest}<br /></>}
                      {a.heardFrom && <><b>Heard via:</b> {a.heardFrom}<br /></>}
                      {a.phoneType && <><b>Phone:</b> {a.phoneType === "IPHONE" ? "iPhone 📱" : a.phoneType === "ANDROID" ? "Android 🤖" : a.phoneType}<br /></>}
                      {a.notes && <><b>Notes:</b> {a.notes}<br /></>}
                      <span style={{ color: "var(--ash)" }}>Applied {new Date(a.createdAt).toLocaleDateString()}</span>
                    </div>
                  )}
                </li>
              ))}
              {applications.length === 0 && <li style={{ fontSize: 13, color: "var(--ash)" }}>No applications yet — share the link.</li>}
            </ul>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 17, marginBottom: 4 }}>COMPLAINTS — MARKET OVERSIGHT ⚠️</h2>
            <p style={{ fontSize: 12, color: "var(--ash)" }}>Every complaint filed against any vendor, newest first. Vendors handle replies; this is your accountability view.</p>
            <ul style={{ margin: "8px 0" }}>
              {complaints.map((c) => (
                <li key={c.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
                    <b>{c.vendor ? `${c.vendor.code} ${c.vendor.businessName}` : "?"} ← {c.customerName}</b>
                    <span style={{ fontWeight: 700 }}>{c.status}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--ash)" }}>{c.email} · {c.phone}</div>
                  {c.messages.map((m, i) => (
                    <div key={i} style={{ fontSize: 12.5, marginTop: 4, paddingLeft: 8, borderLeft: "2px solid var(--border)" }}>
                      <b>{m.sender === "CUSTOMER" ? c.customerName : "Vendor"}:</b> {m.body}
                    </div>
                  ))}
                </li>
              ))}
              {complaints.length === 0 && <li style={{ fontSize: 13, color: "var(--ash)" }}>No complaints on file. 🎉</li>}
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
                <li key={c.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <span className="display" style={{ fontSize: 15 }}>BOOTH {c.boothLabel.toUpperCase()} · {c.vendor.businessName.toUpperCase()}</span>
                      {c.vendorSignedAt && c.marketSignedAt ? (
                        <span style={{ marginLeft: 7, background: "#f0fdf4", color: "#15803d", border: "1px solid #bbf7d0", borderRadius: 999, fontSize: 10.5, fontWeight: 800, letterSpacing: "0.04em", padding: "2px 9px", verticalAlign: "middle", whiteSpace: "nowrap" }}>✅ FULLY EXECUTED</span>
                      ) : c.vendorSignedAt ? (
                        <span style={{ marginLeft: 7, background: "#fefce8", color: "#a16207", border: "1px solid #fde68a", borderRadius: 999, fontSize: 10.5, fontWeight: 800, letterSpacing: "0.04em", padding: "2px 9px", verticalAlign: "middle", whiteSpace: "nowrap" }}>✍️ AWAITING YOUR SIGNATURE</span>
                      ) : c.marketSignedAt ? (
                        <span style={{ marginLeft: 7, background: "#fefce8", color: "#a16207", border: "1px solid #fde68a", borderRadius: 999, fontSize: 10.5, fontWeight: 800, letterSpacing: "0.04em", padding: "2px 9px", verticalAlign: "middle", whiteSpace: "nowrap" }}>✍️ AWAITING VENDOR</span>
                      ) : (
                        <span style={{ marginLeft: 7, background: "#f3f4f6", color: "#6b7280", border: "1px solid var(--border)", borderRadius: 999, fontSize: 10.5, fontWeight: 800, letterSpacing: "0.04em", padding: "2px 9px", verticalAlign: "middle", whiteSpace: "nowrap" }}>UNSIGNED</span>
                      )}
                      <div style={{ fontSize: 11.5, color: "var(--ash)" }}>
                        {money(c.monthlyRentCents)}/mo · started {new Date(c.startDate).toLocaleDateString()}
                        {" · "}
                        <b style={{ color: c.status === "ACTIVE" ? "var(--green)" : c.status === "TERMINATING" ? "var(--red)" : "var(--ash)" }}>
                          {c.status === "TERMINATING" && c.endDate ? `ENDS ${new Date(c.endDate).toLocaleDateString()}` : c.status}
                        </b>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                      <a className="btn small ghost" href={`/contract/${c.id}/packet`} target="_blank" rel="noopener">🖨 PACKET</a>
                      <button className="btn small ghost" disabled={busy} onClick={async () => {
                        setBusy(true);
                        try {
                          const r = await fetch(`/api/admin/contracts/${c.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send_for_signature" }) });
                          const d = await r.json().catch(() => ({}));
                          alert(r.ok ? `Signing link emailed to ${d.sentTo} ✓` : d.error || `Couldn't send (${r.status}).`);
                        } catch (e) {
                          alert(`Couldn't send — ${e instanceof Error ? e.message : "network error"}`);
                        } finally {
                          setBusy(false);
                        }
                      }}>📧 SEND FOR SIGNATURE</button>
                      <button className="btn small ghost" disabled={busy} onClick={async () => {
                        setBusy(true);
                        try {
                          const r = await fetch(`/api/admin/contracts/${c.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send_setup_guide" }) });
                          const d = await r.json().catch(() => ({}));
                          alert(r.ok ? `Setup guide emailed to ${d.sentTo} ✓` : d.error || `Couldn't send (${r.status}).`);
                        } catch (e) {
                          alert(`Couldn't send — ${e instanceof Error ? e.message : "network error"}`);
                        } finally {
                          setBusy(false);
                        }
                      }}>📖 RESEND GUIDE</button>
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
            <label>Booth size — rent prices by the square foot</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
              <button className={`btn small ${cMode === "standard" ? "" : "ghost"}`} onClick={() => {
                setCMode("standard"); setCW("5"); setCD("5"); setCRent(String(Math.round(25 * rentPerSqft * 100) / 100));
              }}>STANDARD 5×5 — {money(Math.round(25 * rentPerSqft * 100))}/MO</button>
              <button className={`btn small ${cMode === "custom" ? "" : "ghost"}`} onClick={() => setCMode("custom")}>CUSTOM SIZE</button>
            </div>
            <div style={{ display: cMode === "custom" ? "flex" : "none", gap: 8, alignItems: "center" }}>
              <input value={cW} onChange={(e) => { setCW(e.target.value); const w = Number(e.target.value) || 0, d = Number(cD) || 0; if (w > 0 && d > 0) setCRent(String(Math.round(w * d * rentPerSqft * 100) / 100)); }} type="number" min="1" step="1" style={{ width: 80 }} />
              <b>×</b>
              <input value={cD} onChange={(e) => { setCD(e.target.value); const d = Number(e.target.value) || 0, w = Number(cW) || 0; if (w > 0 && d > 0) setCRent(String(Math.round(w * d * rentPerSqft * 100) / 100)); }} type="number" min="1" step="1" style={{ width: 80 }} />
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>= {sqft} sqft → {money(Math.round(suggestedRent * 100))}/mo at ${rentPerSqft}/sqft</span>
            </div>
            <label>Monthly rent (auto-filled from size — change it freely for deals)</label>
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

      {tab === "tents" && role === "admin" && (
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>BOOKING PAUSE</h2>
            <p style={{ fontSize: 12, color: "var(--ash)" }}>Paused = the /tents page hides all dates and takes no bookings (your opened dates stay saved). Flip it off on opening day.</p>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 6 }}>
              <input type="checkbox" checked={tentPaused} onChange={(e) => setTentPaused(e.target.checked)} style={{ width: "auto" }} />
              Pause tent bookings
            </label>
            <label>Message shown while paused</label>
            <input value={tentPauseMsg} onChange={(e) => setTentPauseMsg(e.target.value)} placeholder="Tent bookings open with the market — October 15!" />
            <div style={{ marginTop: 10 }}>
              <button className="btn small" onClick={() => tentAct({ action: "pause", paused: tentPaused, message: tentPauseMsg })}>SAVE</button>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>OPEN TENT DATES ⛺</h2>
            <p style={{ fontSize: 12, color: "var(--ash)" }}>$25/day · $12.50 deposit online books the spot · $12.50 collected at the front desk at setup. Open the days you want, vendors book at <b>/tents</b>.</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 130px" }}><label>From</label><input type="date" value={tentFrom} onChange={(e) => setTentFrom(e.target.value)} /></span>
              <span style={{ flex: "1 1 130px" }}><label>To</label><input type="date" value={tentTo} onChange={(e) => setTentTo(e.target.value)} /></span>
              <span style={{ flex: "0 0 110px" }}><label>Spots per day</label><input type="number" min="1" max="20" value={tentCap} onChange={(e) => setTentCap(e.target.value)} /></span>
            </div>
            <label>Which weekdays in that range</label>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((d, i) => (
                <button key={d} className={`btn small ${tentDows.includes(i) ? "" : "ghost"}`}
                  onClick={() => setTentDows((x) => x.includes(i) ? x.filter((n) => n !== i) : [...x, i])}>{d}</button>
              ))}
            </div>
            <div style={{ marginTop: 10 }}><button className="btn small" onClick={openTentRange}>OPEN THESE DATES</button></div>
            {tentMsg && <p className={tentMsg.includes("✓") ? "ok" : "err"}>{tentMsg}</p>}
          </div>

          {tentDates.map((d) => {
            const taken = d.bookings.filter((b) => ["PAID_DEPOSIT", "CHECKED_IN"].includes(b.status)).length;
            return (
              <div className="card" key={d.id} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 15 }}>{new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</b>
                  <span style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>{taken}/{d.capacity} booked · {d.open ? "OPEN" : "CLOSED"}</span>
                    <button className="btn small ghost" onClick={() => tentAct({ action: "toggle", dateId: d.id, open: !d.open })}>{d.open ? "CLOSE" : "RE-OPEN"}</button>
                    <button className="btn small ghost" onClick={() => tentAct({ action: "weatherDay", dateId: d.id }, "Call a WEATHER DAY? Every paid booking on this date becomes a future-date credit and gets emailed. This also closes the date.")}>⛈ WEATHER DAY</button>
                  </span>
                </div>
                {d.bookings.filter((b) => !["CANCELED", "CREDIT_USED"].includes(b.status)).map((b) => (
                  <div key={b.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", padding: "7px 0", borderTop: "1px solid var(--border)", fontSize: 13 }}>
                    <span>
                      <b>{b.businessName || b.name}</b> · {b.name} · {b.phone}
                      <span style={{ fontWeight: 700 }}> · {b.status === "PAID_DEPOSIT" ? "DEPOSIT PAID — $12.50 DUE AT DESK" : b.status === "CHECKED_IN" ? "CHECKED IN ✓" : b.status === "WEATHER_CREDIT" ? "WEATHER CREDIT ISSUED" : b.status}</span>
                    </span>
                    <span style={{ display: "flex", gap: 5 }}>
                      {b.status === "PAID_DEPOSIT" && <button className="btn small" onClick={() => tentAct({ action: "checkin", bookingId: b.id })}>✓ CHECK IN ($12.50)</button>}
                      {["PAID_DEPOSIT", "RESERVED"].includes(b.status) && <button className="btn small ghost" onClick={() => tentAct({ action: "cancelBooking", bookingId: b.id }, "Cancel this booking? (No automatic refund — handle any refund in Stripe if owed.)")}>CANCEL</button>}
                    </span>
                  </div>
                ))}
                {d.bookings.filter((b) => !["CANCELED", "CREDIT_USED"].includes(b.status)).length === 0 && (
                  <p style={{ fontSize: 12.5, color: "var(--ash)", margin: "6px 0 0" }}>No bookings yet.</p>
                )}
              </div>
            );
          })}
          {tentDates.length === 0 && <p style={{ textAlign: "center", color: "var(--ash)" }}>No tent dates opened yet — open a range above.</p>}
        </div>
      )}

      {tab === "customers" && role === "admin" && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <h2 className="display" style={{ fontSize: 18 }}>CUSTOMERS ⭐</h2>
            <button className="btn small ghost" onClick={async () => {
              const r = await fetch("/api/admin/customers");
              if (r.ok) { const d = await r.json(); setCustomers(d.customers); }
            }}>REFRESH</button>
          </div>
          <p style={{ fontSize: 12.5, color: "var(--ash)" }}>Everyone who&rsquo;s given an email or phone — register, self-checkout, pre-orders, or following a vendor. 1 point per $2; $5 off at 100, redeemed at the register.</p>
          {customers.length === 0 && <button className="btn small" style={{ marginTop: 8 }} onClick={async () => {
            const r = await fetch("/api/admin/customers");
            if (r.ok) { const d = await r.json(); setCustomers(d.customers); }
          }}>LOAD CUSTOMERS</button>}
          {customers.length > 0 && (
            <table className="grid" style={{ marginTop: 10 }}>
              <thead><tr><th>Contact</th><th>Points</th><th>Sales</th><th>Spent</th><th>Follows</th><th>Alerts</th></tr></thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td>{c.email || c.phone}</td>
                    <td><b>{c.points}</b></td>
                    <td>{c.saleCount}</td>
                    <td>{money(c.spentCents)}</td>
                    <td>{c.follows}</td>
                    <td>{c.unsubscribed ? "❌ off" : "✅ on"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "links" && role === "admin" && (
        <div className="card">
          <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>SITE DIRECTORY — EVERY PAGE</h2>

          <h3 className="display" style={{ fontSize: 14, margin: "10px 0 4px" }}>PUBLIC — SHARE THESE</h3>
          <table className="grid"><tbody>
            <tr><td><a href="/market" target="_blank" rel="noopener">/market</a></td><td>Shopper directory — every vendor + what&rsquo;s on the floor right now. Put this on your website and socials.</td></tr>
            <tr><td><a href="/apply" target="_blank" rel="noopener">/apply</a></td><td>Vendor application.</td></tr>
            <tr><td><a href="/tents" target="_blank" rel="noopener">/tents</a></td><td>Outdoor tent booking — $12.50 deposit online, $12.50 at the desk.</td></tr>
            <tr><td><a href="/rules" target="_blank" rel="noopener">/rules</a></td><td>Market Rules &amp; booth standards — part of every vendor contract. Updates go through me and post instantly.</td></tr>
            <tr><td><a href="/shop" target="_blank" rel="noopener">/shop</a></td><td>Self-checkout — shoppers scan &amp; pay by card, no cashier. Print signs at <a href="/shop/sign" target="_blank" rel="noopener">/shop/sign</a>.</td></tr>
            <tr><td>/v/CODE</td><td>Each vendor&rsquo;s public page (reviews + messaging) — their table QR points here.{vendors.length > 0 ? " Yours:" : ""}</td></tr>
            {vendors.filter((v) => v.active).map((v) => (
              <tr key={v.id}><td><a href={`/v/${v.code}`} target="_blank" rel="noopener">/v/{v.code}</a></td><td>{v.businessName}</td></tr>
            ))}
          </tbody></table>

          <h3 className="display" style={{ fontSize: 14, margin: "14px 0 4px" }}>VENDORS</h3>
          <table className="grid"><tbody>
            <tr><td><a href="/" target="_blank" rel="noopener">/</a></td><td>Vendor login — the address you give every vendor.</td></tr>
            <tr><td>/vendor</td><td>Their dashboard (items, balance, inbox, alerts) — where login lands.</td></tr>
            <tr><td>/vendor/labels</td><td>Their barcode label picker.</td></tr>
            <tr><td>/vendor/qr</td><td>Their printable table QR card.</td></tr>
          </tbody></table>

          <h3 className="display" style={{ fontSize: 14, margin: "14px 0 4px" }}>YOURS</h3>
          <table className="grid"><tbody>
            <tr><td><a href="/admin" target="_blank" rel="noopener">/admin</a></td><td>This whole system. Employees log in here too (EMPLOYEE button).</td></tr>
            <tr><td>/admin/contracts/…/print</td><td>Printable booth contract — reached from the 🖨 on any contract.</td></tr>
          </tbody></table>

          <h3 className="display" style={{ fontSize: 14, margin: "14px 0 4px" }}>AUTOMATIC — EMAILED, NEVER TYPED</h3>
          <table className="grid"><tbody>
            <tr><td>/t/…</td><td>A customer&rsquo;s private message thread (secret link in their email).</td></tr>
            <tr><td>/pay/…</td><td>A customer&rsquo;s pre-order payment page (secret link in their email).</td></tr>
          </tbody></table>

          <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 10 }}>
            The only three addresses worth memorizing: the bare domain for vendor login, <b>/market</b> for shoppers, <b>/apply</b> for hopefuls. Everything else is a button or an email.
          </p>
        </div>
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

          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>DUAL PRICING 💳</h2>
            <p style={{ fontSize: 12.5, color: "var(--ash)" }}>
              Posted prices are card prices; cash customers skip the non-cash adjustment. Applied automatically at the register when CARD is tapped (0 turns it off; card networks cap this at 4%). Post the disclosure sign at the door and register: <a href="/admin/dual-pricing-sign" target="_blank" rel="noopener"><b>print the sign</b></a>.
            </p>
            <label>Non-cash adjustment (%)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="number" min="0" max="4" step="0.5" value={cardAdj} onChange={(e) => setCardAdj(e.target.value)} style={{ maxWidth: 120 }} />
              <button className="btn small" onClick={async () => {
                const r = await fetch("/api/admin/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cardAdjustPercent: Number(cardAdj) }) });
                if (!r.ok) { const d = await r.json(); alert(d.error || "Couldn't save."); }
              }}>SAVE</button>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>SELF-CHECKOUT 🛒</h2>
            <p style={{ fontSize: 12.5, color: "var(--ash)" }}>
              Master switch for the whole scan-and-pay page at <b>/shop</b>. Pausing it hides everything and tells shoppers to pay at the register — individual vendors are toggled on their row in the VENDORS tab.
            </p>
            <p style={{ fontSize: 13, fontWeight: 700, marginTop: 8 }}>
              Right now: {scPaused ? "⏸ PAUSED — register only" : "🟢 ON — shoppers can scan & pay"}
            </p>
            <div style={{ marginTop: 8 }}>
              <button className="btn small" onClick={async () => {
                const r = await fetch("/api/admin/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selfCheckoutPaused: !scPaused }) });
                if (r.ok) setScPaused((p) => !p);
              }}>{scPaused ? "▶ TURN SELF-CHECKOUT ON" : "⏸ PAUSE SELF-CHECKOUT"}</button>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>ADMIN NOTIFICATIONS 🔔</h2>
            <p style={{ fontSize: 12, color: "var(--ash)" }}>
              Get a push on this device when: a vendor application comes in 📋 · a complaint is filed ⚠️ · a tent gets booked ⛺ · a pre-order is paid 💳.
              {adminPushDevices !== null && ` Devices enabled: ${adminPushDevices}.`}
            </p>
            <div style={{ marginTop: 8 }}><button className="btn small" onClick={enableAdminPush}>ENABLE ON THIS DEVICE</button></div>
            {adminPushMsg && <p className={adminPushMsg.includes("✓") ? "ok" : "err"}>{adminPushMsg}</p>}
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>BOOTH RENT RATE</h2>
            <p style={{ fontSize: 12, color: "var(--ash)" }}>Every booth prices at this rate × its square footage. $6/sqft makes the standard 5×5 exactly $150.</p>
            <label>Rate ($ per square foot per month)</label>
            <input type="number" min="0.5" step="0.25" value={rentPerSqft} onChange={(e) => setRentPerSqft(Number(e.target.value))} />
            <p style={{ fontSize: 12, marginTop: 8 }}>
              At ${rentPerSqft}/sqft: 4×4 = {money(Math.round(16 * rentPerSqft * 100))} · 5×5 = {money(Math.round(25 * rentPerSqft * 100))} · 5×10 = {money(Math.round(50 * rentPerSqft * 100))} · 10×10 = {money(Math.round(100 * rentPerSqft * 100))}
            </p>
            <div style={{ marginTop: 10 }}><button className="btn small" onClick={saveRate}>SAVE RATE</button></div>
            {rateMsg && <p className={rateMsg.includes("✓") ? "ok" : "err"}>{rateMsg}</p>}
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>PUBLIC BANNER — /APPLY &amp; /MARKET</h2>
            <p style={{ fontSize: 12, color: "var(--ash)" }}>The black announcement box on the public pages. Edit it, or untick to remove it — no code needed.</p>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8 }}>
              <input type="checkbox" checked={banEnabled} onChange={(e) => setBanEnabled(e.target.checked)} style={{ width: "auto" }} />
              Show the banner
            </label>
            <label>Big line</label>
            <input value={banTitle} onChange={(e) => setBanTitle(e.target.value)} placeholder="COMING SOON" />
            <label>Second line (date works well here)</label>
            <input value={banDate} onChange={(e) => setBanDate(e.target.value)} placeholder="EXPECTED GRAND OPENING — OCTOBER 15, 2026 · 8:00 AM" />
            <label>Small line</label>
            <input value={banMessage} onChange={(e) => setBanMessage(e.target.value)} placeholder="Apply to get on the vendor list before the doors open." />
            <div style={{ marginTop: 12 }}><button className="btn small" onClick={saveBanner}>SAVE BANNER</button></div>
            {banMsg && <p className={banMsg.includes("✓") ? "ok" : "err"}>{banMsg}</p>}
          </div>

          <div className="card">
            <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>REGISTER EMPLOYEES</h2>
            <p style={{ fontSize: 12, color: "var(--ash)" }}>Anyone who can sign in and open/close the cash drawer.</p>
            <ul style={{ listStyle: "none", margin: "10px 0" }}>
              {employees.map((e) => (
                <li key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
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

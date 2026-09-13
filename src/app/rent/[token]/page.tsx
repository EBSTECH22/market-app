"use client";

import { useEffect, useState } from "react";

type Info = { businessName: string; boothLabel: string; dueCents: number; feeCents: number; totalCents: number; processingPercent: number };

export default function RentPayPage({ params }: { params: { token: string } }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [paid, setPaid] = useState<{ last4: string } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get("session_id");
    const base = `/api/public/rent-pay?token=${encodeURIComponent(params.token)}`;
    fetch(sid ? `${base}&session_id=${encodeURIComponent(sid)}` : base).then(async (r) => {
      const d = await r.json();
      if (!r.ok) { setErr(d.error || "Something went wrong."); return; }
      if (d.paid) { setPaid({ last4: d.last4 }); window.history.replaceState(null, "", `/rent/${params.token}`); }
      else setInfo(d);
    });
  }, [params.token]);

  const pay = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/public/rent-pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: params.token }) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || "Couldn't start the payment."); return; }
      window.location.href = d.url;
    } finally { setBusy(false); }
  };

  return (
    <main style={{ maxWidth: 460, margin: "0 auto", padding: "40px 16px 60px", textAlign: "center" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/wordmark.png" alt="Community Harvest" style={{ width: 200, maxWidth: "70%", height: "auto", margin: "0 auto 14px", display: "block" }} />
      {err && <p className="err">{err}</p>}
      {paid && (
        <div className="card" style={{ background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
          <div style={{ fontSize: 40 }}>✅</div>
          <h1 className="display" style={{ fontSize: 22, margin: "6px 0" }}>RENT PAID — YOU&rsquo;RE ALL SET</h1>
          <p style={{ fontSize: 13.5 }}>Your card ····{paid.last4} is saved for automatic settlement going forward. Log in to your portal to add products and start selling.</p>
          <a className="btn" style={{ marginTop: 12 }} href="/">🔑 OPEN YOUR VENDOR PORTAL</a>
        </div>
      )}
      {info && !paid && (
        <div className="card">
          <h1 className="display" style={{ fontSize: 21 }}>FIRST MONTH&rsquo;S RENT</h1>
          <p style={{ fontSize: 13, color: "var(--ash)" }}>{info.businessName} · booth {info.boothLabel}</p>
          {info.dueCents === 0 ? (
            <p className="ok" style={{ marginTop: 8 }}>Nothing due — your balance is covered. 🎉</p>
          ) : (
            <>
              <div style={{ textAlign: "left", background: "#fafafa", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px", margin: "12px 0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}><span>Rent due</span><b>${(info.dueCents / 100).toFixed(2)}</b></div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}><span>Card-processing adjustment ({info.processingPercent}%)</span><b>${(info.feeCents / 100).toFixed(2)}</b></div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}><span><b>Total</b></span><b>${(info.totalCents / 100).toFixed(2)}</b></div>
              </div>
              <button className="btn" disabled={busy} onClick={pay}>💳 PAY ${(info.totalCents / 100).toFixed(2)} &amp; SET UP AUTOPAY</button>
              <p style={{ fontSize: 11.5, color: "var(--ash)", marginTop: 10 }}>One payment covers your first month AND saves your card for automatic settlement. Prefer cash or check (no fee)? Just pay at the market. Secure payment by Stripe.</p>
            </>
          )}
        </div>
      )}
      {!info && !paid && !err && <p style={{ color: "var(--ash)" }}>Loading…</p>}
    </main>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";

type Order = { vendorName: string; description: string; subtotalCents: number; taxCents: number; totalCents: number; expectedDate: string; status: string };
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function PayPage({ params }: { params: { token: string } }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [missing, setMissing] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/public/pay/${params.token}`);
    if (!res.ok) { setMissing(true); return; }
    setOrder((await res.json()).order);
  }, [params.token]);

  useEffect(() => {
    load();
    // after Stripe redirects back, payment can take a beat to register — poll briefly
    if (new URLSearchParams(window.location.search).get("done")) {
      const t = setInterval(load, 2500);
      setTimeout(() => clearInterval(t), 20000);
      return () => clearInterval(t);
    }
  }, [load]);

  const pay = async () => {
    setMsg(""); setBusy(true);
    const res = await fetch(`/api/public/pay/${params.token}`, { method: "POST" });
    const data = await res.json();
    setBusy(false);
    if (!res.ok || !data.url) { setMsg(data.error || "Couldn't start payment."); return; }
    window.location.href = data.url;
  };

  if (missing) return <main style={{ padding: 60, textAlign: "center" }}>Order not found — use the link from your email.</main>;
  if (!order) return <main style={{ padding: 60, textAlign: "center" }}>Loading…</main>;

  return (
    <main style={{ maxWidth: 460, margin: "0 auto", padding: "30px 14px 70px" }}>
      <div style={{ textAlign: "center", marginBottom: 12 }}>
        <img src="/logo-receipt.png" alt="Community Harvest" style={{ width: 120, margin: "0 auto 4px", display: "block" }} />
        <div className="display" style={{ fontSize: 20 }}>PRE-ORDER — {order.vendorName.toUpperCase()}</div>
      </div>
      <div className="card">
        <p style={{ fontSize: 14 }}>{order.description}</p>
        <table className="grid" style={{ marginTop: 8 }}>
          <tbody>
            <tr><td>Subtotal</td><td style={{ textAlign: "right" }}>{money(order.subtotalCents)}</td></tr>
            <tr><td>Sales tax</td><td style={{ textAlign: "right" }}>{money(order.taxCents)}</td></tr>
            <tr><td style={{ fontWeight: 700 }}>TOTAL</td><td style={{ textAlign: "right", fontWeight: 700 }}>{money(order.totalCents)}</td></tr>
            <tr><td>Ready / expected</td><td style={{ textAlign: "right" }}>{order.expectedDate}</td></tr>
          </tbody>
        </table>
        {order.status === "PAID" ? (
          <p className="ok" style={{ fontSize: 15, textAlign: "center" }}>PAID ✓ — you&rsquo;re confirmed. See you at the market!</p>
        ) : order.status === "DECLINED" ? (
          <p className="err">This pre-order was declined — check your conversation with the vendor.</p>
        ) : (
          <>
            <div style={{ marginTop: 12 }}>
              <button className="btn" disabled={busy} onClick={pay}>💳 PAY {money(order.totalCents)} SECURELY</button>
            </div>
            <p style={{ fontSize: 11, color: "var(--ash)", marginTop: 8, textAlign: "center" }}>Card payment handled by Stripe. Community Harvest — Food and Craft Market, Noble OK.</p>
          </>
        )}
        {msg && <p className="err">{msg}</p>}
      </div>
    </main>
  );
}

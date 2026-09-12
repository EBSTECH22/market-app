"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Cart = {
  status: string; number: number | null;
  lines: { name: string; quantity: number; priceCents: number }[];
  subtotalCents: number; taxCents: number; totalCents: number; paidAt: string | null;
};

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function PaidScreen() {
  const params = useParams<{ token: string }>();
  const [cart, setCart] = useState<Cart | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      const r = await fetch(`/api/public/shop/cart/${params.token}`);
      if (r.ok) {
        const d = await r.json();
        if (!stop) setCart(d.cart);
        if (d.cart?.status === "PAID") return;
      }
      if (!stop) { setTries((t) => t + 1); setTimeout(poll, 1500); }
    };
    poll();
    return () => { stop = true; };
  }, [params.token]);

  if (!cart || (cart.status !== "PAID" && tries < 8)) {
    return (
      <main style={{ maxWidth: 460, margin: "0 auto", padding: "60px 16px", textAlign: "center" }}>
        <div className="skel" style={{ height: 34, width: 220, margin: "0 auto 14px" }} />
        <p style={{ fontSize: 14, color: "var(--ash)" }}>Confirming your payment…</p>
      </main>
    );
  }

  if (cart.status !== "PAID") {
    return (
      <main style={{ maxWidth: 460, margin: "0 auto", padding: "50px 16px", textAlign: "center" }}>
        <h1 className="display" style={{ fontSize: 22 }}>PAYMENT NOT CONFIRMED YET</h1>
        <p style={{ fontSize: 13.5, color: "var(--ash)", marginTop: 8 }}>If your card was charged, show this screen at the register and we&rsquo;ll sort it in seconds.</p>
        <a className="btn" style={{ marginTop: 14 }} href={`/shop/paid/${params.token}`}>CHECK AGAIN</a>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 460, margin: "0 auto", padding: "34px 16px 60px" }}>
      <div className="card" style={{ background: "#f0fdf4", border: "2px solid #16a34a", textAlign: "center" }}>
        <div style={{ fontSize: 46, lineHeight: 1 }}>✅</div>
        <h1 className="display" style={{ fontSize: 30, color: "#15803d", margin: "6px 0 2px" }}>PAID</h1>
        <div className="display" style={{ fontSize: 20 }}>RECEIPT #{cart.number}</div>
        <div style={{ fontSize: 12, color: "var(--ash)", marginBottom: 10 }}>
          {cart.paidAt ? new Date(cart.paidAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
        </div>
        <div style={{ textAlign: "left", background: "#fff", border: "1px solid #bbf7d0", borderRadius: 12, padding: "10px 14px" }}>
          {cart.lines.map((l, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "3px 0" }}>
              <span>{l.quantity}× {l.name}</span><b>{money(l.priceCents * l.quantity)}</b>
            </div>
          ))}
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 6, display: "flex", justifyContent: "space-between", fontSize: 13.5 }}><span>Subtotal</span><b>{money(cart.subtotalCents)}</b></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}><span>Sales tax</span><b>{money(cart.taxCents)}</b></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16 }}><span className="display">TOTAL</span><b className="display">{money(cart.totalCents)}</b></div>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--ash)", marginTop: 10 }}>Show this screen on your way out if asked. Thanks for shopping local! 🌾</p>
        <a className="btn small ghost" style={{ marginTop: 8 }} href="/shop">SHOP MORE</a>
      </div>
    </main>
  );
}

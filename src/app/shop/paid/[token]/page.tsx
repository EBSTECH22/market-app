"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, Icon, LinkButton, Note, Skeleton } from "@/components/ui";
import { fmtDateTime, money } from "@/lib/format";

type Cart = {
  status: string; number: number | null;
  lines: { name: string; quantity: number; priceCents: number }[];
  subtotalCents: number; taxCents: number; totalCents: number; paidAt: string | null;
};

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
      <main className="public-wrap public-narrow" aria-busy="true">
        <Card>
          <div className="stack g-3" style={{ textAlign: "center" }}>
            <Skeleton width={220} height={30} style={{ margin: "0 auto" }} />
            <p className="t-sm t-muted">Confirming your payment…</p>
          </div>
        </Card>
      </main>
    );
  }

  if (cart.status !== "PAID") {
    return (
      <main className="public-wrap public-narrow">
        <Card title="Payment not confirmed yet">
          <div className="stack g-4">
            <Note tone="warn">
              If your card was charged, show this screen at the register and we&rsquo;ll sort it in seconds.
            </Note>
            <LinkButton href={`/shop/paid/${params.token}`} variant="primary" size="lg" block icon="refresh">
              Check again
            </LinkButton>
          </div>
        </Card>
      </main>
    );
  }

  return (
    <main className="public-wrap public-narrow">
      <Card>
        <div className="stack g-4">
          <div className="stack g-2" style={{ textAlign: "center" }}>
            <span style={{ color: "var(--accent)", display: "block" }}>
              <Icon name="checkCircle" size={44} />
            </span>
            <h1 className="t-page t-accent">Paid</h1>
            <p className="t-card">Receipt #{cart.number}</p>
            {cart.paidAt ? <p className="t-xs t-muted">{fmtDateTime(cart.paidAt)}</p> : null}
          </div>

          <div
            className="stack g-1"
            style={{
              background: "var(--bg-inset)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-md)",
              padding: "var(--sp-3) var(--sp-4)",
            }}
          >
            {cart.lines.map((l, i) => (
              <div key={i} className="row between g-3" style={{ minHeight: 26 }}>
                <span className="t-sm">{l.quantity}× {l.name}</span>
                <span className="t-sm num">{money(l.priceCents * l.quantity)}</span>
              </div>
            ))}
            <hr className="divider mt-2 mb-2" />
            <div className="row between g-3" style={{ minHeight: 26 }}>
              <span className="t-sm t-secondary">Subtotal</span>
              <span className="t-sm num">{money(cart.subtotalCents)}</span>
            </div>
            <div className="row between g-3" style={{ minHeight: 26 }}>
              <span className="t-sm t-secondary">Sales tax</span>
              <span className="t-sm num">{money(cart.taxCents)}</span>
            </div>
            <div className="row between g-3" style={{ minHeight: 30 }}>
              <span className="t-card">Total</span>
              <span className="t-card num">{money(cart.totalCents)}</span>
            </div>
          </div>

          <p className="t-xs t-muted" style={{ textAlign: "center" }}>
            Show this screen on your way out if asked. Thanks for shopping local! 🌾
          </p>

          <LinkButton href="/shop" variant="secondary" size="lg" block icon="store">
            Shop more
          </LinkButton>
        </div>
      </Card>

      <p className="t-xs t-muted mt-3" style={{ textAlign: "center" }}>
        All sales final — no refunds or exchanges.
      </p>
    </main>
  );
}

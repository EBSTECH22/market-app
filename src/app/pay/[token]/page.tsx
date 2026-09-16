"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, LinkButton, Note, Skeleton } from "@/components/ui";
import { money } from "@/lib/format";

type Order = { vendorName: string; description: string; subtotalCents: number; taxCents: number; totalCents: number; expectedDate: string; status: string };

/** One line of the order summary. Replaces the old `table.grid`. */
function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="row between g-3" style={{ minHeight: 28 }}>
      <span className={strong ? "t-card" : "t-sm t-secondary"}>{label}</span>
      <span className={strong ? "t-card num" : "t-sm num"}>{value}</span>
    </div>
  );
}

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

  if (missing) {
    return (
      <main className="public-wrap public-narrow">
        <Card title="We couldn't find that pre-order">
          <div className="stack g-4">
            <Note tone="error">
              This link doesn&rsquo;t match a pre-order. Open the most recent link from your email — and if
              you&rsquo;ve already paid, your confirmation email is the receipt.
            </Note>
            <LinkButton href="/market" variant="secondary" size="lg" block icon="store">
              See the market
            </LinkButton>
          </div>
        </Card>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="public-wrap public-narrow" aria-busy="true">
        <span className="sr-only">Loading your pre-order…</span>
        <Card>
          <div className="stack g-3">
            <Skeleton width="55%" height={20} />
            <Skeleton height={14} />
            <Skeleton height={14} />
            <Skeleton width="40%" height={14} />
            <Skeleton height={48} style={{ marginTop: "var(--sp-3)" }} />
          </div>
        </Card>
      </main>
    );
  }

  return (
    <main className="public-wrap public-narrow">
      <div className="stack g-3 mb-4" style={{ textAlign: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="Community Harvest" style={{ width: 120, margin: "0 auto", display: "block" }} />
        <h1 className="t-page">Pre-order — {order.vendorName}</h1>
      </div>

      <Card>
        <div className="stack g-4">
          <p className="t-body" style={{ whiteSpace: "pre-wrap" }}>{order.description}</p>

          <div className="stack g-2">
            <Line label="Subtotal" value={money(order.subtotalCents)} />
            <Line label="Sales tax" value={money(order.taxCents)} />
            <hr className="divider" />
            <Line label="Total" value={money(order.totalCents)} strong />
            <Line label="Ready / expected" value={order.expectedDate} />
          </div>

          {order.status === "PAID" ? (
            <Note tone="success" title="Paid — you're confirmed">
              See you at the market. Bring this screen or your emailed receipt if anyone asks.
            </Note>
          ) : order.status === "DECLINED" ? (
            <Note tone="error" title="This pre-order was declined">
              Check your conversation with the vendor — they&rsquo;ll have said why.
            </Note>
          ) : (
            <div className="stack g-3">
              <Button variant="primary" size="lg" block icon="card" loading={busy} onClick={pay}>
                Pay {money(order.totalCents)} securely
              </Button>
              <p className="t-xs t-muted" style={{ textAlign: "center" }}>
                Card payment handled by Stripe. Community Harvest — Food and Craft Market, Noble OK.
              </p>
            </div>
          )}

          {msg && <Note tone="error">{msg}</Note>}
        </div>
      </Card>
    </main>
  );
}

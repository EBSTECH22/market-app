"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, LinkButton, Note, SkeletonCard } from "@/components/ui";
import { money, fmtDateTime, plural } from "@/lib/format";

/**
 * A customer's own order.
 *
 * Reached from the link in their confirmation email and from Stripe's return
 * URL, so it is also the page that tells somebody their payment went through.
 * It polls briefly on arrival for exactly that reason: the webhook is usually
 * a second or two behind the redirect, and "waiting for payment" shown to
 * somebody who has just paid is how a support call starts.
 */

type Line = { name: string; unitLabel: string; quantity: number; priceCents: number };
type Order = {
  number: number;
  status: string;
  statusLabel: string;
  fulfillment: string;
  placedAt: string;
  paidAt: string | null;
  customerName: string;
  note: string;
  vendor: { businessName: string; code: string; email: string };
  lines: Line[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  carrier: string;
  trackingNumber: string;
  shipTo: { name: string; line1: string; line2: string; city: string; state: string; postal: string } | null;
};

const TONE: Record<string, "success" | "warn" | "info" | "danger" | "neutral"> = {
  PAID: "info",
  PACKED: "info",
  READY: "success",
  COLLECTED: "success",
  SHIPPED: "success",
  PENDING: "warn",
  EXPIRED: "neutral",
  CANCELLED: "danger",
  REFUNDED: "danger",
};

export default function OrderPage({ params }: { params: { token: string } }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [missing, setMissing] = useState(false);
  const [tries, setTries] = useState(0);

  const load = useCallback(async () => {
    const r = await fetch(`/api/public/order/${params.token}`);
    if (!r.ok) { setMissing(true); return; }
    setOrder(await r.json());
  }, [params.token]);

  useEffect(() => { void load(); }, [load]);

  /* Poll only while the payment hasn't landed, and only for about half a
     minute. A page that polls forever is a page that drains a phone battery in
     a car park. */
  useEffect(() => {
    if (!order || order.status !== "PENDING" || tries > 10) return;
    const t = window.setTimeout(() => { setTries((n) => n + 1); void load(); }, 3000);
    return () => window.clearTimeout(t);
  }, [order, tries, load]);

  if (missing) {
    return (
      <main className="public-wrap public-narrow">
        <EmptyState
          icon="receipt"
          title="Order not found"
          body="That link doesn't match an order. Check the link in your confirmation email."
          action={<LinkButton href="/market" variant="primary" icon="store">Back to the market</LinkButton>}
        />
      </main>
    );
  }

  if (!order) {
    return (
      <main className="public-wrap public-narrow">
        <div className="stack g-4 mt-6" aria-busy><SkeletonCard lines={3} /><SkeletonCard lines={4} /></div>
      </main>
    );
  }

  const pickup = order.fulfillment === "PICKUP";

  return (
    <>
      <header className="public-header">
        <div className="public-header-inner">
          <a href="/market" aria-label="Community Harvest" style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wordmark.png" alt="Community Harvest" style={{ width: 150, maxWidth: "46vw", height: "auto", display: "block" }} />
          </a>
          <LinkButton href={`/v/${order.vendor.code}`} variant="ghost" size="sm">{order.vendor.businessName}</LinkButton>
        </div>
      </header>

      <main className="public-wrap public-narrow">
        <div className="hero">
          <h1 className="hero-title">Order #{order.number}</h1>
          <div className="row g-2 mt-2" style={{ justifyContent: "center" }}>
            <Badge tone={TONE[order.status] || "neutral"} dot>{order.statusLabel}</Badge>
          </div>
          <p className="hero-sub">
            {order.vendor.businessName} · placed {fmtDateTime(order.placedAt)}
          </p>
        </div>

        {order.status === "PENDING" ? (
          <Note tone="warn" title="Waiting for the payment to confirm">
            If you&rsquo;ve just paid, this page updates itself in a few seconds. Nothing is packed until it does.
          </Note>
        ) : null}

        {order.status === "READY" ? (
          <Note tone="success" title="Ready to collect">
            It&rsquo;s packed and waiting at Community Harvest, 510 N Main St, Noble. Give your name or this order
            number at the counter.
          </Note>
        ) : null}

        {order.status === "SHIPPED" ? (
          <Note tone="success" title="On its way">
            {order.trackingNumber
              ? `${order.carrier || "Tracking"}: ${order.trackingNumber}`
              : "Posted by the vendor."}
          </Note>
        ) : null}

        {order.status === "CANCELLED" ? (
          <Note tone="error" title="This order was cancelled">
            {order.vendor.businessName} cancelled it. If you were charged, contact them at {order.vendor.email} — any
            refund comes from the market&rsquo;s card processor and can take a few days to appear.
          </Note>
        ) : null}

        <Card title={`${plural(order.lines.length, "item")}`} className="mb-4 mt-4">
          <div className="stack g-3">
            {order.lines.map((l, idx) => (
              <div key={`${l.name}-${idx}`} className="row between g-3">
                <span className="grow">
                  {l.quantity}× {l.name}
                  {l.unitLabel ? <span className="t-xs t-muted"> ({l.unitLabel})</span> : null}
                </span>
                <span className="num">{money(l.priceCents * l.quantity)}</span>
              </div>
            ))}

            <div className="stack g-1" style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--sp-3)" }}>
              <div className="row between"><span>Subtotal</span><span className="num">{money(order.subtotalCents)}</span></div>
              {order.shippingCents > 0 ? (
                <div className="row between"><span>Shipping</span><span className="num">{money(order.shippingCents)}</span></div>
              ) : null}
              {order.taxCents > 0 ? (
                <div className="row between"><span>Sales tax</span><span className="num">{money(order.taxCents)}</span></div>
              ) : null}
              <div className="row between" style={{ fontWeight: 700 }}>
                <span>{order.paidAt ? "Paid" : "Total"}</span>
                <span className="num">{money(order.totalCents)}</span>
              </div>
            </div>
          </div>
        </Card>

        <Card title={pickup ? "Collection" : "Delivery"} className="mb-4">
          {pickup ? (
            <div className="stack g-2">
              <p className="t-body" style={{ margin: 0 }}>
                Community Harvest — Food and Craft Market<br />
                510 N Main St, Noble, OK 73068
              </p>
              <p className="t-sm t-muted" style={{ margin: 0 }}>
                Wait for the &ldquo;ready to collect&rdquo; email before coming — {order.vendor.businessName} packs
                these themselves.
              </p>
            </div>
          ) : order.shipTo && order.shipTo.line1 ? (
            <p className="t-body" style={{ margin: 0 }}>
              {order.shipTo.name || order.customerName}<br />
              {order.shipTo.line1}{order.shipTo.line2 ? <><br />{order.shipTo.line2}</> : null}<br />
              {order.shipTo.city}, {order.shipTo.state} {order.shipTo.postal}
            </p>
          ) : (
            <p className="t-sm t-muted" style={{ margin: 0 }}>Address collected at checkout.</p>
          )}
        </Card>

        <Card title="Something wrong?">
          <p className="t-body" style={{ margin: 0 }}>
            {order.vendor.businessName} packs and sends this order — reach them at{" "}
            <a href={`mailto:${order.vendor.email}`}>{order.vendor.email}</a>, or ask at the market counter.
          </p>
          <div className="mt-3">
            <LinkButton href={`/v/${order.vendor.code}`} variant="secondary" icon="store">
              Back to {order.vendor.businessName}
            </LinkButton>
          </div>
        </Card>
      </main>
    </>
  );
}

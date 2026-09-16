"use client";

import { useEffect, useState } from "react";
import { Button, Card, Icon, LinkButton, Note, Skeleton } from "@/components/ui";
import { money } from "@/lib/format";

type Info = { businessName: string; boothLabel: string; dueCents: number; feeCents: number; totalCents: number; processingPercent: number };

/** One line of the rent breakdown. Replaces the old hand-rolled flex rows. */
function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="row between g-3" style={{ minHeight: 28 }}>
      <span className={strong ? "t-card" : "t-sm t-secondary"}>{label}</span>
      <span className={strong ? "t-card num" : "t-sm num"}>{value}</span>
    </div>
  );
}

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
    <main className="public-wrap public-narrow">
      <div className="mb-4" style={{ textAlign: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 200, maxWidth: "70%", height: "auto", margin: "0 auto", display: "block" }} />
      </div>

      {err && (
        <div className="mb-4">
          <Note tone="error" title="We couldn't open that rent link">{err}</Note>
        </div>
      )}

      {paid && (
        <Card>
          <div className="stack g-4" style={{ textAlign: "center" }}>
            <span style={{ color: "var(--accent)", display: "block" }}>
              <Icon name="checkCircle" size={40} />
            </span>
            <div>
              <h1 className="t-page">Rent paid — you&rsquo;re all set</h1>
              <p className="t-sm t-secondary mt-2">
                Your card ····{paid.last4} is saved for automatic settlement from here on. Log in to your
                portal to add products and start selling.
              </p>
            </div>
            <LinkButton href="/" variant="primary" size="lg" block icon="unlock">
              Open your vendor portal
            </LinkButton>
          </div>
        </Card>
      )}

      {info && !paid && (
        <Card
          title={<>First month&rsquo;s rent</>}
          subtitle={`${info.businessName} · booth ${info.boothLabel}`}
        >
          {info.dueCents === 0 ? (
            <Note tone="success" title="Nothing due">
              Your balance already covers this month&rsquo;s rent — there&rsquo;s nothing to pay.
            </Note>
          ) : (
            <div className="stack g-4">
              <div
                className="stack g-2"
                style={{
                  background: "var(--bg-inset)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-md)",
                  padding: "var(--sp-3) var(--sp-4)",
                }}
              >
                <Line label="Rent due" value={money(info.dueCents)} />
                <Line label={`Card-processing adjustment (${info.processingPercent}%)`} value={money(info.feeCents)} />
                <hr className="divider" />
                <Line label="Total" value={money(info.totalCents)} strong />
              </div>

              <Button variant="primary" size="lg" block icon="card" loading={busy} onClick={pay}>
                Pay {money(info.totalCents)} and set up autopay
              </Button>

              <p className="t-xs t-muted" style={{ textAlign: "center" }}>
                One payment covers your first month and saves your card for automatic settlement. Prefer cash
                or check (no fee)? Just pay at the market. Secure payment by Stripe.
              </p>
            </div>
          )}
        </Card>
      )}

      {!info && !paid && !err && (
        <Card>
          <div className="stack g-3" aria-busy="true">
            <span className="sr-only">Loading what&rsquo;s due…</span>
            <Skeleton width="55%" height={20} />
            <Skeleton height={14} />
            <Skeleton height={14} />
            <Skeleton height={48} style={{ marginTop: "var(--sp-3)" }} />
          </div>
        </Card>
      )}
    </main>
  );
}

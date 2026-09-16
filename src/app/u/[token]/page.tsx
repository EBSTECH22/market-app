"use client";

import { useState } from "react";
import { Button, Card, Icon, LinkButton, Note } from "@/components/ui";

/**
 * This page used to run db.customer.update({ unsubscribed: true }) while
 * rendering the GET, so link scanners in email clients and browser prefetch
 * unsubscribed people who never clicked. Nothing changes until the reader
 * presses the button below, which POSTs to /api/public/unsubscribe.
 */
export default function UnsubscribePage({ params }: { params: { token: string } }) {
  const [state, setState] = useState<"ask" | "done" | "missing">("ask");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const unsubscribe = async () => {
    setErr("");
    setBusy(true);
    try {
      const res = await fetch("/api/public/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: params.token }),
      });
      const data = await res.json().catch(() => ({}));
      setBusy(false);
      if (res.status === 404) { setState("missing"); return; }
      if (!res.ok) { setErr(data.error || "Couldn't update your preferences — please try again."); return; }
      setState("done");
    } catch {
      setBusy(false);
      setErr("Couldn't reach us just now. Check your connection and try again.");
    }
  };

  return (
    <main className="public-wrap public-narrow">
      <div className="hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 190, maxWidth: "62%", height: "auto", margin: "0 auto var(--sp-4)", display: "block" }} />
        <h1 className="hero-title">
          {state === "done" ? "You're unsubscribed" : state === "missing" ? "Link not found" : "Stop restock emails?"}
        </h1>
        <p className="hero-sub">
          {state === "done"
            ? "No more restock alerts from Community Harvest vendors."
            : state === "missing"
            ? "This unsubscribe link doesn't match anyone — it may have already been used."
            : "Nothing has changed yet. Confirm below and we'll stop sending you vendor restock alerts."}
        </p>
      </div>

      {state === "ask" && (
        <Card title="Before you go">
          <div className="stack g-4">
            <ul className="stack g-2" style={{ margin: 0, paddingLeft: "var(--sp-5)", fontSize: "var(--fs-base)", lineHeight: 1.6 }}>
              <li>You&rsquo;ll stop getting restock alerts from every vendor you follow.</li>
              <li><b>Your reward points are safe</b> and keep working at the register.</li>
              <li>Changed your mind later? Follow a vendor again from their page and alerts come back.</li>
            </ul>

            {err && <Note tone="error">{err}</Note>}

            <Button variant="danger" size="lg" block loading={busy} icon="mail" onClick={unsubscribe}>
              Yes, unsubscribe me
            </Button>
            <LinkButton href="/market" variant="secondary" size="lg" block icon="store">
              No, keep my alerts
            </LinkButton>
          </div>
        </Card>
      )}

      {state === "done" && (
        <Card>
          <div className="stack g-4" style={{ textAlign: "center" }}>
            <span style={{ color: "var(--accent)", display: "block" }}><Icon name="checkCircle" size={34} /></span>
            <p className="t-body t-secondary" style={{ margin: 0 }}>
              Your reward points are safe and keep working at the register. Change your mind? Just follow a vendor
              again from their page.
            </p>
            <LinkButton href="/market" variant="secondary" size="lg" block icon="store">See the market</LinkButton>
          </div>
        </Card>
      )}

      {state === "missing" && (
        <Card>
          <div className="stack g-4">
            <Note tone="warn" title="Nothing to do here">
              If you&rsquo;re still getting emails you don&rsquo;t want, use the unsubscribe link at the bottom of the
              most recent one, or tell any staff member at the market.
            </Note>
            <LinkButton href="/market" variant="secondary" size="lg" block icon="store">See the market</LinkButton>
          </div>
        </Card>
      )}
    </main>
  );
}

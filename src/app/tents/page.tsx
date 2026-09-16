"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge, Button, Card, EmptyState, Field, Icon, Input, LinkButton, Note, SkeletonCard,
} from "@/components/ui";

type D = { id: string; date: string; spotsLeft: number };

const pretty = (iso: string) =>
  new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const monthOf = (iso: string) =>
  new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });

/** 24 tries at 2.5s = one minute of watching for the Stripe webhook to land. */
const POLL_EVERY_MS = 2500;
const POLL_MAX_TRIES = 24;

export default function TentsPage() {
  const [dates, setDates] = useState<D[]>([]);
  const [paused, setPaused] = useState(false);
  const [pausedMsg, setPausedMsg] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pick, setPick] = useState<D | null>(null);
  const [name, setName] = useState("");
  const [biz, setBiz] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [credit, setCredit] = useState("");
  const [manage, setManage] = useState<{ status: string; date: string; name: string } | null>(null);
  const [bookedDate, setBookedDate] = useState("");

  // Status polling after the Stripe redirect.
  const [manageId, setManageId] = useState("");
  const [polling, setPolling] = useState(false);
  const [pollGaveUp, setPollGaveUp] = useState(false);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/public/tents");
    if (r.ok) {
      const d = await r.json();
      setDates(d.dates || []);
      setPaused(!!d.paused);
      setPausedMsg(d.message || "");
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
    setLoaded(true);
  }, []);

  const checkBooking = useCallback(async (id: string) => {
    const r = await fetch(`/api/public/tents/${id}`);
    if (!r.ok) return null;
    const b = (await r.json()).booking as { status: string; date: string; name: string } | null;
    if (b) setManage(b);
    return b;
  }, []);

  useEffect(() => {
    load();
    const q = new URLSearchParams(window.location.search);
    const c = q.get("credit"); if (c) setCredit(c);
    const m = q.get("manage");
    if (m) {
      setManageId(m);
      checkBooking(m);
      if (q.get("done")) setPolling(true);
    }
  }, [load, checkBooking]);

  /**
   * The old version ran an interval for 20 seconds and then cleared it with no
   * trace, so a slow webhook left the page reading "Waiting on your payment…"
   * forever. It now stops on purpose, says so, and offers a manual re-check.
   */
  useEffect(() => {
    if (!polling || !manageId) return;
    let tries = 0;
    const t = setInterval(async () => {
      tries += 1;
      const b = await checkBooking(manageId);
      if (b && b.status !== "RESERVED") { setPolling(false); setPollGaveUp(false); return; }
      if (tries >= POLL_MAX_TRIES) { setPolling(false); setPollGaveUp(true); }
    }, POLL_EVERY_MS);
    return () => clearInterval(t);
  }, [polling, manageId, checkBooking]);

  const checkAgain = async () => {
    if (!manageId) return;
    setChecking(true);
    const b = await checkBooking(manageId);
    setChecking(false);
    if (b && b.status !== "RESERVED") { setPollGaveUp(false); return; }
    setPollGaveUp(true);
  };

  const book = async () => {
    if (!pick) return;
    setMsg(""); setBusy(true);
    const res = await fetch("/api/public/tents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dateId: pick.id, name, businessName: biz, email, phone, creditToken: credit || undefined, website: "" }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setMsg(data.error || "Couldn't book."); return; }
    if (data.booked) { setBookedDate(data.date); return; }
    if (data.url) window.location.href = data.url;
  };

  // grouped by month for a calendar feel
  const groups: { month: string; days: D[] }[] = [];
  for (const d of dates) {
    const m = monthOf(d.date);
    const g = groups.find((x) => x.month === m);
    if (g) g.days.push(d); else groups.push({ month: m, days: [d] });
  }

  return (
    <>
      <header className="public-header">
        <div className="public-header-inner">
          <a href="/market" aria-label="Community Harvest" style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wordmark.png" alt="Community Harvest" style={{ width: 150, maxWidth: "46vw", height: "auto", display: "block" }} />
          </a>
          <LinkButton href="/market" variant="ghost" size="sm" icon="store" className="shrink0">Market</LinkButton>
        </div>
      </header>

      <main className="public-wrap public-narrow">
        <div className="hero">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 110, margin: "0 auto var(--sp-3)", display: "block" }} />
          <h1 className="hero-title">Outdoor tent spots</h1>
          <p className="hero-sub">Community Harvest · Noble, Oklahoma. Book a day outside, hand to hand.</p>
        </div>

        {/* ------------------------------------------------- booking status -- */}
        {manage && (
          <div className="mb-4">
            {manage.status === "PAID_DEPOSIT" || manage.status === "CHECKED_IN" ? (
              <Note tone="success" title="Confirmed">
                {manage.name}, your tent spot is booked for <b>{pretty(manage.date)}</b>. The $12.50 balance is due at
                the front desk when you set up.
              </Note>
            ) : manage.status === "WEATHER_CREDIT" ? (
              <Note tone="warn" title="That date became a weather day">
                Your deposit is now a credit. Pick a new date below — there&rsquo;s no new charge.
              </Note>
            ) : manage.status === "RESERVED" ? (
              pollGaveUp ? (
                <Note
                  tone="warn"
                  title="We still don't see your payment"
                  action={<Button variant="secondary" size="sm" icon="refresh" loading={checking} onClick={checkAgain}>Check again</Button>}
                >
                  Card payments usually confirm within a minute, but they can take longer. Tap <b>Check again</b> — or,
                  if you cancelled at checkout or the card was declined, just pick your date again below. Your spot
                  isn&rsquo;t held until the deposit clears. Still stuck? Call the front desk and we&rsquo;ll sort it out.
                </Note>
              ) : (
                <Note
                  tone="info"
                  title="Waiting on your payment…"
                  action={<Button variant="secondary" size="sm" icon="refresh" loading={checking} onClick={checkAgain}>Check again</Button>}
                >
                  {polling
                    ? "If you finished paying, this updates on its own in a few seconds."
                    : "Tap Check again to see whether your deposit has cleared."}
                </Note>
              )
            ) : (
              <Note tone="neutral" title="Booking status">
                {manage.status}
                <span style={{ display: "block", marginTop: "var(--sp-2)" }}>
                  <Button variant="secondary" size="sm" icon="refresh" loading={checking} onClick={checkAgain}>Check again</Button>
                </span>
              </Note>
            )}
          </div>
        )}

        {credit && !bookedDate && (
          <Note tone="success" title="Weather credit active">
            Pick your new date below — no new deposit needed.
          </Note>
        )}

        {bookedDate ? (
          <Card className="mt-4">
            <div className="stack g-3" style={{ textAlign: "center" }}>
              <span style={{ color: "var(--accent)", display: "block" }}><Icon name="checkCircle" size={34} /></span>
              <h2 className="t-section">Rebooked — see you {pretty(bookedDate)}</h2>
              <p className="t-body t-secondary" style={{ margin: 0 }}>
                Your confirmation is in your email. The $12.50 balance is due at the front desk at setup.
              </p>
              <LinkButton href="/market" variant="secondary" icon="store">Back to the market</LinkButton>
            </div>
          </Card>
        ) : (
          <>
            <Card title="How tent days work" className="mb-4">
              <p className="t-body" style={{ margin: 0, lineHeight: 1.7 }}>
                <b>$25 per day.</b> A <b>$12.50 deposit</b> (half) books your date — the remaining{" "}
                <b>$12.50 is due at the front desk when you set up</b>.{" "}
                <b>Bring your own tent and tables</b> &mdash; the market doesn&rsquo;t supply them. Your tent is manned by
                you all day; outdoor sales are yours, hand to hand. If we call a weather day, your deposit becomes a{" "}
                <b>full credit toward any future date</b>.
              </p>
            </Card>

            {!loaded && <div className="stack g-4"><SkeletonCard lines={4} /><SkeletonCard lines={3} /></div>}

            {loaded && loadFailed && (
              <EmptyState
                icon="alert"
                title="We couldn't load the tent calendar"
                body="Something went wrong on our end. Give it a moment and try again."
                action={<Button variant="secondary" icon="refresh" onClick={load}>Try again</Button>}
              />
            )}

            {loaded && !loadFailed && paused && (
              <Note tone="warn" title="Bookings are paused">
                {pausedMsg || "Tent bookings open soon — check back!"}
              </Note>
            )}

            {loaded && !loadFailed && !paused && groups.length === 0 && (
              <EmptyState
                icon="calendar"
                title="No tent dates are open right now"
                body="New dates get posted as the season fills in — check back soon."
                action={<LinkButton href="/market" variant="secondary" icon="store">See the market</LinkButton>}
              />
            )}

            {loaded && !loadFailed && !paused && groups.map((g) => (
              <Card key={g.month} title={g.month} className="mb-4">
                <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {g.days.map((d) => (
                    <li
                      key={d.id}
                      className="row between g-3 wrap"
                      style={{ padding: "var(--sp-2) 0", borderBottom: "1px solid var(--border)" }}
                    >
                      <span className="row g-2 wrap grow" style={{ minWidth: 140 }}>
                        <b className="t-body">
                          {new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                        </b>
                        <Badge tone={d.spotsLeft <= 2 ? "warn" : "neutral"}>
                          {d.spotsLeft} spot{d.spotsLeft === 1 ? "" : "s"} left
                        </Badge>
                      </span>
                      <Button
                        variant={pick?.id === d.id ? "primary" : "secondary"}
                        size="lg"
                        className="shrink0"
                        aria-pressed={pick?.id === d.id}
                        icon={pick?.id === d.id ? "check" : undefined}
                        onClick={() => { setPick(d); setMsg(""); }}
                      >
                        {pick?.id === d.id ? "Picked" : "Pick"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}

            {pick && (
              <Card
                title={`Book ${pretty(pick.date)}`}
                subtitle={credit
                  ? "Using your weather credit — confirm and you're booked, no charge."
                  : "$12.50 deposit now by card · $12.50 at the front desk on the day."}
              >
                <div className="stack g-4">
                  {!credit && (
                    <>
                      <Field label="Your name">
                        {(p) => <Input {...p} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}
                      </Field>
                      <Field label="Business / booth name" hint="Optional.">
                        {(p) => <Input {...p} autoComplete="organization" value={biz} onChange={(e) => setBiz(e.target.value)} />}
                      </Field>
                      <Field label="Email" hint="Your confirmation goes here.">
                        {(p) => <Input {...p} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
                      </Field>
                      <Field label="Phone">
                        {(p) => <Input {...p} type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
                      </Field>
                    </>
                  )}

                  {msg && <Note tone="error">{msg}</Note>}

                  <Button
                    variant="primary"
                    size="xl"
                    block
                    loading={busy}
                    icon={credit ? "tent" : "card"}
                    onClick={book}
                  >
                    {credit ? "Book with my credit" : "Pay $12.50 deposit & book"}
                  </Button>
                </div>
              </Card>
            )}
          </>
        )}
      </main>
    </>
  );
}

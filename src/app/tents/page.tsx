"use client";

import { useCallback, useEffect, useState } from "react";

type D = { id: string; date: string; spotsLeft: number };

const pretty = (iso: string) =>
  new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const monthOf = (iso: string) =>
  new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });

export default function TentsPage() {
  const [dates, setDates] = useState<D[]>([]);
  const [paused, setPaused] = useState(false);
  const [pausedMsg, setPausedMsg] = useState("");
  const [loaded, setLoaded] = useState(false);
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

  const load = useCallback(async () => {
    const r = await fetch("/api/public/tents");
    if (r.ok) {
      const d = await r.json();
      setDates(d.dates || []);
      setPaused(!!d.paused);
      setPausedMsg(d.message || "");
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const q = new URLSearchParams(window.location.search);
    const c = q.get("credit"); if (c) setCredit(c);
    const m = q.get("manage");
    if (m) {
      const poll = async () => {
        const r = await fetch(`/api/public/tents/${m}`);
        if (r.ok) setManage((await r.json()).booking);
      };
      poll();
      if (q.get("done")) { const t = setInterval(poll, 2500); setTimeout(() => clearInterval(t), 20000); }
    }
  }, [load]);

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
    <main style={{ maxWidth: 520, margin: "0 auto", padding: "26px 14px 70px" }}>
      <div style={{ textAlign: "center", marginBottom: 12 }}>
        <img src="/logo.png" alt="Community Harvest" style={{ width: 120, margin: "0 auto 4px", display: "block" }} />
        <div className="display" style={{ fontSize: 24 }}>OUTDOOR TENT SPOTS ⛺</div>
        <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: "0.08em" }}>COMMUNITY HARVEST · NOBLE, OK</div>
      </div>

      {manage && (
        <div className="card" style={{ marginBottom: 16, textAlign: "center" }}>
          {manage.status === "PAID_DEPOSIT" || manage.status === "CHECKED_IN" ? (
            <p className="ok" style={{ margin: 0 }}>CONFIRMED ✓ — {manage.name}, your tent spot is booked for <b>{pretty(manage.date)}</b>. $12.50 balance at the front desk when you set up.</p>
          ) : manage.status === "WEATHER_CREDIT" ? (
            <p style={{ margin: 0, fontWeight: 700 }}>That date became a weather day — your deposit is a credit. Pick a new date below (no new charge).</p>
          ) : manage.status === "RESERVED" ? (
            <p style={{ margin: 0 }}>Waiting on your payment… if you finished paying, this updates in a few seconds.</p>
          ) : (
            <p style={{ margin: 0 }}>Booking status: {manage.status}</p>
          )}
        </div>
      )}

      {credit && !bookedDate && (
        <div style={{ background: "#111827", color: "#fff", textAlign: "center", padding: "10px 14px", marginBottom: 14, borderRadius: 12, fontWeight: 700, fontSize: 13 }}>
          WEATHER CREDIT ACTIVE — pick your new date below, no new deposit needed.
        </div>
      )}

      {bookedDate ? (
        <div className="card" style={{ textAlign: "center" }}>
          <p className="ok" style={{ fontSize: 16 }}>REBOOKED ✓ — see you {pretty(bookedDate)}!</p>
          <p style={{ fontSize: 13 }}>Confirmation is in your email. $12.50 balance at the front desk at setup.</p>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <p style={{ fontSize: 13, margin: 0, lineHeight: 1.7 }}>
              <b>$25 per day.</b> A <b>$12.50 deposit</b> (half) books your date — the remaining <b>$12.50 is due at the front desk when you set up</b>.
              <b>Bring your own tent and tables</b> &mdash; the market doesn&rsquo;t supply them. Your tent is manned by you all day; outdoor sales are yours, hand to hand.
              If we call a weather day, your deposit becomes a <b>full credit toward any future date</b>.
            </p>
          </div>

          {!loaded && <p style={{ textAlign: "center" }}>Loading dates…</p>}
          {loaded && paused && (
            <div style={{ background: "#111827", color: "#fff", textAlign: "center", padding: "16px 14px", marginBottom: 14, borderRadius: 14 }}>
              <div className="display" style={{ fontSize: 18 }}>BOOKINGS PAUSED</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>{pausedMsg || "Tent bookings open soon — check back!"}</div>
            </div>
          )}
          {loaded && !paused && groups.length === 0 && (
            <p style={{ textAlign: "center", color: "var(--ash)" }}>No tent dates are open for booking right now — check back soon.</p>
          )}

          {groups.map((g) => (
            <div key={g.month} className="card" style={{ marginBottom: 12 }}>
              <h2 className="display" style={{ fontSize: 16, marginBottom: 6 }}>{g.month.toUpperCase()}</h2>
              {g.days.map((d) => (
                <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ fontSize: 13.5 }}>
                    <b>{new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</b>
                    <span style={{ color: "var(--ash)" }}> · {d.spotsLeft} spot{d.spotsLeft === 1 ? "" : "s"} left</span>
                  </span>
                  <button className={`btn small ${pick?.id === d.id ? "" : "ghost"}`} onClick={() => { setPick(d); setMsg(""); }}>
                    {pick?.id === d.id ? "PICKED ✓" : "PICK"}
                  </button>
                </div>
              ))}
            </div>
          ))}

          {pick && (
            <div className="card">
              <h2 className="display" style={{ fontSize: 16, marginBottom: 4 }}>BOOK {pretty(pick.date).toUpperCase()}</h2>
              {credit ? (
                <p style={{ fontSize: 13 }}>Using your weather credit — confirm and you&rsquo;re booked, no charge.</p>
              ) : (
                <p style={{ fontSize: 13 }}>$12.50 deposit now by card · $12.50 at the front desk on the day.</p>
              )}
              {!credit && (
                <>
                  <label>Your name</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                  <label>Business / booth name (optional)</label>
                  <input value={biz} onChange={(e) => setBiz(e.target.value)} />
                  <label>Email (confirmation goes here)</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  <label>Phone</label>
                  <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </>
              )}
              <div style={{ marginTop: 12 }}>
                <button className="btn" disabled={busy} onClick={book}>
                  {credit ? "⛺ BOOK WITH MY CREDIT" : "💳 PAY $12.50 DEPOSIT & BOOK"}
                </button>
              </div>
              {msg && <p className="err">{msg}</p>}
            </div>
          )}
        </>
      )}
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";

export default function VendorLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState<"IOS" | "ANDROID" | "OTHER" | "INSTALLED">("OTHER");
  const [installEvt, setInstallEvt] = useState<{ prompt: () => Promise<void> } | null>(null);

  useEffect(() => {
    // which phone is this, and is the app already on the home screen?
    const ua = navigator.userAgent;
    const standalone = window.matchMedia("(display-mode: standalone)").matches
      || (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) setPlatform("INSTALLED");
    else if (/iPhone|iPad|iPod/i.test(ua)) setPlatform("IOS");
    else if (/Android/i.test(ua)) setPlatform("ANDROID");
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as unknown as { prompt: () => Promise<void> });
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  useEffect(() => {
    // already logged in? go to the dashboard
    fetch("/api/vendor/me").then((r) => { if (r.ok) window.location.href = "/vendor"; });
  }, []);

  const login = async () => {
    setError(""); setBusy(true);
    const res = await fetch("/api/vendor/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Login failed.");
      return;
    }
    window.location.href = "/vendor";
  };

  return (
    <main style={{ maxWidth: 400, margin: "0 auto", padding: "70px 18px" }}>
      <div style={{ textAlign: "center", marginBottom: 22 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="Community Harvest" style={{ width: 150, height: 150, marginBottom: 12 }} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 270, maxWidth: "82%", height: "auto", margin: "2px auto 4px", display: "block" }} />
        <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: "0.08em" }}>FOOD AND CRAFT MARKET</div>
        <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ash)", marginTop: 2 }}>Vendor Portal</div>
      </div>
      <div className="card">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && login()} />
        <div style={{ marginTop: 16 }}>
          <button className="btn" disabled={busy} onClick={login}>LOG IN</button>
        </div>
        {error && <p className="err">{error}</p>}
        <p style={{ fontSize: 12, color: "var(--ash)", marginTop: 12 }}>
          No account yet? Booth space is $150/mo for a 5×5 — ask at the market or email us.
        </p>
      </div>

      {platform === "IOS" && (
        <div className="card" style={{ marginTop: 14, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
          <b style={{ fontSize: 13.5 }}>📱 Put this on your home screen (2 minutes)</b>
          <ol style={{ fontSize: 12.5, margin: "6px 0 0 18px", lineHeight: 1.8, listStyle: "decimal" }}>
            <li>Tap the <b>Share</b> button below — the square with the up arrow</li>
            <li>Scroll down, tap <b>&ldquo;Add to Home Screen,&rdquo;</b> then <b>Add</b></li>
            <li>Open the new 🌾 icon — you&rsquo;ll get a real app, and sale alerts can buzz your phone</li>
          </ol>
          <p style={{ fontSize: 11.5, color: "var(--ash)", marginTop: 6 }}>Full guide with everything else: <a href="/guide"><b>market.dailybreadbaked.com/guide</b></a></p>
        </div>
      )}

      {platform === "ANDROID" && (
        <div className="card" style={{ marginTop: 14, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
          <b style={{ fontSize: 13.5 }}>🤖 Put this on your home screen (2 minutes)</b>
          {installEvt ? (
            <div style={{ marginTop: 8 }}>
              <button className="btn small" onClick={() => installEvt.prompt()}>⬇️ INSTALL THE APP — ONE TAP</button>
            </div>
          ) : (
            <ol style={{ fontSize: 12.5, margin: "6px 0 0 18px", lineHeight: 1.8, listStyle: "decimal" }}>
              <li>Tap the <b>⋮ menu</b> in the top-right corner of Chrome</li>
              <li>Tap <b>&ldquo;Add to Home screen&rdquo;</b> (or <b>&ldquo;Install app&rdquo;</b>) and confirm</li>
              <li>Open the new 🌾 icon — real app, and sale alerts can buzz your phone</li>
            </ol>
          )}
          <p style={{ fontSize: 11.5, color: "var(--ash)", marginTop: 6 }}>Full guide with everything else: <a href="/guide"><b>market.dailybreadbaked.com/guide</b></a></p>
        </div>
      )}

      {platform === "OTHER" && (
        <p style={{ textAlign: "center", fontSize: 12, color: "var(--ash)", marginTop: 12 }}>
          Setting up on your phone? The full vendor guide is at <a href="/guide"><b>/guide</b></a>
        </p>
      )}
    </main>
  );
}

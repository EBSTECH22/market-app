"use client";

import { useEffect, useState } from "react";

export default function VendorLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
        <div className="display" style={{ fontSize: 30 }}>THE MARKET AT NOBLE</div>
        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ash)" }}>Vendor Portal · homegrown &amp; homemade</div>
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
    </main>
  );
}

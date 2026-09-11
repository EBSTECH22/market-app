"use client";

import { useEffect, useState } from "react";

type V = {
  code: string; businessName: string; publicBlurb: string;
  acceptsPreorders: boolean; acceptsRequests: boolean;
  items: { name: string; priceCents: number; quantity: number }[];
  rating: { avg: number; n: number } | null;
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function MarketDirectory() {
  const [vendors, setVendors] = useState<V[]>([]);
  const [q, setQ] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [banner, setBanner] = useState<{ enabled: boolean; title: string; dateLine: string; message: string } | null>(null);

  useEffect(() => {
    fetch("/api/public/banner").then(async (r) => { if (r.ok) setBanner((await r.json()).banner); }).catch(() => {});
    fetch("/api/public/market").then(async (r) => {
      if (r.ok) setVendors((await r.json()).vendors || []);
      setLoaded(true);
    });
  }, []);

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? vendors.filter((v) => v.businessName.toLowerCase().includes(needle) || v.items.some((i) => i.name.toLowerCase().includes(needle)))
    : vendors;

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "26px 14px 70px" }}>
      <div style={{ textAlign: "center", marginBottom: 14 }}>
        <img src="/logo-receipt.png" alt="Community Harvest" style={{ width: 130, margin: "0 auto 4px", display: "block" }} />
        <div className="display" style={{ fontSize: 26 }}>COMMUNITY HARVEST</div>
        <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: "0.08em" }}>FOOD AND CRAFT MARKET · NOBLE, OK</div>
        <p style={{ fontSize: 13, color: "var(--ash)", marginTop: 6 }}>Live list — what our vendors have on the floor right now.</p>
        <a href="/apply" style={{ fontSize: 12, fontWeight: 700, color: "#000" }}>Want a booth? Apply to become a vendor →</a>
      </div>

      {banner?.enabled && (
        <div style={{ background: "#000", color: "#fff", textAlign: "center", padding: "18px 14px", marginBottom: 16 }}>
          <div className="display" style={{ fontSize: 26, letterSpacing: "0.04em" }}>{banner.title}</div>
          <div className="display" style={{ fontSize: 17, marginTop: 6 }}>{banner.dateLine}</div>
          {banner.message && <div style={{ fontSize: 13, marginTop: 8 }}>{banner.message}</div>}
          <a href="/apply" style={{ color: "#fff", fontSize: 13, fontWeight: 700, display: "inline-block", marginTop: 8 }}>Become a vendor →</a>
        </div>
      )}

      <input placeholder="Search vendors or products… (honey, bread, candles)" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 14 }} />

      {loaded && shown.length === 0 && <p style={{ textAlign: "center", color: "var(--ash)" }}>Nothing matches.</p>}
      {shown.map((v) => (
        <div className="card" key={v.code} style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <a href={`/v/${v.code}`} className="display" style={{ fontSize: 17, color: "#000", textDecoration: "none" }}>{v.businessName.toUpperCase()}</a>
            <span style={{ fontSize: 12, fontWeight: 700 }}>
              {v.rating ? `★ ${v.rating.avg} (${v.rating.n})` : ""}
            </span>
          </div>
          {v.publicBlurb && <p style={{ fontSize: 12.5, color: "var(--ash)", margin: "2px 0 6px" }}>{v.publicBlurb}</p>}
          {v.items.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--ash)" }}>Nothing on the floor right now.</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {v.items.slice(0, 12).map((i) => (
                <span key={i.name} style={{ border: "1px solid #000", padding: "3px 8px", fontSize: 12 }}>
                  {i.name} · {money(i.priceCents)}{i.quantity <= 3 ? ` · ${i.quantity} left` : ""}
                </span>
              ))}
              {v.items.length > 12 && <span style={{ fontSize: 12, padding: "3px 4px" }}>+{v.items.length - 12} more…</span>}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <a className="btn small ghost" href={`/v/${v.code}`}>
              REVIEWS{v.acceptsPreorders ? " · PRE-ORDER" : ""}{v.acceptsRequests ? " · REQUESTS" : ""} →
            </a>
          </div>
        </div>
      ))}
    </main>
  );
}

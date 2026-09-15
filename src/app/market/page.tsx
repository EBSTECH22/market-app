"use client";

import { useEffect, useState } from "react";
import { usePulse } from "@/lib/usePulse";

type V = {
  code: string; businessName: string; publicBlurb: string;
  acceptsPreorders: boolean; acceptsRequests: boolean;
  items: { name: string; priceCents: number; basePriceCents?: number; salePercent?: number; quantity: number }[];
  rating: { avg: number; n: number } | null;
  logoId: string | null;
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function MarketDirectory() {
  const [vendors, setVendors] = useState<V[]>([]);
  const [q, setQ] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [banner, setBanner] = useState<{ enabled: boolean; title: string; dateLine: string; message: string } | null>(null);
  const [feed, setFeed] = useState<{ id: string; body: string; photoId: string | null; createdAt: string; vendor: { code: string; businessName: string; logoId: string | null } }[]>([]);

  useEffect(() => {
    const loadMarket = () => {
      fetch("/api/public/market").then(async (r) => {
        if (r.ok) setVendors((await r.json()).vendors || []);
        setLoaded(true);
      });
    };
    fetch("/api/public/banner").then(async (r) => { if (r.ok) setBanner((await r.json()).banner); }).catch(() => {});
    const loadFeed = () => fetch("/api/public/feed").then(async (r) => { if (r.ok) setFeed((await r.json()).posts); }).catch(() => {});
    loadFeed();
    loadMarket();
    (window as unknown as { __lm?: () => void }).__lm = () => { loadMarket(); loadFeed(); };
  }, []);
  usePulse(() => (window as unknown as { __lm?: () => void }).__lm?.());

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? vendors.filter((v) => v.businessName.toLowerCase().includes(needle) || v.items.some((i) => i.name.toLowerCase().includes(needle)))
    : vendors;

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "26px 14px 70px" }}>
      <div style={{ textAlign: "center", marginBottom: 14 }}>
        <img src="/logo.png" alt="Community Harvest" style={{ width: 130, margin: "0 auto 4px", display: "block" }} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 270, maxWidth: "82%", height: "auto", margin: "2px auto 4px", display: "block" }} />
        <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: "0.08em" }}>FOOD AND CRAFT MARKET · NOBLE, OK</div>
        <p style={{ fontSize: 13, color: "var(--ash)", marginTop: 6 }}>Live list — what our vendors have on the floor right now.</p>

      </div>

      {banner?.enabled && (
        <div style={{ position: "relative", background: "#111827", color: "#fff", textAlign: "center", padding: "22px 96px 18px 20px", marginBottom: 16, borderRadius: 16 }}>
          <div style={{ position: "absolute", top: 14, right: -12, width: 120, height: 120, background: "#111827", border: "2px dashed rgba(255,255,255,0.75)", borderRadius: "50%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, transform: "rotate(12deg)", boxShadow: "0 10px 24px rgba(0,0,0,0.28)", zIndex: 2 }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.13em", color: "#fff" }}>SPONSORED BY</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/sponsor-lightfoot.png" alt="Lightfoot Roofs" style={{ width: "72%", height: "auto", display: "block" }} />
          </div>
          <div className="display" style={{ fontSize: 26, letterSpacing: "0.04em" }}>{banner.title}</div>
          <div className="display" style={{ fontSize: 17, marginTop: 6 }}>{banner.dateLine}</div>
          {banner.message && <div style={{ fontSize: 13, marginTop: 8 }}>{banner.message}</div>}
          <a href="/apply" style={{ color: "#fff", fontSize: 13, fontWeight: 700, display: "inline-block", marginTop: 8 }}>Become a vendor →</a>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <a href="/tents" className="btn" style={{ flex: 1, textAlign: "center", textDecoration: "none" }}>⛺ BOOK A TENT</a>
        <a href="/apply" className="btn ghost" style={{ flex: 1, textAlign: "center", textDecoration: "none" }}>BECOME A VENDOR</a>
      </div>

      <input placeholder="Search vendors or products… (honey, bread, candles)" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 14 }} />

      {!loaded && (
        <div>
          <div className="skel" style={{ height: 120, marginBottom: 12 }} />
          <div className="skel" style={{ height: 120, marginBottom: 12 }} />
          <div className="skel" style={{ height: 120 }} />
        </div>
      )}
      {loaded && shown.length === 0 && <p style={{ textAlign: "center", color: "var(--ash)" }}>Nothing matches.</p>}
      {feed.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h2 className="display" style={{ fontSize: 17, marginBottom: 8 }}>📣 FRESH FROM OUR VENDORS</h2>
          <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 6 }}>
            {feed.slice(0, 12).map((po) => (
              <a key={po.id} href={`/v/${po.vendor.code}`} style={{ flex: "0 0 auto", width: 250, textDecoration: "none", color: "inherit" }}>
                <div className="card" style={{ height: "100%" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    {po.vendor.logoId
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={`/api/public/photo/${po.vendor.logoId}`} alt="" style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--border)" }} />
                      : <span style={{ width: 28, height: 28, borderRadius: "50%", background: "#111827", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800 }}>{po.vendor.businessName.slice(0, 1)}</span>}
                    <b style={{ fontSize: 12.5 }}>{po.vendor.businessName}</b>
                  </div>
                  <p style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{po.body}</p>
                  <div style={{ fontSize: 10.5, color: "var(--ash)", marginTop: 6 }}>{new Date(po.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })} · tap to visit</div>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
      {shown.map((v) => (
        <a href={`/v/${v.code}`} key={v.code} className="cardlink" style={{ padding: "14px 16px", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {v.logoId && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={`/api/public/photo/${v.logoId}`} alt="" style={{ height: 44, width: "auto", maxWidth: 90, display: "block" }} />
              )}
              <span className="display" style={{ fontSize: 17 }}>{v.businessName.toUpperCase()}</span>
            </span>
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
                <span key={i.name} style={{ border: "1px solid var(--border)", borderRadius: 999, background: "#f9fafb", padding: "4px 11px", fontSize: 12 }}>
                  {i.name} · {(i.salePercent || 0) > 0 && <s style={{ color: "var(--ash)" }}>{money(i.basePriceCents || i.priceCents)}</s>}{(i.salePercent || 0) > 0 ? " " : ""}<b style={(i.salePercent || 0) > 0 ? { color: "var(--red)" } : {}}>{money(i.priceCents)}</b>{(i.salePercent || 0) > 0 ? ` · ${i.salePercent}% OFF` : ""}{i.quantity <= 3 ? ` · ${i.quantity} left` : ""}
                </span>
              ))}
              {v.items.length > 12 && <span style={{ fontSize: 12, padding: "3px 4px" }}>+{v.items.length - 12} more…</span>}
            </div>
          )}
          <div style={{ marginTop: 10, fontWeight: 800, fontSize: 13, letterSpacing: "0.04em" }}>
            VIEW BOOTH — REVIEWS{v.acceptsPreorders ? " · PRE-ORDER" : ""}{v.acceptsRequests ? " · REQUESTS" : ""} →
          </div>
        </a>
      ))}
    </main>
  );
}

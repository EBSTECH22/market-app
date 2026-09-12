"use client";

import { useCallback, useEffect, useState } from "react";

type Comment = { id: string; name: string; body: string; likes: number; createdAt: string };
type Review = { id: string; name: string; rating: number; body: string; likes: number; createdAt: string; comments: Comment[] };
type Vendor = { code: string; businessName: string; publicBlurb: string; acceptsPreorders: boolean; acceptsRequests: boolean };
type Item = { name: string; priceCents: number; basePriceCents?: number; salePercent?: number; quantity: number; photoId?: string | null };

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);
const liked = (id: string) => { try { return window.localStorage.getItem(`ch_like_${id}`) === "1"; } catch { return false; } };
const markLiked = (id: string) => { try { window.localStorage.setItem(`ch_like_${id}`, "1"); } catch {} };

export default function VendorPublicPage({ params }: { params: { code: string } }) {
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [followOpen, setFollowOpen] = useState(false);
  const [followEmail, setFollowEmail] = useState("");
  const [followMsg, setFollowMsg] = useState("");
  const [followDone, setFollowDone] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [logoId, setLogoId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [missing, setMissing] = useState(false);

  // review form
  const [rvName, setRvName] = useState("");
  const [rvRating, setRvRating] = useState(5);
  const [rvBody, setRvBody] = useState("");
  const [rvMsg, setRvMsg] = useState("");
  // comment forms (per review)
  const [cmOpen, setCmOpen] = useState<string | null>(null);
  const [cmName, setCmName] = useState("");
  const [cmBody, setCmBody] = useState("");
  // message form
  const [msgType, setMsgType] = useState<"" | "PREORDER" | "REQUEST" | "COMPLAINT">("");
  const [mName, setMName] = useState("");
  const [mEmail, setMEmail] = useState("");
  const [mPhone, setMPhone] = useState("");
  const [mBody, setMBody] = useState("");
  const [mMsg, setMMsg] = useState("");
  const [mSent, setMSent] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/public/vendor/${params.code}`);
    if (!res.ok) { setMissing(true); return; }
    const data = await res.json();
    setVendor(data.vendor); setItems(data.items); setReviews(data.reviews); setPhotos(data.photos || []); setLogoId(data.logoId || null);
  }, [params.code]);

  useEffect(() => { load(); }, [load]);

  const postReview = async () => {
    setRvMsg("");
    const res = await fetch(`/api/public/vendor/${params.code}/review`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: rvName, rating: rvRating, body: rvBody, website: "" }),
    });
    const data = await res.json();
    if (!res.ok) { setRvMsg(data.error || "Couldn't post."); return; }
    setRvName(""); setRvBody(""); setRvRating(5); setRvMsg("Posted. ✓");
    await load();
  };

  const postComment = async (reviewId: string) => {
    const res = await fetch(`/api/public/review/${reviewId}/comment`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: cmName, body: cmBody, website: "" }),
    });
    if (res.ok) { setCmOpen(null); setCmName(""); setCmBody(""); await load(); }
  };

  const like = async (kind: "review" | "comment", id: string) => {
    if (liked(id)) return;
    markLiked(id);
    await fetch(`/api/public/${kind}/${id}/like`, { method: "POST" });
    await load();
  };

  const sendMessage = async () => {
    setMMsg("");
    const res = await fetch(`/api/public/vendor/${params.code}/thread`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: msgType, name: mName, email: mEmail, phone: mPhone, body: mBody, website: "" }),
    });
    const data = await res.json();
    if (!res.ok) { setMMsg(data.error || "Couldn't send."); return; }
    setMSent(true);
  };

  if (missing) return <main style={{ padding: 60, textAlign: "center" }}>Vendor not found.</main>;
  const doFollow = async () => {
    setFollowMsg("");
    const r = await fetch("/api/public/follow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vendorCode: vendor?.code, email: followEmail }) });
    const d = await r.json();
    if (!r.ok) { setFollowMsg(d.error || "Couldn't sign you up."); return; }
    setFollowDone(true);
  };

  if (!vendor) return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "26px 14px" }}>
      <div className="skel" style={{ width: 180, height: 26, margin: "0 auto 14px" }} />
      <div className="skel" style={{ height: 150, marginBottom: 14 }} />
      <div className="skel" style={{ height: 190, marginBottom: 14 }} />
      <div className="skel" style={{ height: 240 }} />
    </main>
  );

  const avg = reviews.length ? Math.round((reviews.reduce((n, r) => n + r.rating, 0) / reviews.length) * 10) / 10 : null;

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "26px 14px 70px" }}>
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/wordmark.png" alt="Community Harvest" style={{ width: 104, height: "auto", display: "block", opacity: 0.85 }} />
        </div>
        <div style={{ textAlign: "center" }}>
        {logoId ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={`/api/public/photo/${logoId}`} alt={vendor.businessName} style={{
            width: 132, height: 132, borderRadius: "50%", objectFit: "contain", background: "#fff",
            border: "1px solid var(--border)", boxShadow: "0 4px 14px rgba(0,0,0,0.1)", padding: 14,
            margin: "0 auto 10px", display: "block",
          }} />
        ) : (
          <div style={{
            width: 132, height: 132, borderRadius: "50%", background: "linear-gradient(135deg, #111827 0%, #1f2937 100%)",
            color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 44, fontWeight: 800, letterSpacing: "-0.02em",
            boxShadow: "0 4px 14px rgba(0,0,0,0.12)", margin: "0 auto 10px",
          }}>
            {vendor.businessName.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}
          </div>
        )}
        <div className="display" style={{ fontSize: 24 }}>{vendor.businessName.toUpperCase()}</div>
        {avg !== null && <div style={{ fontSize: 13, fontWeight: 700 }}>{stars(Math.round(avg))} {avg} · {reviews.length} review{reviews.length === 1 ? "" : "s"}</div>}
        {vendor.publicBlurb && <p style={{ fontSize: 13, color: "var(--ash)", marginTop: 6 }}>{vendor.publicBlurb}</p>}
        <div style={{ fontSize: 11, color: "var(--ash)", marginTop: 4 }}>at Community Harvest — Food and Craft Market, Noble OK · <a href="/market">all vendors</a></div>
        <div style={{ marginTop: 10 }}>
          {!followOpen && !followDone && (
            <button className="btn small ghost" onClick={() => setFollowOpen(true)}>🔔 GET RESTOCK ALERTS</button>
          )}
          {followOpen && !followDone && (
            <div style={{ maxWidth: 320, margin: "0 auto" }}>
              <div style={{ display: "flex", gap: 6 }}>
                <input type="email" placeholder="you@example.com" value={followEmail} onChange={(e) => setFollowEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doFollow()} />
                <button className="btn small" style={{ flex: "0 0 auto" }} onClick={doFollow}>🔔 FOLLOW</button>
              </div>
              {followMsg && <p className="err" style={{ marginTop: 6 }}>{followMsg}</p>}
              <p style={{ fontSize: 10.5, color: "var(--ash)", marginTop: 4 }}>One email when they restock, max once a day. Unsubscribe anytime.</p>
            </div>
          )}
          {followDone && <p className="ok" style={{ display: "inline-block" }}>🔔 You're in — we'll email you when {vendor.businessName} restocks ✓</p>}
        </div>
        </div>
      </div>

      {photos.length > 0 && (
        <div style={{ display: "flex", gap: 8, overflowX: "auto", marginBottom: 16, paddingBottom: 4 }}>
          {photos.map((id) => (
            /* eslint-disable-next-line @next/next/no-img-element */
            <button key={id} onClick={() => setLightbox({ src: `/api/public/photo/${id}`, alt: "Product photo" })} style={{ flex: "0 0 auto", padding: 0, border: "none", background: "none", cursor: "zoom-in" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/public/photo/${id}`} alt="Product photo" style={{ height: 150, width: "auto", border: "1px solid var(--border)", display: "block" }} />
            </button>
          ))}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 6 }}>AT THE MARKET RIGHT NOW</h2>
        {items.length === 0 && <p style={{ fontSize: 13, color: "var(--ash)" }}>Nothing on the floor at the moment — check back or send a request below.</p>}
        {items.map((i) => (
          <div key={i.name} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 14 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>{i.photoId && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/public/photo/${i.photoId}`} alt={i.name} onClick={() => setLightbox({ src: `/api/public/photo/${i.photoId}`, alt: i.name })} style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)", flex: "0 0 auto", cursor: "zoom-in" }} />
            )}{i.name}{i.quantity <= 3 ? <b> · only {i.quantity} left</b> : ""}</span>
            <span>{(i.salePercent || 0) > 0 && <><s style={{ color: "var(--ash)", fontWeight: 400 }}>{money(i.basePriceCents || i.priceCents)}</s>{" "}<span style={{ background: "#fef2f2", color: "var(--red)", border: "1px solid #fecaca", borderRadius: 999, fontSize: 10, fontWeight: 800, padding: "1px 7px", marginRight: 6 }}>{i.salePercent}% OFF</span></>}<b style={(i.salePercent || 0) > 0 ? { color: "var(--red)" } : {}}>{money(i.priceCents)}</b></span>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 6 }}>MESSAGE THIS VENDOR</h2>
        {mSent ? (
          <p className="ok" style={{ marginTop: 0 }}>Sent. ✓ Check your email — your private conversation link is there, and replies will land in the same place.</p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {vendor.acceptsPreorders && <button className={`btn small ${msgType === "PREORDER" ? "" : "ghost"}`} onClick={() => setMsgType("PREORDER")}>PRE-ORDER</button>}
              {vendor.acceptsRequests && <button className={`btn small ${msgType === "REQUEST" ? "" : "ghost"}`} onClick={() => setMsgType("REQUEST")}>REQUEST</button>}
              <button className={`btn small ${msgType === "COMPLAINT" ? "" : "ghost"}`} onClick={() => setMsgType("COMPLAINT")}>COMPLAINT</button>
            </div>
            {!vendor.acceptsPreorders && !vendor.acceptsRequests && (
              <p style={{ fontSize: 11.5, color: "var(--ash)", marginTop: 6 }}>This vendor isn&rsquo;t taking pre-orders or requests right now; complaints always go through.</p>
            )}
            {msgType && (
              <>
                <label>Your name</label>
                <input value={mName} onChange={(e) => setMName(e.target.value)} />
                <label>Email (the conversation happens here)</label>
                <input type="email" value={mEmail} onChange={(e) => setMEmail(e.target.value)} />
                <label>Phone</label>
                <input type="tel" value={mPhone} onChange={(e) => setMPhone(e.target.value)} />
                <label>{msgType === "PREORDER" ? "What would you like to order?" : msgType === "REQUEST" ? "What are you looking for?" : "What went wrong?"}</label>
                <textarea rows={4} value={mBody} onChange={(e) => setMBody(e.target.value)} />
                <div style={{ marginTop: 12 }}><button className="btn" onClick={sendMessage}>SEND PRIVATELY</button></div>
                <p style={{ fontSize: 11, color: "var(--ash)", marginTop: 6 }}>Private — only the vendor sees this{msgType === "COMPLAINT" ? " (and the market runs a copy for accountability)" : ""}.</p>
              </>
            )}
            {mMsg && <p className="err">{mMsg}</p>}
          </>
        )}
      </div>

      <div className="card">
        <h2 className="display" style={{ fontSize: 16, marginBottom: 6 }}>REVIEWS</h2>
        {reviews.map((r) => (
          <div key={r.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <b style={{ fontSize: 14 }}>{r.name}</b>
              <span style={{ fontSize: 13 }}>{stars(r.rating)}</span>
            </div>
            <p style={{ fontSize: 13.5, margin: "4px 0" }}>{r.body}</p>
            <div style={{ display: "flex", gap: 10, fontSize: 12 }}>
              <button className="btn small ghost" onClick={() => like("review", r.id)} disabled={liked(r.id)}>
                ♥ {r.likes}{liked(r.id) ? " · liked" : ""}
              </button>
              <button className="btn small ghost" onClick={() => { setCmOpen(cmOpen === r.id ? null : r.id); setCmName(""); setCmBody(""); }}>
                💬 REPLY{r.comments.length ? ` (${r.comments.length})` : ""}
              </button>
            </div>
            {r.comments.map((c) => (
              <div key={c.id} style={{ marginLeft: 16, marginTop: 8, paddingLeft: 10, borderLeft: "2px solid var(--border)" }}>
                <b style={{ fontSize: 12.5 }}>{c.name}</b>
                <p style={{ fontSize: 12.5, margin: "2px 0" }}>{c.body}</p>
                <button className="btn small ghost" onClick={() => like("comment", c.id)} disabled={liked(c.id)} style={{ fontSize: 11 }}>
                  ♥ {c.likes}
                </button>
              </div>
            ))}
            {cmOpen === r.id && (
              <div style={{ marginLeft: 16, marginTop: 8 }}>
                <label>Your name</label>
                <input value={cmName} onChange={(e) => setCmName(e.target.value)} />
                <label>Reply</label>
                <textarea rows={2} value={cmBody} onChange={(e) => setCmBody(e.target.value)} />
                <div style={{ marginTop: 8 }}><button className="btn small" onClick={() => postComment(r.id)}>POST REPLY</button></div>
              </div>
            )}
          </div>
        ))}
        {reviews.length === 0 && <p style={{ fontSize: 13, color: "var(--ash)" }}>No reviews yet — be the first.</p>}

        <h3 className="display" style={{ fontSize: 14, margin: "16px 0 4px" }}>WRITE A REVIEW</h3>
        <label>Your name</label>
        <input value={rvName} onChange={(e) => setRvName(e.target.value)} />
        <label>Rating</label>
        <div style={{ display: "flex", gap: 4 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={`btn small ${rvRating >= n ? "" : "ghost"}`} onClick={() => setRvRating(n)}>★</button>
          ))}
        </div>
        <label>Your review</label>
        <textarea rows={3} value={rvBody} onChange={(e) => setRvBody(e.target.value)} />
        <div style={{ marginTop: 12 }}><button className="btn small" onClick={postReview}>POST REVIEW</button></div>
        {rvMsg && <p className={rvMsg.includes("✓") ? "ok" : "err"}>{rvMsg}</p>}
      </div>
      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </main>
  );
}

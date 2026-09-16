"use client";

import { useCallback, useEffect, useState } from "react";
import Lightbox from "@/components/Lightbox";
import {
  Badge, Button, Card, EmptyState, Field, Icon, Input, LinkButton, Note,
  SkeletonCard, Textarea, useToast,
} from "@/components/ui";
import { money, plural, relTime } from "@/lib/format";

type Comment = { id: string; name: string; body: string; likes: number; createdAt: string };
type Review = { id: string; name: string; rating: number; body: string; likes: number; createdAt: string; comments: Comment[] };
type Vendor = { code: string; businessName: string; publicBlurb: string; acceptsPreorders: boolean; acceptsRequests: boolean };
type Item = { name: string; priceCents: number; basePriceCents?: number; salePercent?: number; quantity: number; photoId?: string | null };

const liked = (id: string) => { try { return window.localStorage.getItem(`ch_like_${id}`) === "1"; } catch { return false; } };
const markLiked = (id: string) => { try { window.localStorage.setItem(`ch_like_${id}`, "1"); } catch {} };

/** A star rating rendered as icons, with the number spoken for assistive tech. */
function Stars({ n, size = 14 }: { n: number; size?: number }) {
  return (
    <span className="row g-1" role="img" aria-label={`${n} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Icon
          key={i}
          name="star"
          size={size}
          style={{ color: i <= n ? "var(--warn)" : "var(--border-strong)", fill: i <= n ? "var(--warn)" : "none" }}
        />
      ))}
    </span>
  );
}

export default function VendorPublicPage({ params }: { params: { code: string } }) {
  const toast = useToast();
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
  const [rvBusy, setRvBusy] = useState(false);
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
  const [mBusy, setMBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/public/vendor/${params.code}`);
    if (!res.ok) { setMissing(true); return; }
    const data = await res.json();
    setVendor(data.vendor); setItems(data.items); setReviews(data.reviews); setPhotos(data.photos || []); setLogoId(data.logoId || null);
  }, [params.code]);

  useEffect(() => { load(); }, [load]);

  const postReview = async () => {
    setRvMsg("");
    setRvBusy(true);
    const res = await fetch(`/api/public/vendor/${params.code}/review`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: rvName, rating: rvRating, body: rvBody, website: "" }),
    });
    const data = await res.json();
    setRvBusy(false);
    if (!res.ok) { setRvMsg(data.error || "Couldn't post."); return; }
    setRvName(""); setRvBody(""); setRvRating(5); setRvMsg("");
    toast.success("Review posted", "Thanks for telling other shoppers about this booth.");
    await load();
  };

  const postComment = async (reviewId: string) => {
    const res = await fetch(`/api/public/review/${reviewId}/comment`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: cmName, body: cmBody, website: "" }),
    });
    if (res.ok) { setCmOpen(null); setCmName(""); setCmBody(""); await load(); }
    else toast.error("Couldn't post that reply", "Give it another try in a moment.");
  };

  const like = async (kind: "review" | "comment", id: string) => {
    if (liked(id)) return;
    markLiked(id);
    await fetch(`/api/public/${kind}/${id}/like`, { method: "POST" });
    await load();
  };

  const sendMessage = async () => {
    setMMsg("");
    setMBusy(true);
    const res = await fetch(`/api/public/vendor/${params.code}/thread`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: msgType, name: mName, email: mEmail, phone: mPhone, body: mBody, website: "" }),
    });
    const data = await res.json();
    setMBusy(false);
    if (!res.ok) { setMMsg(data.error || "Couldn't send."); return; }
    setMSent(true);
  };

  const share = async () => {
    if (typeof window === "undefined") return;
    const url = window.location.href;
    const title = vendor ? `${vendor.businessName} — Community Harvest` : "Community Harvest";
    const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string; url?: string }) => Promise<void> };
    if (typeof nav.share === "function") {
      try {
        await nav.share({ title, text: vendor?.publicBlurb || undefined, url });
        return;
      } catch (err) {
        // The user tapping "cancel" in the OS sheet is not a failure.
        if ((err as { name?: string })?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied", "Paste it anywhere to send someone straight to this booth.");
    } catch {
      toast.error("Couldn't copy the link", url);
    }
  };

  if (missing) {
    return (
      <main className="public-wrap public-narrow">
        <EmptyState
          icon="store"
          title="Vendor not found"
          body="That booth code doesn't match anyone at the market — it may have moved on."
          action={<LinkButton href="/market" variant="primary" icon="store">See all vendors</LinkButton>}
        />
      </main>
    );
  }

  const doFollow = async () => {
    setFollowMsg("");
    const r = await fetch("/api/public/follow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vendorCode: vendor?.code, email: followEmail }) });
    const d = await r.json();
    if (!r.ok) { setFollowMsg(d.error || "Couldn't sign you up."); return; }
    setFollowDone(true);
  };

  if (!vendor) {
    return (
      <main className="public-wrap public-narrow">
        <div className="stack g-4 mt-6" aria-busy>
          <SkeletonCard lines={2} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
        </div>
      </main>
    );
  }

  const avg = reviews.length ? Math.round((reviews.reduce((n, r) => n + r.rating, 0) / reviews.length) * 10) / 10 : null;

  return (
    <>
      <header className="public-header">
        <div className="public-header-inner">
          <a href="/market" aria-label="Community Harvest — all vendors" style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wordmark.png" alt="Community Harvest" style={{ width: 150, maxWidth: "46vw", height: "auto", display: "block" }} />
          </a>
          <div className="row g-2 shrink0">
            <Button variant="secondary" size="sm" icon="link" onClick={share}>Share</Button>
            <LinkButton href="/market" variant="ghost" size="sm">All vendors</LinkButton>
          </div>
        </div>
      </header>

      <main className="public-wrap public-narrow">
        <div className="hero">
          {logoId ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={`/api/public/photo/${logoId}`}
              alt={vendor.businessName}
              style={{
                width: 132, height: 132, borderRadius: "var(--r-full)", objectFit: "contain",
                background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--sh-md)",
                padding: "var(--sp-3)", margin: "0 auto var(--sp-3)", display: "block",
              }}
            />
          ) : (
            <div
              aria-hidden
              className="center"
              style={{
                width: 132, height: 132, borderRadius: "var(--r-full)", background: "var(--n-900)",
                color: "var(--n-0)", display: "flex", fontSize: "var(--fs-3xl)", fontWeight: 700,
                letterSpacing: "-0.02em", boxShadow: "var(--sh-md)", margin: "0 auto var(--sp-3)",
              }}
            >
              {vendor.businessName.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}
            </div>
          )}

          <h1 className="hero-title">{vendor.businessName}</h1>

          {avg !== null && (
            <div className="row g-2 center mt-2" style={{ justifyContent: "center" }}>
              <Stars n={Math.round(avg)} size={16} />
              <span className="t-sm num" style={{ fontWeight: 600 }}>{avg}</span>
              <span className="t-sm t-muted">· {plural(reviews.length, "review")}</span>
            </div>
          )}

          {vendor.publicBlurb && <p className="hero-sub">{vendor.publicBlurb}</p>}

          <p className="t-xs t-muted mt-2">
            At Community Harvest — Food and Craft Market, Noble OK · <a href="/market">all vendors</a>
          </p>

          <div className="row g-2 wrap mt-4" style={{ justifyContent: "center" }}>
            <Button variant="secondary" icon="link" onClick={share}>Share this booth</Button>
            {!followOpen && !followDone && (
              <Button variant="secondary" icon="bell" onClick={() => setFollowOpen(true)}>Get restock alerts</Button>
            )}
          </div>

          {followOpen && !followDone && (
            <div className="stack g-2 mt-3" style={{ maxWidth: 360, margin: "var(--sp-3) auto 0", textAlign: "left" }}>
              <Field label="Email for restock alerts" hint="One email when they restock, max once a day. Unsubscribe anytime." error={followMsg || undefined}>
                {(p) => (
                  <div className="row g-2">
                    <Input
                      {...p}
                      className="grow"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      value={followEmail}
                      onChange={(e) => { setFollowEmail(e.target.value); setFollowMsg(""); }}
                      onKeyDown={(e) => e.key === "Enter" && doFollow()}
                    />
                    <Button variant="primary" className="shrink0" icon="bell" onClick={doFollow}>Follow</Button>
                  </div>
                )}
              </Field>
            </div>
          )}

          {followDone && (
            <div className="mt-3" style={{ textAlign: "left" }}>
              <Note tone="success" title="You're in">
                We&rsquo;ll email you when {vendor.businessName} restocks.
              </Note>
            </div>
          )}
        </div>

        {photos.length > 0 && (
          <div className="row g-3 mb-4" style={{ overflowX: "auto", paddingBottom: "var(--sp-1)" }}>
            {photos.map((id) => (
              <button
                key={id}
                type="button"
                className="shrink0"
                aria-label="View a larger product photo"
                onClick={() => setLightbox({ src: `/api/public/photo/${id}`, alt: `${vendor.businessName} product photo` })}
                style={{
                  padding: 0, border: "1px solid var(--border)", borderRadius: "var(--r-lg)",
                  background: "none", cursor: "zoom-in", lineHeight: 0, overflow: "hidden",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/public/photo/${id}`} alt="" style={{ height: 150, width: "auto", display: "block" }} />
              </button>
            ))}
          </div>
        )}

        {/* ------------------------------------------------ what's on the floor -- */}
        <Card title="At the market right now" subtitle={items.length ? plural(items.length, "item") : undefined} className="mb-4">
          {items.length === 0 ? (
            <EmptyState
              icon="box"
              title="Nothing on the floor at the moment"
              body="Check back soon, or send a request below and they'll get back to you."
            />
          ) : (
            <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {items.map((i) => {
                const sale = (i.salePercent || 0) > 0;
                return (
                  <li
                    key={i.name}
                    className="row between g-3 wrap"
                    style={{ padding: "var(--sp-2) 0", borderBottom: "1px solid var(--border)" }}
                  >
                    <span className="row g-3 grow" style={{ minWidth: 140 }}>
                      {i.photoId && (
                        <button
                          type="button"
                          className="shrink0"
                          aria-label={`View a larger photo of ${i.name}`}
                          onClick={() => setLightbox({ src: `/api/public/photo/${i.photoId}`, alt: i.name })}
                          style={{
                            padding: 0, border: "1px solid var(--border)", borderRadius: "var(--r-md)",
                            background: "none", cursor: "zoom-in", lineHeight: 0, overflow: "hidden",
                          }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`/api/public/photo/${i.photoId}`} alt="" style={{ width: 44, height: 44, objectFit: "cover", display: "block" }} />
                        </button>
                      )}
                      <span style={{ minWidth: 0 }}>
                        <span className="t-body">{i.name}</span>
                        {i.quantity <= 3 && <span className="t-xs t-warn" style={{ display: "block" }}>Only {i.quantity} left</span>}
                      </span>
                    </span>
                    <span className="row g-2 shrink0">
                      {sale && (
                        <>
                          <s className="t-sm t-muted num">{money(i.basePriceCents || i.priceCents)}</s>
                          <Badge tone="danger">{i.salePercent}% off</Badge>
                        </>
                      )}
                      <b className={`num ${sale ? "t-danger" : ""}`}>{money(i.priceCents)}</b>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* ------------------------------------------------------------ message -- */}
        <Card title="Message this vendor" className="mb-4">
          {mSent ? (
            <Note tone="success" title="Sent">
              Check your email — your private conversation link is there, and replies will land in the same place.
            </Note>
          ) : (
            <div className="stack g-4">
              <div className="row g-2 wrap">
                {vendor.acceptsPreorders && (
                  <Button variant={msgType === "PREORDER" ? "primary" : "secondary"} aria-pressed={msgType === "PREORDER"} onClick={() => setMsgType("PREORDER")}>
                    Pre-order
                  </Button>
                )}
                {vendor.acceptsRequests && (
                  <Button variant={msgType === "REQUEST" ? "primary" : "secondary"} aria-pressed={msgType === "REQUEST"} onClick={() => setMsgType("REQUEST")}>
                    Request
                  </Button>
                )}
                <Button variant={msgType === "COMPLAINT" ? "primary" : "secondary"} aria-pressed={msgType === "COMPLAINT"} onClick={() => setMsgType("COMPLAINT")}>
                  Complaint
                </Button>
              </div>

              {!vendor.acceptsPreorders && !vendor.acceptsRequests && (
                <p className="t-xs t-muted" style={{ margin: 0 }}>
                  This vendor isn&rsquo;t taking pre-orders or requests right now; complaints always go through.
                </p>
              )}

              {msgType && (
                <div className="stack g-4">
                  <Field label="Your name">
                    {(p) => <Input {...p} autoComplete="name" value={mName} onChange={(e) => setMName(e.target.value)} />}
                  </Field>
                  <Field label="Email" hint="The conversation happens here.">
                    {(p) => <Input {...p} type="email" inputMode="email" autoComplete="email" value={mEmail} onChange={(e) => setMEmail(e.target.value)} />}
                  </Field>
                  <Field label="Phone">
                    {(p) => <Input {...p} type="tel" inputMode="tel" autoComplete="tel" value={mPhone} onChange={(e) => setMPhone(e.target.value)} />}
                  </Field>
                  <Field
                    label={msgType === "PREORDER" ? "What would you like to order?" : msgType === "REQUEST" ? "What are you looking for?" : "What went wrong?"}
                  >
                    {(p) => <Textarea {...p} rows={4} value={mBody} onChange={(e) => setMBody(e.target.value)} />}
                  </Field>

                  {mMsg && <Note tone="error">{mMsg}</Note>}

                  <Button variant="primary" size="lg" block loading={mBusy} icon="mail" onClick={sendMessage}>
                    Send privately
                  </Button>
                  <p className="t-xs t-muted" style={{ margin: 0 }}>
                    Private — only the vendor sees this{msgType === "COMPLAINT" ? " (and the market keeps a copy for accountability)" : ""}.
                  </p>
                </div>
              )}

              {!msgType && mMsg && <Note tone="error">{mMsg}</Note>}
            </div>
          )}
        </Card>

        {/* ------------------------------------------------------------ reviews -- */}
        <Card title="Reviews" subtitle={avg !== null ? `${avg} average · ${plural(reviews.length, "review")}` : undefined}>
          {reviews.length === 0 ? (
            <EmptyState icon="star" title="No reviews yet" body="Be the first to tell other shoppers what you thought." />
          ) : (
            <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {reviews.map((r) => (
                <li key={r.id} style={{ padding: "var(--sp-3) 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between g-2 wrap">
                    <b className="t-body">{r.name}</b>
                    <span className="row g-2">
                      <Stars n={r.rating} />
                      <span className="t-xs t-muted">{relTime(r.createdAt)}</span>
                    </span>
                  </div>

                  <p className="t-body mt-1" style={{ whiteSpace: "pre-wrap" }}>{r.body}</p>

                  <div className="row g-2 mt-2 wrap">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="star"
                      onClick={() => like("review", r.id)}
                      disabled={liked(r.id)}
                      aria-label={`Like this review (${r.likes} so far)`}
                    >
                      {r.likes}{liked(r.id) ? " · liked" : ""}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="message"
                      aria-expanded={cmOpen === r.id}
                      onClick={() => { setCmOpen(cmOpen === r.id ? null : r.id); setCmName(""); setCmBody(""); }}
                    >
                      Reply{r.comments.length ? ` (${r.comments.length})` : ""}
                    </Button>
                  </div>

                  {r.comments.map((c) => (
                    <div
                      key={c.id}
                      style={{ marginLeft: "var(--sp-4)", marginTop: "var(--sp-2)", paddingLeft: "var(--sp-3)", borderLeft: "2px solid var(--border)" }}
                    >
                      <b className="t-sm">{c.name}</b>
                      <p className="t-sm mt-1" style={{ whiteSpace: "pre-wrap" }}>{c.body}</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="star"
                        onClick={() => like("comment", c.id)}
                        disabled={liked(c.id)}
                        aria-label={`Like this reply (${c.likes} so far)`}
                      >
                        {c.likes}
                      </Button>
                    </div>
                  ))}

                  {cmOpen === r.id && (
                    <div className="stack g-3" style={{ marginLeft: "var(--sp-4)", marginTop: "var(--sp-3)" }}>
                      <Field label="Your name">
                        {(p) => <Input {...p} autoComplete="name" value={cmName} onChange={(e) => setCmName(e.target.value)} />}
                      </Field>
                      <Field label="Reply">
                        {(p) => <Textarea {...p} rows={2} value={cmBody} onChange={(e) => setCmBody(e.target.value)} />}
                      </Field>
                      <div className="row g-2">
                        <Button variant="primary" onClick={() => postComment(r.id)}>Post reply</Button>
                        <Button variant="ghost" onClick={() => setCmOpen(null)}>Cancel</Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="stack g-4 mt-6">
            <h3 className="t-section">Write a review</h3>
            <Field label="Your name">
              {(p) => <Input {...p} autoComplete="name" value={rvName} onChange={(e) => setRvName(e.target.value)} />}
            </Field>

            <div className="field">
              <span className="field-label">Rating</span>
              <div className="row g-1" role="group" aria-label="Rating out of 5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Button
                    key={n}
                    variant={rvRating >= n ? "primary" : "secondary"}
                    icon="star"
                    aria-pressed={rvRating === n}
                    aria-label={`${n} ${n === 1 ? "star" : "stars"}`}
                    onClick={() => setRvRating(n)}
                  />
                ))}
              </div>
            </div>

            <Field label="Your review">
              {(p) => <Textarea {...p} rows={3} value={rvBody} onChange={(e) => setRvBody(e.target.value)} />}
            </Field>

            {rvMsg && <Note tone="error">{rvMsg}</Note>}

            <Button variant="primary" size="lg" block loading={rvBusy} icon="star" onClick={postReview}>
              Post review
            </Button>
          </div>
        </Card>
      </main>

      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Lightbox from "@/components/Lightbox";
import {
  Badge, Button, Card, EmptyState, Field, Icon, Input, LinkButton, Note, Panel,
  SkeletonCard, Textarea, useToast,
} from "@/components/ui";
import { money, plural, relTime } from "@/lib/format";

type Comment = { id: string; name: string; body: string; likes: number; createdAt: string };
type Review = { id: string; name: string; rating: number; body: string; likes: number; createdAt: string; comments: Comment[] };
type Vendor = {
  code: string; businessName: string; publicBlurb: string;
  tagline: string; story: string;
  instagramUrl: string; facebookUrl: string; websiteUrl: string;
  acceptsPreorders: boolean; acceptsRequests: boolean; boothLabel: string;
};
type Item = {
  id: string; name: string; description: string; unitLabel: string; featured: boolean; category: string;
  priceCents: number; basePriceCents?: number; salePercent?: number; quantity: number;
  inStock: boolean; photoIds: string[];
  online: boolean; onlineQuantity: number; onlinePickup: boolean; onlineShip: boolean; shipCents: number;
};

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

export default function Storefront({ params }: { params: { code: string } }) {
  const toast = useToast();
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [followOpen, setFollowOpen] = useState(false);
  const [followEmail, setFollowEmail] = useState("");
  const [followMsg, setFollowMsg] = useState("");
  const [followDone, setFollowDone] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [online, setOnline] = useState<Item[]>([]);
  const [soldOut, setSoldOut] = useState<Item[]>([]);
  const [comingSoon, setComingSoon] = useState<Item[]>([]);
  /* The basket, kept in memory only. It belongs to this vendor and this visit —
     persisting it would mean holding prices and stock that have since moved. */
  const [cart, setCart] = useState<Record<string, number>>({});
  const [fulfil, setFulfil] = useState<"PICKUP" | "SHIP">("PICKUP");
  const [coName, setCoName] = useState("");
  const [coEmail, setCoEmail] = useState("");
  const [coPhone, setCoPhone] = useState("");
  const [coNote, setCoNote] = useState("");
  const [coErr, setCoErr] = useState("");
  const [coBusy, setCoBusy] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [logoId, setLogoId] = useState<string | null>(null);
  const [coverId, setCoverId] = useState<string | null>(null);
  /* The item a shopper tapped. A panel rather than its own route: they came to
     browse, and a page load between every product is how browsing stops. */
  const [openItem, setOpenItem] = useState<Item | null>(null);
  const [gallery, setGallery] = useState(0);
  /* Which shelf the open item was clicked from. The same product can sit in
     both lists, and the two mean opposite things — one is buyable here as a
     pre-order, the other is in the building right now and sold in person. The
     detail panel has to say the right one, and only the click knows which. */
  const [openShop, setOpenShop] = useState(false);
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
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
    setVendor(data.vendor);
    setItems(data.items || []);
    setOnline(data.online || []);
    setSoldOut(data.soldOut || []);
    setComingSoon(data.comingSoon || []);
    setCategories(data.categories || []);
    setReviews(data.reviews);
    setPhotos(data.photos || []);
    setLogoId(data.logoId || null);
    setCoverId(data.coverId || null);
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

  /* Totals are computed here only to SHOW them. The server prices the order
     again from its own data at checkout, so a basket edited in a console buys
     nothing it shouldn't. */
  const cartLines = online.filter((i) => (cart[i.id] || 0) > 0);
  const cartSubtotal = cartLines.reduce((n, i) => n + i.priceCents * (cart[i.id] || 0), 0);
  const cartShipping = fulfil === "SHIP" ? cartLines.reduce((n, i) => n + i.shipCents, 0) : 0;
  const cartCount = cartLines.reduce((n, i) => n + (cart[i.id] || 0), 0);
  const shippableOnly = online.filter((i) => !i.onlinePickup);
  const canPickupAll = cartLines.every((i) => i.onlinePickup);
  const canShipAll = cartLines.length > 0 && cartLines.every((i) => i.onlineShip);

  const setQty = (id: string, qty: number, max: number) =>
    setCart((c) => {
      const next = { ...c };
      const q = Math.max(0, Math.min(max, qty));
      if (q === 0) delete next[id];
      else next[id] = q;
      return next;
    });

  const checkout = async () => {
    setCoErr("");
    if (!cartLines.length) { setCoErr("Your basket is empty."); return; }
    if (!coName.trim()) { setCoErr("Please add a name for the order."); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(coEmail.trim())) { setCoErr("We need an email to send your confirmation to."); return; }

    setCoBusy(true);
    try {
      const r = await fetch(`/api/public/vendor/${params.code}/order`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "checkout",
          fulfillment: fulfil,
          name: coName, email: coEmail, phone: coPhone, note: coNote,
          lines: cartLines.map((i) => ({ itemId: i.id, quantity: cart[i.id] })),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.url) { setCoErr(String(d.error || "Couldn't start checkout. Nothing has been charged.")); return; }
      window.location.href = String(d.url);
    } catch {
      setCoErr("Couldn't reach the payment page. Nothing has been charged — try again.");
    } finally { setCoBusy(false); }
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
        {/* A cover photo does more for a booth than any amount of copy: it is
            the one thing that says "this is a real shop" before anything is
            read. Falls back to a plain band rather than a broken layout. */}
        {coverId ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={`/api/public/photo/${coverId}`}
            alt=""
            style={{
              width: "100%", height: "clamp(140px, 28vw, 260px)", objectFit: "cover",
              borderRadius: "var(--r-lg)", display: "block", marginBottom: "calc(-1 * var(--sp-6))",
            }}
          />
        ) : null}

        <div className="hero" style={coverId ? { paddingTop: "var(--sp-5)" } : undefined}>
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

          {vendor.tagline ? (
            <p className="t-lg" style={{ marginTop: "var(--sp-1)", fontWeight: 560 }}>{vendor.tagline}</p>
          ) : null}

          {avg !== null && (
            <div className="row g-2 center mt-2" style={{ justifyContent: "center" }}>
              <Stars n={Math.round(avg)} size={16} />
              <span className="t-sm num" style={{ fontWeight: 600 }}>{avg}</span>
              <span className="t-sm t-muted">· {plural(reviews.length, "review")}</span>
            </div>
          )}

          {vendor.publicBlurb && <p className="hero-sub">{vendor.publicBlurb}</p>}

          {/* Social links belong near the top, not buried at the bottom: a
              shopper who likes the look of a booth follows them before they
              scroll to the product list. */}
          {(vendor.instagramUrl || vendor.facebookUrl || vendor.websiteUrl) && (
            <div className="row g-2 wrap mt-3" style={{ justifyContent: "center" }}>
              {vendor.instagramUrl ? (
                <a className="btn btn-ghost btn-sm" href={vendor.instagramUrl} target="_blank" rel="noopener noreferrer nofollow">
                  <Icon name="camera" size={14} /> Instagram
                </a>
              ) : null}
              {vendor.facebookUrl ? (
                <a className="btn btn-ghost btn-sm" href={vendor.facebookUrl} target="_blank" rel="noopener noreferrer nofollow">
                  <Icon name="users" size={14} /> Facebook
                </a>
              ) : null}
              {vendor.websiteUrl ? (
                <a className="btn btn-ghost btn-sm" href={vendor.websiteUrl} target="_blank" rel="noopener noreferrer nofollow">
                  <Icon name="link" size={14} /> Website
                </a>
              ) : null}
            </div>
          )}

          <p className="t-xs t-muted mt-2">
            {vendor.boothLabel ? <>Booth {vendor.boothLabel} · </> : null}
            Community Harvest — Food and Craft Market, Noble OK · <a href="/market">all vendors</a>
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

        {/* ------------------------------------------------------------- story -- */}
        {vendor.story ? (
          <Card title={`About ${vendor.businessName}`} className="mb-4">
            <p className="t-body" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{vendor.story}</p>
          </Card>
        ) : null}

        {/* -------------------------------------------------------- shop online -- */}
        {online.length > 0 && (
          <Card
            title={`Pre-order from ${vendor.businessName}`}
            subtitle="Made up for you after you order — not the stock sitting in their booth."
            className="mb-4"
          >
            <div className="stack g-4">
              {/* Said once, plainly, at the top. The single thing that goes
                  wrong with a market storefront is somebody paying online for
                  a jar they can see on the shelf, then arriving to find it
                  sold — because the shelf is first-come and the website is
                  not. These are two separate counts and shoppers have to be
                  told so before they pay, not in the confirmation email. */}
              <Note tone="info" title="These are pre-orders">
                {vendor.businessName} sets these aside and packs them once you&rsquo;ve ordered — you&rsquo;ll get an
                email when it&rsquo;s ready. Anything on the shelf in their booth right now is sold in person, first
                come, first served; ordering here doesn&rsquo;t hold it for you.
              </Note>

              <div className="grid-auto" style={{ ["--min" as string]: "168px" }}>
                {online.map((i) => {
                  const inCart = cart[i.id] || 0;
                  const sale = (i.salePercent || 0) > 0;
                  const cover = i.photoIds[0];
                  return (
                    <div
                      key={i.id}
                      className="stack g-2"
                      style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", overflow: "hidden" }}
                    >
                      <button
                        type="button"
                        onClick={() => { setOpenItem(i); setGallery(0); setOpenShop(true); }}
                        aria-label={`See details for ${i.name}`}
                        style={{ padding: 0, border: 0, background: "none", cursor: "pointer", lineHeight: 0, position: "relative" }}
                      >
                        {cover ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img src={`/api/public/photo/${cover}`} alt="" loading="lazy" style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block" }} />
                        ) : (
                          <span aria-hidden className="center" style={{ display: "flex", width: "100%", aspectRatio: "1 / 1", background: "var(--bg-sunken)", color: "var(--text-muted)" }}>
                            <Icon name="image" size={28} />
                          </span>
                        )}
                        {sale ? (
                          <span style={{ position: "absolute", top: 8, left: 8 }}><Badge tone="danger">{i.salePercent}% off</Badge></span>
                        ) : null}
                      </button>

                      <div className="stack g-2" style={{ padding: "0 var(--sp-3) var(--sp-3)" }}>
                        <span className="t-body" style={{ fontWeight: 560 }}>{i.name}</span>
                        <span className="row g-2" style={{ alignItems: "baseline" }}>
                          <b className={`num ${sale ? "t-danger" : ""}`}>{money(i.priceCents)}</b>
                          {i.unitLabel ? <span className="t-xs t-muted truncate">{i.unitLabel}</span> : null}
                        </span>
                        <span className="t-xs t-muted">
                          {i.onlinePickup && i.onlineShip
                            ? `Collect free, or posted for ${money(i.shipCents)}`
                            : i.onlineShip
                              ? `Posted for ${money(i.shipCents)}`
                              : "Collect at the market"}
                        </span>
                        {/* The dangerous case: the same product is also on the
                            shelf today. Without this line a shopper reads the
                            booth list and the shop list as one stock. */}
                        {i.inStock ? (
                          <span className="t-xs" style={{ color: "var(--warn)" }}>
                            Also in the booth today — buying here is a pre-order, not that shelf stock.
                          </span>
                        ) : null}

                        {inCart > 0 ? (
                          <div className="row g-2" style={{ alignItems: "center" }}>
                            <Button size="sm" variant="secondary" aria-label={`One fewer ${i.name}`} onClick={() => setQty(i.id, inCart - 1, i.onlineQuantity)}>−</Button>
                            <span className="num" style={{ minWidth: 24, textAlign: "center" }}>{inCart}</span>
                            <Button size="sm" variant="secondary" aria-label={`One more ${i.name}`} disabled={inCart >= i.onlineQuantity} onClick={() => setQty(i.id, inCart + 1, i.onlineQuantity)}>+</Button>
                            {inCart >= i.onlineQuantity ? <span className="t-xs t-muted">all of them</span> : null}
                          </div>
                        ) : (
                          <Button size="sm" icon="plus" onClick={() => setQty(i.id, 1, i.onlineQuantity)}>Add to basket</Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ---- basket ---- */}
              {cartLines.length > 0 && (
                <div className="stack g-4" style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--sp-4)" }}>
                  <h3 className="t-section">Your basket ({plural(cartCount, "item")})</h3>

                  <div className="stack g-2">
                    {cartLines.map((i) => (
                      <div key={i.id} className="row between g-3">
                        <span className="grow truncate">{cart[i.id]}× {i.name}</span>
                        <span className="num">{money(i.priceCents * (cart[i.id] || 0))}</span>
                      </div>
                    ))}
                  </div>

                  {/* Collection or post. Only offered when every item in the
                      basket actually supports it — a basket that can't all go
                      the same way has to be split, and saying so here beats
                      failing at checkout. */}
                  <div className="row g-2 wrap">
                    <Button
                      variant={fulfil === "PICKUP" ? "primary" : "secondary"}
                      disabled={!canPickupAll}
                      aria-pressed={fulfil === "PICKUP"}
                      onClick={() => setFulfil("PICKUP")}
                    >
                      Collect at the market — free
                    </Button>
                    <Button
                      variant={fulfil === "SHIP" ? "primary" : "secondary"}
                      disabled={!canShipAll}
                      aria-pressed={fulfil === "SHIP"}
                      onClick={() => setFulfil("SHIP")}
                    >
                      Post it{canShipAll ? ` — ${money(cartLines.reduce((n, i) => n + i.shipCents, 0))}` : ""}
                    </Button>
                  </div>
                  {!canShipAll && cartLines.some((i) => !i.onlineShip) ? (
                    <p className="t-xs t-muted" style={{ margin: 0 }}>
                      Something in your basket is collection-only, so this order has to be picked up.
                    </p>
                  ) : null}

                  <div className="stack g-1">
                    <div className="row between"><span>Subtotal</span><span className="num">{money(cartSubtotal)}</span></div>
                    {cartShipping > 0 ? (
                      <div className="row between"><span>Shipping</span><span className="num">{money(cartShipping)}</span></div>
                    ) : null}
                    <p className="t-xs t-muted" style={{ margin: 0 }}>Sales tax is added at checkout.</p>
                  </div>

                  <div className="stack g-3">
                    <Field label="Your name">
                      {(p) => <Input {...p} autoComplete="name" value={coName} onChange={(e) => setCoName(e.target.value)} />}
                    </Field>
                    <Field label="Email" hint="Your confirmation and updates go here.">
                      {(p) => <Input {...p} type="email" inputMode="email" autoComplete="email" value={coEmail} onChange={(e) => setCoEmail(e.target.value)} />}
                    </Field>
                    <Field label="Phone" hint="Optional — handy if they need to ask you something.">
                      {(p) => <Input {...p} type="tel" inputMode="tel" autoComplete="tel" value={coPhone} onChange={(e) => setCoPhone(e.target.value)} />}
                    </Field>
                    <Field label="Anything they should know?" hint="Optional.">
                      {(p) => <Textarea {...p} rows={2} value={coNote} onChange={(e) => setCoNote(e.target.value)} />}
                    </Field>
                  </div>

                  {coErr ? <Note tone="error">{coErr}</Note> : null}

                  <Button variant="primary" size="lg" block icon="card" loading={coBusy} onClick={checkout}>
                    Pay {money(cartSubtotal + cartShipping)} + tax
                  </Button>
                  <p className="t-xs t-muted" style={{ margin: 0 }}>
                    {fulfil === "SHIP"
                      ? `Card payment through Stripe. This is a pre-order — ${vendor.businessName} makes it up, posts it and adds tracking.`
                      : `Card payment through Stripe. This is a pre-order, not shelf stock — wait for the "ready to collect" email, then pick it up from Community Harvest${vendor.boothLabel ? `, booth ${vendor.boothLabel}` : ""}.`}
                  </p>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* ------------------------------------------------ what's on the floor -- */}
        <Card
          title="In the booth today"
          subtitle={
            items.length
              ? `${plural(items.length, "item")} on the shelf — sold in person, first come, first served${online.length > 0 ? ". To order ahead, use the pre-order shop above" : ""}`
              : undefined
          }
          className="mb-4"
        >
          {items.length === 0 ? (
            <EmptyState
              icon="box"
              title={comingSoon.length ? "Stock is on its way" : "Nothing on the floor at the moment"}
              body={
                comingSoon.length
                  ? "See what's coming below — follow the booth to hear when it lands."
                  : "Check back soon, or send a request below and they'll get back to you."
              }
            />
          ) : (
            <div className="stack g-4">
              {/* Search and categories appear only when there's enough to
                  warrant them — on a booth with six items they'd be clutter
                  pretending to be sophistication. */}
              {(items.length > 8 || categories.length > 1) && (
                <div className="stack g-3">
                  {items.length > 8 ? (
                    <Field label="Search this booth">
                      {(p) => (
                        <Input
                          {...p}
                          type="search"
                          placeholder="honey, candle, sourdough…"
                          value={q}
                          onChange={(e) => setQ(e.target.value)}
                        />
                      )}
                    </Field>
                  ) : null}
                  {categories.length > 1 ? (
                    <div className="row g-2 wrap">
                      <Button size="sm" variant={cat === "" ? "primary" : "secondary"} onClick={() => setCat("")}>
                        Everything
                      </Button>
                      {categories.map((c) => (
                        <Button key={c} size="sm" variant={cat === c ? "primary" : "secondary"} onClick={() => setCat(c)}>
                          {c}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}

              {(() => {
                const needle = q.trim().toLowerCase();
                const shown = items.filter(
                  (i) =>
                    (!cat || i.category === cat) &&
                    (!needle ||
                      i.name.toLowerCase().includes(needle) ||
                      i.description.toLowerCase().includes(needle))
                );
                if (!shown.length) {
                  return <EmptyState icon="search" title="Nothing matches" body="Try a different word, or clear the filters." />;
                }
                return (
                  <div className="grid-auto" style={{ ["--min" as string]: "168px" }}>
                    {shown.map((i) => {
                      const sale = (i.salePercent || 0) > 0;
                      const cover = i.photoIds[0];
                      return (
                        <button
                          key={i.id}
                          type="button"
                          onClick={() => { setOpenItem(i); setGallery(0); setOpenShop(false); }}
                          aria-label={`${i.name}, ${money(i.priceCents)}${i.description ? " — see details" : ""}`}
                          className="stack g-2"
                          style={{
                            padding: 0, textAlign: "left", background: "var(--surface)", cursor: "pointer",
                            border: "1px solid var(--border)", borderRadius: "var(--r-lg)", overflow: "hidden",
                          }}
                        >
                          <span style={{ position: "relative", display: "block", lineHeight: 0 }}>
                            {cover ? (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img
                                src={`/api/public/photo/${cover}`}
                                alt=""
                                loading="lazy"
                                style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block" }}
                              />
                            ) : (
                              /* No photo is the single biggest thing holding a
                                 booth back, so the gap says so plainly rather
                                 than rendering an empty grey square. */
                              <span
                                aria-hidden
                                className="center"
                                style={{
                                  display: "flex", width: "100%", aspectRatio: "1 / 1",
                                  background: "var(--bg-sunken)", color: "var(--text-muted)",
                                }}
                              >
                                <Icon name="image" size={28} />
                              </span>
                            )}
                            {sale ? (
                              <span style={{ position: "absolute", top: 8, left: 8 }}>
                                <Badge tone="danger">{i.salePercent}% off</Badge>
                              </span>
                            ) : null}
                            {/* No "3 left" badge here on purpose. The booth
                                count is only right if every single sale went
                                through the register, and at a market it
                                doesn't — a vendor sells two at their own booth
                                and the shelf figure is wrong until somebody
                                fixes it. A public page promising "2 left" when
                                there are none is worse than saying nothing. */}
                          </span>

                          <span className="stack g-1" style={{ padding: "0 var(--sp-3) var(--sp-3)" }}>
                            <span className="t-body truncate" style={{ fontWeight: 560 }}>{i.name}</span>
                            <span className="row g-2" style={{ alignItems: "baseline" }}>
                              <b className={`num ${sale ? "t-danger" : ""}`}>{money(i.priceCents)}</b>
                              {sale ? <s className="t-xs t-muted num">{money(i.basePriceCents || i.priceCents)}</s> : null}
                              {i.unitLabel ? <span className="t-xs t-muted truncate">{i.unitLabel}</span> : null}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}
        </Card>

        {/* Coming soon: products the vendor has listed but not brought in yet.
            Shown in full, with photos and prices, straight after the shelf —
            this is the vendor's range, not a list of leftovers. */}
        {comingSoon.length > 0 && (
          <Card
            title="Coming soon"
            subtitle={`${plural(comingSoon.length, "product")} ${comingSoon.length === 1 ? "isn't" : "aren't"} in the booth yet. Follow the booth and we'll email you when stock arrives.`}
            className="mb-4"
          >
            <div className="grid-auto" style={{ ["--min" as string]: "168px" }}>
              {comingSoon.map((i) => {
                const cover = i.photoIds[0];
                return (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => { setOpenItem(i); setGallery(0); setOpenShop(false); }}
                    aria-label={`${i.name}, ${money(i.priceCents)}, coming soon`}
                    className="stack g-2"
                    style={{
                      padding: 0, textAlign: "left", background: "var(--surface)", cursor: "pointer",
                      border: "1px solid var(--border)", borderRadius: "var(--r-lg)", overflow: "hidden",
                    }}
                  >
                    <span style={{ position: "relative", display: "block", lineHeight: 0 }}>
                      {cover ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={`/api/public/photo/${cover}`}
                          alt=""
                          loading="lazy"
                          style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block" }}
                        />
                      ) : (
                        <span
                          aria-hidden
                          className="center"
                          style={{ display: "flex", width: "100%", aspectRatio: "1 / 1", background: "var(--bg-sunken)", color: "var(--text-muted)" }}
                        >
                          <Icon name="image" size={28} />
                        </span>
                      )}
                      <span style={{ position: "absolute", top: 8, left: 8 }}>
                        <Badge tone="info">Coming soon</Badge>
                      </span>
                    </span>
                    <span className="stack g-1" style={{ padding: "0 var(--sp-3) var(--sp-3)" }}>
                      <span className="t-body truncate" style={{ fontWeight: 560 }}>{i.name}</span>
                      <span className="row g-2" style={{ alignItems: "baseline" }}>
                        <b className="num">{money(i.priceCents)}</b>
                        {i.unitLabel ? <span className="t-xs t-muted truncate">{i.unitLabel}</span> : null}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>
        )}

        {/* Sold out, kept visible and clearly labelled. A shopper who wants the
            thing that's gone is exactly who should be following this booth. */}
        {soldOut.length > 0 && (
          <Card title="Sold out just now" subtitle="Follow the booth and we'll email you when these come back" className="mb-4">
            <div className="row g-2 wrap">
              {soldOut.slice(0, 12).map((i) => (
                <span key={i.id} className="row g-2" style={{ alignItems: "center" }}>
                  <Badge tone="neutral">{i.name}</Badge>
                </span>
              ))}
            </div>
          </Card>
        )}

        {/* ------------------------------------------------------------ message -- */}
        <Card id="message-vendor" title="Message this vendor" className="mb-4">
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

      {/* ---------------------------------------------------- item detail -- */}
      {openItem ? (
        <Panel
          open
          onClose={() => setOpenItem(null)}
          title={openItem.name}
          subtitle={vendor.businessName}
        >
          <div className="stack g-4">
            {openItem.photoIds.length ? (
              <div className="stack g-2">
                <button
                  type="button"
                  aria-label={`View ${openItem.name} larger`}
                  onClick={() =>
                    setLightbox({ src: `/api/public/photo/${openItem.photoIds[gallery]}`, alt: openItem.name })
                  }
                  style={{
                    padding: 0, border: "1px solid var(--border)", borderRadius: "var(--r-lg)",
                    background: "none", cursor: "zoom-in", lineHeight: 0, overflow: "hidden",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/public/photo/${openItem.photoIds[gallery]}`}
                    alt={openItem.name}
                    style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block" }}
                  />
                </button>

                {openItem.photoIds.length > 1 ? (
                  <div className="row g-2 wrap">
                    {openItem.photoIds.map((id, idx) => (
                      <button
                        key={id}
                        type="button"
                        aria-label={`Photo ${idx + 1} of ${openItem.photoIds.length}`}
                        aria-pressed={idx === gallery}
                        onClick={() => setGallery(idx)}
                        style={{
                          padding: 0, lineHeight: 0, overflow: "hidden", cursor: "pointer",
                          borderRadius: "var(--r-md)", background: "none",
                          border: idx === gallery ? "2px solid var(--accent)" : "1px solid var(--border)",
                        }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/public/photo/${id}`} alt="" style={{ width: 56, height: 56, objectFit: "cover", display: "block" }} />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="row g-3 wrap" style={{ alignItems: "baseline" }}>
              <span className="display num" style={{ fontSize: "var(--fs-2xl)" }}>{money(openItem.priceCents)}</span>
              {(openItem.salePercent || 0) > 0 ? (
                <>
                  <s className="t-sm t-muted num">{money(openItem.basePriceCents || openItem.priceCents)}</s>
                  <Badge tone="danger">{openItem.salePercent}% off</Badge>
                </>
              ) : null}
              {openItem.unitLabel ? <span className="t-sm t-muted">{openItem.unitLabel}</span> : null}
            </div>

            {openItem.description ? (
              <p className="t-body" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{openItem.description}</p>
            ) : null}

            <div className="row g-2 wrap">
              {openItem.category ? <Badge tone="neutral">{openItem.category}</Badge> : null}
              {/* Opened from the shop, the number that matters is what the
                  vendor set aside for online orders — NOT the booth count,
                  which can be zero for a product that pre-orders fine. */}
              {openShop ? (
                <>
                  <Badge tone="success" dot>Available to pre-order</Badge>
                  {openItem.inStock ? <Badge tone="neutral">Also in the booth today</Badge> : null}
                </>
              ) : openItem.inStock ? (
                <Badge tone="success" dot>In the booth today</Badge>
              ) : (
                <Badge tone="info" dot>Coming soon — not in the booth yet</Badge>
              )}
            </div>

            {openShop ? (
              <Note tone="info" title="Pre-order">
                {vendor.businessName} makes this up after you order and emails you when it&rsquo;s ready
                {openItem.inStock
                  ? ". One is on their shelf today, but that one is sold in person — ordering here doesn't hold it."
                  : "."}
              </Note>
            ) : (
              <Note tone="info">
                {!openItem.inStock
                  ? "This one isn't on the shelf yet. Follow the booth to hear when it arrives, or ask about it below."
                  : vendor.boothLabel
                    ? `Come and see it at booth ${vendor.boothLabel}, or ask about it below.`
                    : "Come and see it at the market, or ask about it below."}
              </Note>
            )}

            <div className="row g-2 wrap">
              {/* The message-based pre-order is for things you CAN'T buy here.
                  Offering it beside a product that's already in the basket
                  flow just gives a shopper two doors to the same room. */}
              {vendor.acceptsPreorders && !openShop ? (
                <Button
                  variant="primary"
                  icon="mail"
                  onClick={() => {
                    setMsgType("PREORDER");
                    setMBody(`I'd like to pre-order: ${openItem.name}`);
                    setOpenItem(null);
                    document.getElementById("message-vendor")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  Pre-order this
                </Button>
              ) : null}
              <Button
                variant="secondary"
                icon="link"
                onClick={() => {
                  const url = `${window.location.origin}/v/${vendor.code}`;
                  navigator.clipboard?.writeText(url).then(
                    () => toast.success("Link copied", "Send it to whoever needs to see this."),
                    () => toast.error("Couldn't copy the link", url)
                  );
                }}
              >
                Share
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </>
  );
}

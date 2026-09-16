"use client";

import { useEffect, useMemo, useState } from "react";
import { usePulse } from "@/lib/usePulse";
import SponsorBanner, { type Banner } from "@/components/SponsorBanner";
import {
  Badge, Button, EmptyState, Field, Icon, LinkButton, SearchInput, Select, SkeletonCard,
} from "@/components/ui";
import { money, plural } from "@/lib/format";

type V = {
  code: string; businessName: string; publicBlurb: string;
  acceptsPreorders: boolean; acceptsRequests: boolean;
  items: { name: string; priceCents: number; basePriceCents?: number; salePercent?: number; quantity: number }[];
  rating: { avg: number; n: number } | null;
  logoId: string | null;
};

/**
 * The market feed has no vendor "category" column, so the filter is built from
 * what the payload actually carries: whether a vendor has stock on the floor,
 * has something on sale, and which kinds of messages they accept.
 */
type Filter = "all" | "onFloor" | "onSale" | "preorders" | "requests";
type Sort = "name" | "rating" | "items";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All vendors" },
  { value: "onFloor", label: "On the floor now" },
  { value: "onSale", label: "Something on sale" },
  { value: "preorders", label: "Takes pre-orders" },
  { value: "requests", label: "Takes requests" },
];

const SORTS: { value: Sort; label: string }[] = [
  { value: "name", label: "Name (A–Z)" },
  { value: "rating", label: "Top rated" },
  { value: "items", label: "Most on the floor" },
];

const onSale = (v: V) => v.items.some((i) => (i.salePercent || 0) > 0);

export default function MarketDirectory() {
  const [vendors, setVendors] = useState<V[]>([]);
  const [q, setQ] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("name");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [feed, setFeed] = useState<{ id: string; body: string; photoId: string | null; createdAt: string; vendor: { code: string; businessName: string; logoId: string | null } }[]>([]);

  useEffect(() => {
    const loadMarket = () => {
      fetch("/api/public/market").then(async (r) => {
        if (r.ok) { setVendors((await r.json()).vendors || []); setFailed(false); }
        else setFailed(true);
        setLoaded(true);
      }).catch(() => { setFailed(true); setLoaded(true); });
    };
    fetch("/api/public/banner").then(async (r) => { if (r.ok) setBanner((await r.json()).banner); }).catch(() => {});
    const loadFeed = () => fetch("/api/public/feed").then(async (r) => { if (r.ok) setFeed((await r.json()).posts); }).catch(() => {});
    loadFeed();
    loadMarket();
    (window as unknown as { __lm?: () => void }).__lm = () => { loadMarket(); loadFeed(); };
  }, []);
  usePulse(() => (window as unknown as { __lm?: () => void }).__lm?.());

  const needle = q.trim().toLowerCase();

  const shown = useMemo(() => {
    let list = needle
      ? vendors.filter((v) => v.businessName.toLowerCase().includes(needle) || v.items.some((i) => i.name.toLowerCase().includes(needle)))
      : vendors;

    if (filter === "onFloor") list = list.filter((v) => v.items.length > 0);
    else if (filter === "onSale") list = list.filter(onSale);
    else if (filter === "preorders") list = list.filter((v) => v.acceptsPreorders);
    else if (filter === "requests") list = list.filter((v) => v.acceptsRequests);

    const sorted = [...list];
    if (sort === "rating") {
      sorted.sort((a, b) => (b.rating?.avg ?? -1) - (a.rating?.avg ?? -1) || (b.rating?.n ?? 0) - (a.rating?.n ?? 0) || a.businessName.localeCompare(b.businessName));
    } else if (sort === "items") {
      sorted.sort((a, b) => b.items.length - a.items.length || a.businessName.localeCompare(b.businessName));
    } else {
      sorted.sort((a, b) => a.businessName.localeCompare(b.businessName));
    }
    return sorted;
  }, [vendors, needle, filter, sort]);

  const filtering = filter !== "all" || needle.length > 0;

  return (
    <>
      <header className="public-header">
        <div className="public-header-inner">
          <a href="/market" aria-label="Community Harvest — market directory" style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wordmark.png" alt="Community Harvest" style={{ width: 150, maxWidth: "46vw", height: "auto", display: "block" }} />
          </a>
          <nav className="row g-2 shrink0">
            <LinkButton href="/tents" variant="ghost" size="sm" icon="tent">Tents</LinkButton>
            <LinkButton href="/apply" variant="primary" size="sm">Become a vendor</LinkButton>
          </nav>
        </div>
      </header>

      <main className="public-wrap">
        <div className="hero">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 120, margin: "0 auto var(--sp-3)", display: "block" }} />
          <h1 className="hero-title">Food and craft market</h1>
          <p className="hero-sub">
            Noble, Oklahoma. A live list of what our vendors have on the floor right now.
          </p>
        </div>

        <SponsorBanner banner={banner} showApplyLink />

        <div className="row g-2 wrap mb-4">
          <LinkButton href="/tents" variant="primary" size="lg" icon="tent" className="grow">Book a tent day</LinkButton>
          <LinkButton href="/apply" variant="secondary" size="lg" icon="store" className="grow">Become a vendor</LinkButton>
        </div>

        {feed.length > 0 && (
          <section className="mb-6" aria-labelledby="feed-head">
            <h2 id="feed-head" className="t-section mb-2 row g-2">
              <Icon name="message" size={16} /> Fresh from our vendors
            </h2>
            <div className="row g-3" style={{ overflowX: "auto", paddingBottom: "var(--sp-2)", alignItems: "stretch" }}>
              {feed.slice(0, 12).map((po) => (
                <a
                  key={po.id}
                  href={`/v/${po.vendor.code}`}
                  className="card card-body shrink0"
                  style={{ width: 250, textDecoration: "none", color: "inherit" }}
                >
                  <div className="row g-2 mb-2">
                    {po.vendor.logoId
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={`/api/public/photo/${po.vendor.logoId}`} alt="" style={{ width: 28, height: 28, borderRadius: "var(--r-full)", objectFit: "cover", border: "1px solid var(--border)" }} />
                      : <span className="center" style={{ width: 28, height: 28, borderRadius: "var(--r-full)", background: "var(--n-900)", color: "var(--n-0)", display: "inline-flex", fontSize: "var(--fs-xs)", fontWeight: 700 }}>{po.vendor.businessName.slice(0, 1)}</span>}
                    <b className="t-sm truncate">{po.vendor.businessName}</b>
                  </div>
                  <p className="t-body" style={{ whiteSpace: "pre-wrap" }}>{po.body}</p>
                  <div className="t-xs t-muted mt-2">
                    {new Date(po.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })} · tap to visit
                  </div>
                </a>
              ))}
            </div>
          </section>
        )}

        <div className="toolbar">
          <div className="grow">
            <SearchInput value={q} onValueChange={setQ} placeholder="Search vendors or products… (honey, bread, candles)" aria-label="Search vendors or products" />
          </div>
          <Field label="Show" className="shrink0">
            {(p) => (
              <Select {...p} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                {FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Sort by" className="shrink0">
            {(p) => (
              <Select {...p} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                {SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            )}
          </Field>
        </div>

        {!loaded && (
          <div className="stack g-3">
            <SkeletonCard lines={3} />
            <SkeletonCard lines={3} />
            <SkeletonCard lines={3} />
          </div>
        )}

        {loaded && failed && (
          <EmptyState
            icon="alert"
            title="We couldn't load the market"
            body="Something went wrong on our end. Give it a moment and try again."
            action={<Button variant="secondary" icon="refresh" onClick={() => (window as unknown as { __lm?: () => void }).__lm?.()}>Try again</Button>}
          />
        )}

        {loaded && !failed && shown.length === 0 && (
          <EmptyState
            icon="store"
            title={filtering ? "Nothing matches" : "No vendors on the floor yet"}
            body={filtering
              ? "Try a different search, or widen the filter to all vendors."
              : "Vendors are still getting set up. Check back soon."}
            action={filtering
              ? <Button variant="secondary" onClick={() => { setQ(""); setFilter("all"); }}>Clear filters</Button>
              : <LinkButton href="/apply" variant="primary">Become a vendor</LinkButton>}
          />
        )}

        {loaded && !failed && shown.length > 0 && (
          <>
            <p className="t-xs t-muted mb-3" aria-live="polite">
              {plural(shown.length, "vendor")}{filtering ? ` of ${vendors.length}` : ""}
            </p>
            <div className="stack g-3">
              {shown.map((v) => (
                <a href={`/v/${v.code}`} key={v.code} className="card card-body" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
                  <div className="row between g-2 wrap">
                    <span className="row g-3" style={{ minWidth: 0 }}>
                      {v.logoId && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={`/api/public/photo/${v.logoId}`} alt="" style={{ height: 44, width: "auto", maxWidth: 90, display: "block" }} />
                      )}
                      <span className="t-section truncate">{v.businessName}</span>
                    </span>
                    {v.rating && (
                      <Badge tone="warn" icon="star">{v.rating.avg} · {plural(v.rating.n, "review")}</Badge>
                    )}
                  </div>

                  {v.publicBlurb && <p className="t-sm t-secondary mt-2">{v.publicBlurb}</p>}

                  {v.items.length === 0 ? (
                    <p className="t-sm t-muted mt-2">Nothing on the floor right now.</p>
                  ) : (
                    <div className="row wrap g-2 mt-3">
                      {v.items.slice(0, 12).map((i) => {
                        const sale = (i.salePercent || 0) > 0;
                        return (
                          <span
                            key={i.name}
                            className="t-xs num"
                            style={{
                              border: "1px solid var(--border)",
                              borderRadius: "var(--r-full)",
                              background: "var(--bg-sunken)",
                              padding: "var(--sp-1) var(--sp-3)",
                            }}
                          >
                            {i.name} ·{" "}
                            {sale && <s className="t-muted">{money(i.basePriceCents || i.priceCents)}</s>}
                            {sale ? " " : ""}
                            <b className={sale ? "t-danger" : undefined}>{money(i.priceCents)}</b>
                            {sale ? ` · ${i.salePercent}% off` : ""}
                            {i.quantity <= 3 ? ` · ${i.quantity} left` : ""}
                          </span>
                        );
                      })}
                      {v.items.length > 12 && <span className="t-xs t-muted">+{v.items.length - 12} more…</span>}
                    </div>
                  )}

                  <div className="row g-1 mt-3 t-sm t-accent" style={{ fontWeight: 600 }}>
                    View booth
                    {v.acceptsPreorders ? " · pre-order" : ""}
                    {v.acceptsRequests ? " · requests" : ""}
                    <Icon name="chevronRight" size={14} />
                  </div>
                </a>
              ))}
            </div>
          </>
        )}
      </main>
    </>
  );
}

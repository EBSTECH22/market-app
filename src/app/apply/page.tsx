"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SponsorBanner, { type Banner } from "@/components/SponsorBanner";
import {
  Badge, Button, Card, Checkbox, Field, Icon, Input, LinkButton, Note, Segmented, Select, Textarea,
} from "@/components/ui";

const DRAFT_KEY = "ch_apply_draft_v1";

/** An offer key (BOOTH_5X5, MARKET_SPACE…), or one of the two special modes. */
type BoothMode = string;
type Offer = {
  key: string; name: string; blurb: string;
  priceCents: number; priceMaxCents: number; commissionPercent: number;
  left: number | null; waitlist: boolean; availability: string; terms: string;
};
type Errors = Partial<Record<string, string>>;

/** Section ids double as anchor targets and progress steps. */
const SECTIONS = [
  { id: "basics", label: "The basics" },
  { id: "sell", label: "What you sell" },
  { id: "food", label: "Food rules" },
  { id: "booth", label: "Booth size" },
  { id: "logistics", label: "Logistics" },
] as const;

/** Submit order matters: the first invalid field in this order gets focus. */
const FIELD_ORDER = ["businessName", "contactName", "email", "phone", "products", "madeByYou", "hffaAck", "bw", "bd"];

/** Deliberately identical to the server's check so the client never rejects
 *  something /api/public/apply would have accepted. */
const looksLikeEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
const digitCount = (v: string) => v.replace(/\D/g, "").length;

export default function ApplyPage() {
  const [f, setF] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<Banner | null>(null);
  const [rate, setRate] = useState(6);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [boothMode, setBoothMode] = useState<BoothMode>("standard");
  const [waitInfo, setWaitInfo] = useState<{ position: number; spaceName: string } | null>(null);
  const [bw, setBw] = useState("5");
  const [bd, setBd] = useState("5");
  const [hffaAck, setHffaAck] = useState(false);
  const [msg, setMsg] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [restored, setRestored] = useState(false);
  const [draftNote, setDraftNote] = useState<"" | "saved" | "restored">("");
  const [activeSection, setActiveSection] = useState<string>("basics");

  const set = (k: string) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setErrors((e2) => (e2[k] ? { ...e2, [k]: undefined } : e2));
  };

  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});
  const bindRef = (k: string) => (el: HTMLElement | null) => { fieldRefs.current[k] = el; };
  // Suppresses the autosave that the restore itself would otherwise trigger,
  // so "Draft restored" stays on screen until the first real edit.
  const justRestored = useRef(false);

  /* ------------------------------------------------------------- loading -- */

  useEffect(() => {
    fetch("/api/public/banner").then(async (r) => { if (r.ok) setBanner((await r.json()).banner); }).catch(() => {});
    fetch("/api/public/rates").then(async (r) => { if (r.ok) setRate((await r.json()).rentPerSqft || 6); }).catch(() => {});
    /* What's actually on offer, with live counts. Picks the first one for them
       so the form is never in a state nobody chose. */
    fetch("/api/public/spaces")
      .then(async (r) => (r.ok ? ((await r.json()).offers as Offer[]) : []))
      .then((list) => {
        setOffers(list || []);
        setBoothMode((cur) => (cur === "standard" && list?.length ? list[0].key : cur));
      })
      .catch(() => {});
  }, []);

  /* --------------------------------------------------- draft restore/save -- */

  // localStorage throws in private mode and when storage is disabled, so every
  // touch of it is wrapped.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as {
          f?: Record<string, string>; boothMode?: BoothMode; bw?: string; bd?: string; hffaAck?: boolean;
        };
        if (d && typeof d === "object") {
          if (d.f && typeof d.f === "object") setF(d.f);
          if (typeof d.boothMode === "string" && d.boothMode) setBoothMode(d.boothMode);
          if (typeof d.bw === "string") setBw(d.bw);
          if (typeof d.bd === "string") setBd(d.bd);
          if (typeof d.hffaAck === "boolean") setHffaAck(d.hffaAck);
          setDraftNote("restored");
          justRestored.current = true;
        }
      }
    } catch {
      /* no draft available — start clean */
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored || sent) return;
    if (justRestored.current) { justRestored.current = false; return; }
    // Don't announce "Draft saved" on an untouched form.
    const pristine =
      Object.values(f).every((v) => !String(v || "").trim())
      && boothMode === "standard" && bw === "5" && bd === "5" && !hffaAck;
    if (pristine) return;
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ f, boothMode, bw, bd, hffaAck }));
        setDraftNote("saved");
      } catch {
        /* storage unavailable — the form still works, we just can't save it */
      }
    }, 600);
    return () => clearTimeout(t);
  }, [f, boothMode, bw, bd, hffaAck, restored, sent]);

  const clearDraft = useCallback(() => {
    try { window.localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
  }, []);

  /* ------------------------------------------------- business calculation -- */

  const sqft = Math.max(0, (Number(bw) || 0) * (Number(bd) || 0));
  const customRent = Math.round(sqft * rate * 100) / 100;
  const standardRent = Math.round(25 * rate * 100) / 100;
  const chosen = offers.find((o) => o.key === boothMode) || null;
  /* The rent on its own — the commission is named separately right beside it,
     so repeating it inside this string would read as two charges. */
  const priceOf = (o: Offer) =>
    o.priceMaxCents > o.priceCents
      ? `$${(o.priceCents / 100).toFixed(0)}–$${(o.priceMaxCents / 100).toFixed(0)}`
      : `$${(o.priceCents / 100).toFixed(0)}`;
  const boothRequest = chosen
    ? `${chosen.name} — ${chosen.terms}${chosen.waitlist ? " (waiting list)" : ""}`
    : boothMode === "custom"
    ? `Custom ${bw || "?"}×${bd || "?"} (${sqft} sqft) — $${customRent.toFixed(2)}/mo`
    : boothMode === "tent"
    ? "Outdoor tent — daily rate"
    : `Standard 5×5 — $${standardRent.toFixed(2)}/mo`;

  const isFood = !!f.foodStatus && f.foodStatus !== "Not a food vendor";

  /* ------------------------------------------------------------ validate -- */

  const validate = useCallback((): Errors => {
    const e: Errors = {};
    if (!(f.businessName || "").trim()) e.businessName = "Tell us what your booth is called.";
    if (!(f.contactName || "").trim()) e.contactName = "We need a name to put with the booth.";
    if (!(f.email || "").trim()) e.email = "We reply to every application by email.";
    else if (!looksLikeEmail(f.email)) e.email = "That doesn't look like an email address.";
    if (!(f.phone || "").trim()) e.phone = "If you're accepted, this is the number we call.";
    else if (digitCount(f.phone) < 10) e.phone = "Include the area code — 10 digits.";
    if (!(f.products || "").trim()) e.products = "Describe what you make and what it sells for.";
    if (!(f.madeByYou || "").trim()) e.madeByYou = "Tell us who makes or grows it.";
    if (isFood && !hffaAck) e.hffaAck = "Please read the Oklahoma homemade-food rules and check the box.";
    if (boothMode === "custom") {
      if (!(Number(bw) > 0)) e.bw = "Width must be at least 1 ft.";
      if (!(Number(bd) > 0)) e.bd = "Depth must be at least 1 ft.";
    }
    return e;
  }, [f, isFood, hffaAck, boothMode, bw, bd]);

  /* ------------------------------------------------------------ progress -- */

  const sectionDone = useMemo(() => {
    const e = validate();
    const filled = (k: string) => !!(f[k] || "").trim();
    return {
      basics: !e.businessName && !e.contactName && !e.email && !e.phone
        && filled("businessName") && filled("contactName") && filled("email") && filled("phone"),
      sell: !e.products && !e.madeByYou && filled("products") && filled("madeByYou"),
      food: filled("foodStatus") && !e.hffaAck,
      booth: boothMode !== "custom" || (!e.bw && !e.bd),
      logistics: filled("availability") || filled("phoneType") || filled("heardFrom") || filled("notes"),
    } as Record<string, boolean>;
  }, [validate, f, boothMode]);

  const doneCount = SECTIONS.filter((s) => sectionDone[s.id]).length;
  const pct = Math.round((doneCount / SECTIONS.length) * 100);

  // Highlight whichever section the reader is actually looking at.
  useEffect(() => {
    if (sent || typeof IntersectionObserver === "undefined") return;
    const nodes = SECTIONS.map((s) => document.getElementById(s.id)).filter(Boolean) as HTMLElement[];
    if (!nodes.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((en) => en.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActiveSection(vis.target.id);
      },
      { rootMargin: "-40% 0px -50% 0px", threshold: 0 }
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [sent]);

  /* -------------------------------------------------------------- submit -- */

  const focusFirstInvalid = (e: Errors) => {
    const key = FIELD_ORDER.find((k) => e[k]);
    if (!key) return;
    const el = fieldRefs.current[key];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    try { (el as HTMLElement & { focus: (o?: FocusOptions) => void }).focus({ preventScroll: true }); } catch { el.focus(); }
  };

  const submit = async () => {
    setMsg("");
    const e = validate();
    setErrors(e);
    if (Object.keys(e).some((k) => e[k])) {
      setMsg(`Almost there — ${Object.values(e).filter(Boolean).length === 1 ? "one field needs" : "a few fields need"} a look before we can send this.`);
      focusFirstInvalid(e);
      return;
    }
    setBusy(true);
    const licenses = f.foodStatus
      ? `${f.foodStatus}${isFood && hffaAck ? " — HFFA rules read & acknowledged" : ""}${f.licenseNotes ? ` · ${f.licenseNotes}` : ""}`
      : "";
    const res = await fetch("/api/public/apply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...f, licenses, boothRequest, spaceKey: chosen?.key || "", website: "" }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setMsg(data.error || "Couldn't submit — check the required fields."); return; }
    clearDraft();
    if (data.waitlisted) setWaitInfo({ position: Number(data.position) || 0, spaceName: String(data.spaceName || "") });
    setSent(true);
  };

  /* ----------------------------------------------------------- confirmed -- */

  if (sent) {
    return (
      <main className="public-wrap public-narrow">
        <div className="hero">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 120, margin: "0 auto var(--sp-3)", display: "block" }} />
          <h1 className="hero-title">{waitInfo ? "You're on the waiting list" : "Application sent"}</h1>
          <p className="hero-sub">
            {waitInfo ? (
              <>
                Thanks{f.contactName ? `, ${f.contactName.trim().split(/\s+/)[0]}` : ""} —{" "}
                {waitInfo.spaceName || "that space"} is full right now, so you&rsquo;re
                {waitInfo.position > 0 ? <> <b>number {waitInfo.position}</b> on the list</> : " on the list"}.
                We work down it in the order applications arrive.
              </>
            ) : (
              <>
                Thanks{f.contactName ? `, ${f.contactName.trim().split(/\s+/)[0]}` : ""} — we read every application ourselves,
                and we reply to all of them either way.
              </>
            )}
          </p>
        </div>

        <Card title="What happens next">
          <ol className="stack g-3" style={{ margin: 0, paddingLeft: "var(--sp-5)", fontSize: "var(--fs-base)", lineHeight: 1.6 }}>
            <li>
              <b>We read it within a few days.</b> Applications are reviewed in the order they arrive.
            </li>
            <li>
              <b>Watch your email{f.email ? ` at ${f.email.trim()}` : ""}.</b> Our reply lands there — check spam if it&rsquo;s quiet.
            </li>
            <li>
              <b>If it&rsquo;s a fit, we call{f.phone ? ` ${f.phone.trim()}` : ""}.</b> That call settles your booth size, your spot,
              and your start date.
            </li>
            <li>
              <b>Then you set up.</b> You&rsquo;ll get a contract to sign and a vendor account — the setup guide walks you through
              your first products and barcode labels.
            </li>
          </ol>
        </Card>

        <div className="stack g-3 mt-4">
          <LinkButton href="/market" variant="primary" size="lg" block icon="store">See the market</LinkButton>
          <div className="row g-2 wrap">
            <LinkButton href="/guide" variant="secondary" className="grow" icon="help">Read the vendor setup guide</LinkButton>
            <LinkButton href="/rules" variant="secondary" className="grow" icon="clipboard">Booth standards</LinkButton>
          </div>
        </div>

        <p className="t-xs t-muted mt-6" style={{ textAlign: "center" }}>
          Need to change something on your application? Reply to our email and we&rsquo;ll update it.
        </p>
      </main>
    );
  }

  /* ----------------------------------------------------------------- form -- */

  const errCount = Object.values(errors).filter(Boolean).length;

  return (
    <>
      <header className="public-header">
        <div className="public-header-inner">
          <a href="/market" aria-label="Community Harvest" style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wordmark.png" alt="Community Harvest" style={{ width: 150, maxWidth: "46vw", height: "auto", display: "block" }} />
          </a>
          <LinkButton href="/market" variant="ghost" size="sm" icon="arrowLeft" className="shrink0">Market</LinkButton>
        </div>
      </header>

      <main className="public-wrap public-narrow">
        <div className="hero">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 110, margin: "0 auto var(--sp-3)", display: "block" }} />
          <h1 className="hero-title">Become a vendor</h1>
          <p className="hero-sub">
            Year-round indoor market in Noble, Oklahoma. Booths are sized to fit you and priced by the square foot —
            a standard 5×5 runs ${standardRent.toFixed(0)}/mo. We run the register: you make it, we sell it, you get paid.
          </p>
        </div>

        <SponsorBanner banner={banner} />

        <Note tone="success" title="Space for about 15 standard booths">
          That number shrinks as vendors claim bigger spaces — applications are reviewed in the order they arrive.
          Applying is free. <a href="/rules">Booth standards →</a>
        </Note>

        <div className="mt-4 stack g-4">
          <Card title="What your booth rent gets you">
            <ul className="stack g-2" style={{ margin: 0, paddingLeft: "var(--sp-5)", fontSize: "var(--fs-base)", lineHeight: 1.65 }}>
              <li><b>We sell for you, every open day.</b> Our staffed register rings your barcoded items — no sitting a table, no card reader to buy, no cash box to manage.</li>
              <li><b>Your own vendor account.</b> Manage your inventory and prices from your phone, print your own barcode labels, and watch sales and your running balance live.</li>
              <li><b>Know the moment you sell.</b> Push notifications on each sale, or one end-of-day summary email — your choice.</li>
              <li><b>Sales tax handled.</b> The market collects and remits Oklahoma sales tax on every register sale, so you don&rsquo;t have to.</li>
              <li><b>Your own public page.</b> Customer reviews, your live product list on our market directory, and a printed QR card for your table that connects shoppers straight to you.</li>
              <li><b>Pre-orders with online payment.</b> Customers can message you, you accept with a price and pickup date, they pay securely by card — the money lands in your vendor balance automatically.</li>
              <li><b>A private customer inbox.</b> Pre-orders, requests, and questions come to you directly; you reply from your portal.</li>
              <li><b>Clean, honest books.</b> Rent bills itself on the 1st (first and final months prorate by the day), every sale and payout shows on your statement, and you&rsquo;re paid out monthly.</li>
            </ul>
          </Card>

          <Card title="How we operate">
            <p className="t-body" style={{ lineHeight: 1.7, margin: 0 }}>
              We&rsquo;re a homegrown-and-homemade market: you make it or grow it, we sell it.
              Restocking happens in morning (7&ndash;8 AM) and evening (6&ndash;8 PM) windows, coordinated with staff so the sales floor stays pleasant for shoppers &mdash; pre-order handoffs are welcome anytime.
              Booth rent is priced by the square foot, month to month, with 30 days&rsquo; notice to leave.
              Prefer outside? We also offer <b>outdoor tent spots at a daily rate</b> &mdash; manned by you, weather permitting.
              Everything else gets settled person-to-person on your setup call.
            </p>
          </Card>
        </div>

        {/* ------------------------------------------------------ progress -- */}
        <div
          style={{
            position: "sticky",
            top: "calc(var(--topbar-h) + env(safe-area-inset-top))",
            zIndex: "var(--z-sticky)",
            background: "var(--bg)",
            borderBottom: "1px solid var(--border)",
            // Bleed to the container edges so nothing scrolls through the gutters.
            padding: "var(--sp-3) var(--sp-4)",
            margin: "var(--sp-6) calc(var(--sp-4) * -1) var(--sp-4)",
          }}
        >
          <div className="row between g-2 wrap mb-2">
            <span className="t-label" style={{ color: "var(--text)" }}>
              Your application · {doneCount} of {SECTIONS.length} sections done
            </span>
            <span
              className="t-xs t-muted row g-1"
              aria-live="polite"
              style={{ opacity: draftNote ? 1 : 0, transition: "opacity var(--dur) var(--ease)" }}
            >
              <Icon name="check" size={12} />
              {draftNote === "restored" ? "Draft restored" : "Draft saved"}
            </span>
          </div>

          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={SECTIONS.length}
            aria-valuenow={doneCount}
            aria-valuetext={`${doneCount} of ${SECTIONS.length} sections done`}
            style={{ height: 6, borderRadius: "var(--r-full)", background: "var(--bg-sunken)", overflow: "hidden" }}
          >
            <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", transition: "width var(--dur-slow) var(--ease)" }} />
          </div>

          <div className="row g-2 wrap mt-2">
            {SECTIONS.map((s, i) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="t-xs row g-1"
                aria-current={activeSection === s.id ? "step" : undefined}
                style={{
                  textDecoration: "none",
                  padding: "var(--sp-1) var(--sp-2)",
                  borderRadius: "var(--r-full)",
                  border: "1px solid var(--border)",
                  background: activeSection === s.id ? "var(--accent-soft)" : "transparent",
                  color: sectionDone[s.id] ? "var(--accent-text)" : "var(--text-secondary)",
                  fontWeight: activeSection === s.id ? 600 : 400,
                }}
              >
                {sectionDone[s.id] ? <Icon name="check" size={12} /> : <span className="num">{i + 1}.</span>}
                {s.label}
              </a>
            ))}
          </div>
        </div>

        {/* -------------------------------------------------------- basics -- */}
        <div id="basics" style={{ scrollMarginTop: "calc(var(--topbar-h) + 150px)" }}>
          <Card title="The basics" className="mb-4">
            <div className="stack g-4">
              <Field label="Business / booth name" error={errors.businessName} required>
                {(p) => <Input {...p} ref={bindRef("businessName")} value={f.businessName || ""} onChange={set("businessName")} autoComplete="organization" />}
              </Field>
              <Field label="Your name" error={errors.contactName} required>
                {(p) => <Input {...p} ref={bindRef("contactName")} value={f.contactName || ""} onChange={set("contactName")} autoComplete="name" />}
              </Field>
              <Field label="Email" hint="Our reply goes here." error={errors.email} required>
                {(p) => <Input {...p} ref={bindRef("email")} type="email" inputMode="email" value={f.email || ""} onChange={set("email")} autoComplete="email" />}
              </Field>
              <Field label="Phone" hint="If accepted, this is the number we'll call with next steps." error={errors.phone} required>
                {(p) => <Input {...p} ref={bindRef("phone")} type="tel" inputMode="tel" value={f.phone || ""} onChange={set("phone")} autoComplete="tel" />}
              </Field>
            </div>
          </Card>
        </div>

        {/* ---------------------------------------------------- what you sell -- */}
        <div id="sell" style={{ scrollMarginTop: "calc(var(--topbar-h) + 150px)" }}>
          <Card title="What you sell" className="mb-4">
            <div className="stack g-4">
              <Field label="Category">
                {(p) => (
                  <Select {...p} value={f.category || ""} onChange={set("category")}>
                    <option value="">Choose one…</option>
                    <option>Produce / farm goods</option>
                    <option>Baked goods</option>
                    <option>Jams, honey, pantry</option>
                    <option>Meat / eggs / dairy</option>
                    <option>Crafts / handmade goods</option>
                    <option>Art</option>
                    <option>Bath &amp; body</option>
                    <option>Other</option>
                  </Select>
                )}
              </Field>
              <Field label="Tell us about your products" hint="What you make, what it sells for, what makes it good." error={errors.products} required>
                {(p) => <Textarea {...p} ref={bindRef("products")} rows={4} value={f.products || ""} onChange={set("products")} />}
              </Field>
              <Field
                label="Who makes or grows it?"
                hint="We're a homegrown + homemade market — resale of manufactured goods generally isn't a fit. Be straight with us."
                error={errors.madeByYou}
                required
              >
                {(p) => <Textarea {...p} ref={bindRef("madeByYou")} rows={2} value={f.madeByYou || ""} onChange={set("madeByYou")} />}
              </Field>
              <Field label="Photos of your work — links" hint="Facebook, Instagram, website, or a shared photo album.">
                {(p) => <Input {...p} value={f.links || ""} onChange={set("links")} placeholder="instagram.com/yourbooth" />}
              </Field>
            </div>
          </Card>
        </div>

        {/* ---------------------------------------------------- food vendors -- */}
        <div id="food" style={{ scrollMarginTop: "calc(var(--topbar-h) + 150px)" }}>
          <Card title="Food vendors — Oklahoma's rules" className="mb-4">
            <div className="stack g-4">
              <div
                className="t-sm"
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-lg)",
                  background: "var(--bg-sunken)",
                  padding: "var(--sp-3) var(--sp-4)",
                  lineHeight: 1.6,
                }}
              >
                Good news: under Oklahoma&rsquo;s <b>Homemade Food Freedom Act</b>, most homemade food needs <b>no license and no inspection</b>. You just have to follow these:
                <ul style={{ margin: "var(--sp-2) 0 0 var(--sp-5)", listStyle: "disc" }}>
                  <li><b>Label every product</b> (10-point font or larger): your name and contact (or your optional $15/yr ODAFF registration number instead of your home address), the product&rsquo;s ingredients, a note for any of the 9 major allergens (milk, eggs, peanuts, tree nuts, fish, shellfish, wheat, soy, sesame), and this exact sentence: <i>&ldquo;This product was produced in a private residence that is exempt from government licensing and inspection.&rdquo;</i></li>
                  <li><b>Under $75,000/year</b> in homemade food sales.</li>
                  <li><b>Refrigerated items are the big one for our market:</b> Oklahoma law says homemade foods needing refrigeration require accredited food-safety training and must be sold by the producer <b>directly</b> to the customer. That means <b>you man your booth and hand those sales across the table yourself</b> — refrigerated items can&rsquo;t ring through the market&rsquo;s register. Shelf-stable goods sell through our register every open day, booth attended or not.</li>
                </ul>
              </div>

              <Field label="Which describes your food products?">
                {(p) => (
                  <Select {...p} value={f.foodStatus || ""} onChange={set("foodStatus")}>
                    <option value="">Choose one…</option>
                    <option>Not a food vendor</option>
                    <option>Shelf-stable homemade foods, labeled per HFFA</option>
                    <option>Some refrigerated items — let&apos;s talk</option>
                    <option>Made in a licensed commercial kitchen</option>
                  </Select>
                )}
              </Field>

              {isFood && (
                <div ref={bindRef("hffaAck")} tabIndex={-1} style={{ outline: "none" }}>
                  <Checkbox
                    checked={hffaAck}
                    onCheckedChange={(v) => { setHffaAck(v); setErrors((e) => ({ ...e, hffaAck: undefined })); }}
                    label="I've read the rules above and my products will comply, labels included."
                  />
                  {errors.hffaAck && (
                    <p className="field-error mt-1" role="alert"><Icon name="alert" size={13} /> {errors.hffaAck}</p>
                  )}
                </div>
              )}

              <Field label="Anything else about your kitchen or licensing?" hint="Optional — commercial kitchen, ODAFF registration, food-safety training, etc.">
                {(p) => <Input {...p} value={f.licenseNotes || ""} onChange={set("licenseNotes")} />}
              </Field>

              <Field label="Liability insurance?">
                {(p) => (
                  <Select {...p} value={f.insurance || ""} onChange={set("insurance")}>
                    <option value="">Choose one…</option>
                    <option>Yes, currently insured</option>
                    <option>No, but willing to obtain</option>
                    <option>No</option>
                    <option>Not sure what I need</option>
                  </Select>
                )}
              </Field>
            </div>
          </Card>
        </div>

        {/* ----------------------------------------------------- booth size -- */}
        <div id="booth" style={{ scrollMarginTop: "calc(var(--topbar-h) + 150px)" }}>
          <Card title="What you're applying for" subtitle="What's open right now, and what it costs." className="mb-4">
            <div className="stack g-4">
              <p className="t-sm t-secondary" style={{ margin: 0 }}>
                Pick what suits you — the final size and spot get settled on the call.
              </p>

              {/* Cards, not a segmented control: each option now carries a
                  price, what it includes, and how many are left, and none of
                  that fits in a tab. */}
              <div className="grid-auto" style={{ ["--min" as string]: "230px" }}>
                {offers.map((o) => {
                  const picked = boothMode === o.key;
                  return (
                    <button
                      key={o.key}
                      type="button"
                      aria-pressed={picked}
                      onClick={() => { setBoothMode(o.key); setErrors((e) => ({ ...e, bw: undefined, bd: undefined })); }}
                      className="stack g-2"
                      style={{
                        textAlign: "left", cursor: "pointer", padding: "var(--sp-4)",
                        borderRadius: "var(--r-lg)", background: picked ? "var(--accent-soft)" : "var(--surface)",
                        border: `2px solid ${picked ? "var(--accent)" : "var(--border)"}`,
                      }}
                    >
                      <span className="row between g-2" style={{ alignItems: "flex-start" }}>
                        <b className="t-body">{o.name}</b>
                        {o.waitlist
                          ? <Badge tone="warn">Waiting list</Badge>
                          : o.left === null
                            ? <Badge tone="success" dot>Available</Badge>
                            : <Badge tone="success" dot>{o.left} left</Badge>}
                      </span>
                      <span className="t-sm" style={{ fontWeight: 600 }}>{o.terms}</span>
                      {o.blurb ? <span className="t-xs t-muted">{o.blurb}</span> : null}
                    </button>
                  );
                })}
              </div>

              <Segmented<BoothMode>
                label="Or something else"
                value={boothMode === "custom" || boothMode === "tent" ? boothMode : ""}
                onChange={(v) => { if (v) { setBoothMode(v); setErrors((e) => ({ ...e, bw: undefined, bd: undefined })); } }}
                options={[
                  { value: "", label: "One of the above" },
                  { value: "custom", label: "Custom size" },
                  { value: "tent", label: "Outdoor tent — daily" },
                ]}
              />

              {/* Said before they fill the form in, not after they send it. */}
              {chosen?.waitlist ? (
                <Note tone="warn" title={`${chosen.name} is full right now`}>
                  You can still apply — your application goes on the <b>waiting list in the order it arrives</b>,
                  and we work down the list as spaces free up. We&rsquo;ll email you your place on the list.
                </Note>
              ) : null}
              {chosen && chosen.commissionPercent > 0 ? (
                <Note tone="info" title="How market space works">
                  Your items go on our shelves and sell through our register — no booth of your own to set up or man.
                  It&rsquo;s {priceOf(chosen)} a month plus <b>{chosen.commissionPercent}% commission</b> on what sells;
                  the rest is paid out to you.
                </Note>
              ) : null}

              {boothMode === "tent" && (
                <Note tone="info" title="Outdoor tent spots — how they work">
                  <ul style={{ margin: "var(--sp-1) 0 0 var(--sp-5)", listStyle: "disc", lineHeight: 1.65 }}>
                    <li><b>$25 per day.</b> A $12.50 deposit (half) books your date at <a href="/tents">our tent booking page</a>; the $12.50 balance is due at the front desk when you set up.</li>
                    <li><b>Bring your own tent and tables</b> — the market doesn&rsquo;t supply them. Your tent must be <b>manned by you</b> the whole time; outdoor sales are yours, hand to hand.</li>
                    <li>Outdoor days are <b>contingent on weather</b>. If we call a weather day, deposits are non-refundable but <b>apply in full to a future date</b>.</li>
                  </ul>
                </Note>
              )}

              {boothMode === "custom" && (
                <>
                  <div className="row-top g-3 wrap">
                    <Field label="Width (ft)" error={errors.bw} className="shrink0">
                      {(p) => (
                        <Input
                          {...p}
                          ref={bindRef("bw")}
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          value={bw}
                          onChange={(e) => { setBw(e.target.value); setErrors((x) => ({ ...x, bw: undefined })); }}
                          style={{ width: 110 }}
                        />
                      )}
                    </Field>
                    <Field label="Depth (ft)" error={errors.bd} className="shrink0">
                      {(p) => (
                        <Input
                          {...p}
                          ref={bindRef("bd")}
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          value={bd}
                          onChange={(e) => { setBd(e.target.value); setErrors((x) => ({ ...x, bd: undefined })); }}
                          style={{ width: 110 }}
                        />
                      )}
                    </Field>
                  </div>
                  <p className="t-body num" style={{ margin: 0, fontWeight: 600 }} aria-live="polite">
                    {sqft} sqft → ${customRent.toFixed(2)}/mo
                  </p>
                </>
              )}
            </div>
          </Card>
        </div>

        {/* ------------------------------------------------------ logistics -- */}
        <div id="logistics" style={{ scrollMarginTop: "calc(var(--topbar-h) + 150px)" }}>
          <Card title="Logistics" className="mb-4">
            <div className="stack g-4">
              <Field
                label="How often can you stock your booth?"
                hint="Booths are rented monthly; the market sells for you every open day — you restock on your schedule."
              >
                {(p) => <Input {...p} value={f.availability || ""} onChange={set("availability")} placeholder="Weekly restock, more in spring" />}
              </Field>
              <Field label="How did you hear about us?">
                {(p) => <Input {...p} value={f.heardFrom || ""} onChange={set("heardFrom")} />}
              </Field>
              <div className="field">
                <span className="field-label">What kind of phone do you use?</span>
                <Segmented<string>
                  label="What kind of phone do you use?"
                  value={f.phoneType || ""}
                  onChange={(v) => setF((x) => ({ ...x, phoneType: v }))}
                  options={[
                    { value: "IPHONE", label: "iPhone" },
                    { value: "ANDROID", label: "Android" },
                    { value: "OTHER", label: "Something else" },
                  ]}
                />
                <p className="field-hint">
                  If you&rsquo;re selected, your signed contract comes with a setup guide made for your phone.
                </p>
              </div>
              <Field label="Anything else we should know?">
                {(p) => <Textarea {...p} rows={2} value={f.notes || ""} onChange={set("notes")} />}
              </Field>
            </div>
          </Card>
        </div>

        {/* --------------------------------------------------------- submit -- */}
        <Card>
          <div className="stack g-3">
            {msg && (
              <Note tone="error" title={errCount ? "Check these before sending" : "Couldn't submit"}>
                {msg}
              </Note>
            )}
            <Button variant="primary" size="lg" block loading={busy} onClick={submit} icon="check">
              Submit application
            </Button>
            <p className="t-xs t-muted" style={{ margin: 0 }}>
              Fields marked * are required. We review personally and reply to every application.
              Your answers save to this device as you type, so you can come back to them.
            </p>
          </div>
        </Card>
      </main>
    </>
  );
}

"use client";

import { useEffect, useState } from "react";

const F = (props: { label: string; hint?: string; children: React.ReactNode }) => (
  <div>
    <label>{props.label}</label>
    {props.hint && <div style={{ fontSize: 11.5, color: "var(--ash)", margin: "-2px 0 4px" }}>{props.hint}</div>}
    {props.children}
  </div>
);

export default function ApplyPage() {
  const [f, setF] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ enabled: boolean; title: string; dateLine: string; message: string } | null>(null);
  const [rate, setRate] = useState(6);
  const [boothMode, setBoothMode] = useState<"standard" | "custom" | "tent">("standard");
  const [bw, setBw] = useState("5");
  const [bd, setBd] = useState("5");
  const [hffaAck, setHffaAck] = useState(false);
  const [msg, setMsg] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    fetch("/api/public/banner").then(async (r) => { if (r.ok) setBanner((await r.json()).banner); }).catch(() => {});
    fetch("/api/public/rates").then(async (r) => { if (r.ok) setRate((await r.json()).rentPerSqft || 6); }).catch(() => {});
  }, []);

  const sqft = Math.max(0, (Number(bw) || 0) * (Number(bd) || 0));
  const customRent = Math.round(sqft * rate * 100) / 100;
  const standardRent = Math.round(25 * rate * 100) / 100;
  const boothRequest = boothMode === "standard"
    ? `Standard 5×5 — $${standardRent.toFixed(2)}/mo`
    : boothMode === "custom"
    ? `Custom ${bw || "?"}×${bd || "?"} (${sqft} sqft) — $${customRent.toFixed(2)}/mo`
    : "Outdoor tent — daily rate";

  const isFood = !!f.foodStatus && f.foodStatus !== "Not a food vendor";

  const submit = async () => {
    setMsg("");
    if (isFood && !hffaAck) { setMsg("Food vendors: please read and check the Oklahoma homemade-food rules box."); return; }
    setBusy(true);
    const licenses = f.foodStatus
      ? `${f.foodStatus}${isFood && hffaAck ? " — HFFA rules read & acknowledged" : ""}${f.licenseNotes ? ` · ${f.licenseNotes}` : ""}`
      : "";
    const res = await fetch("/api/public/apply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...f, licenses, boothRequest, website: "" }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setMsg(data.error || "Couldn't submit — check the required fields."); return; }
    setSent(true);
  };

  if (sent) {
    return (
      <main style={{ maxWidth: 520, margin: "0 auto", padding: "60px 14px", textAlign: "center" }}>
        <img src="/logo-receipt.png" alt="Community Harvest" style={{ width: 140, margin: "0 auto 10px", display: "block" }} />
        <div className="display" style={{ fontSize: 22 }}>APPLICATION IN ✅</div>
        <p style={{ fontSize: 14, marginTop: 10 }}>
          Thanks — we review every application personally. Watch your email; if it&rsquo;s a fit, we&rsquo;ll call you to get you set up.
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "26px 14px 70px" }}>
      <div style={{ textAlign: "center", marginBottom: 14 }}>
        <img src="/logo-receipt.png" alt="Community Harvest" style={{ width: 130, margin: "0 auto 4px", display: "block" }} />
        <div className="display" style={{ fontSize: 24 }}>BECOME A VENDOR</div>
        <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: "0.08em" }}>COMMUNITY HARVEST · FOOD AND CRAFT MARKET · NOBLE, OK</div>
        <p style={{ fontSize: 13, color: "var(--ash)", marginTop: 6 }}>
          Year-round indoor market. Booths sized to fit you — priced by the square foot (standard 5×5 runs $150/mo). We run the register — you make, we sell, you get paid.
        </p>
      </div>

      {banner?.enabled && (
        <div style={{ position: "relative", background: "#000", color: "#fff", textAlign: "center", padding: "22px 96px 18px 20px", marginBottom: 16 }}>
          <div style={{ position: "absolute", top: 14, right: -12, width: 120, height: 120, background: "#000", border: "2px dashed #fff", outline: "3px solid #000", borderRadius: "50%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, transform: "rotate(12deg)", boxShadow: "5px 6px 0 rgba(0,0,0,0.3)", zIndex: 2 }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.13em", color: "#fff" }}>SPONSORED BY</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/sponsor-lightfoot.png" alt="Lightfoot Roofs" style={{ width: "72%", height: "auto", display: "block" }} />
          </div>
          <div className="display" style={{ fontSize: 26, letterSpacing: "0.04em" }}>{banner.title}</div>
          <div className="display" style={{ fontSize: 17, marginTop: 6 }}>{banner.dateLine}</div>
          {banner.message && <div style={{ fontSize: 13, marginTop: 8 }}>{banner.message}</div>}
        </div>
      )}

      <div style={{ border: "2px solid #000", textAlign: "center", padding: "12px 14px", marginBottom: 16 }}>
        <div className="display" style={{ fontSize: 17 }}>15 STANDARD BOOTHS AVAILABLE</div>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 4 }}>
          Depending on vendor space needs, final availability may be more or less — applications are reviewed in the order they arrive.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 className="display" style={{ fontSize: 15, marginBottom: 6 }}>WHAT YOUR BOOTH RENT GETS YOU</h2>
        <ul style={{ margin: "0 0 0 18px", fontSize: 13, lineHeight: 1.75, listStyle: "disc" }}>
          <li><b>We sell for you, every open day.</b> Our staffed register rings your barcoded items — no sitting a table, no card reader to buy, no cash box to manage.</li>
          <li><b>Your own vendor account.</b> Manage your inventory and prices from your phone, print your own barcode labels, and watch sales and your running balance live.</li>
          <li><b>Know the moment you sell.</b> Push notifications on each sale, or one end-of-day summary email — your choice.</li>
          <li><b>Sales tax handled.</b> The market collects and remits Oklahoma sales tax on every register sale, so you don&rsquo;t have to.</li>
          <li><b>Your own public page.</b> Customer reviews, your live product list on our market directory, and a printed QR card for your table that connects shoppers straight to you.</li>
          <li><b>Pre-orders with online payment.</b> Customers can message you, you accept with a price and pickup date, they pay securely by card — the money lands in your vendor balance automatically.</li>
          <li><b>A private customer inbox.</b> Pre-orders, requests, and questions come to you directly; you reply from your portal.</li>
          <li><b>Clean, honest books.</b> Rent bills itself on the 1st (first and final months prorate by the day), every sale and payout shows on your statement, and you&rsquo;re paid out monthly.</li>
        </ul>
        <h2 className="display" style={{ fontSize: 15, margin: "14px 0 6px" }}>HOW WE OPERATE</h2>
        <p style={{ fontSize: 13, lineHeight: 1.7, margin: 0 }}>
          We&rsquo;re a homegrown-and-homemade market: you make it or grow it, we sell it.
          Restocking happens in morning (7&ndash;8 AM) and evening (6&ndash;8 PM) windows, coordinated with staff so the sales floor stays pleasant for shoppers &mdash; pre-order handoffs are welcome anytime.
          Booth rent is priced by the square foot, month to month, with 30 days&rsquo; notice to leave.
          Prefer outside? We also offer <b>outdoor tent spots at a daily rate</b> &mdash; manned by you, weather permitting.
          Everything else gets settled person-to-person on your setup call.
        </p>
      </div>

      <div className="card">
        <h2 className="display" style={{ fontSize: 15, marginBottom: 2 }}>THE BASICS</h2>
        <F label="Business / booth name *"><input value={f.businessName || ""} onChange={set("businessName")} /></F>
        <F label="Your name *"><input value={f.contactName || ""} onChange={set("contactName")} /></F>
        <F label="Email *"><input type="email" value={f.email || ""} onChange={set("email")} /></F>
        <F label="Phone *" hint="If accepted, this is the number we'll call with next steps."><input type="tel" value={f.phone || ""} onChange={set("phone")} /></F>

        <h2 className="display" style={{ fontSize: 15, margin: "16px 0 2px" }}>WHAT YOU SELL</h2>
        <F label="Category">
          <select value={f.category || ""} onChange={set("category")}>
            <option value="">Choose one…</option>
            <option>Produce / farm goods</option>
            <option>Baked goods</option>
            <option>Jams, honey, pantry</option>
            <option>Meat / eggs / dairy</option>
            <option>Crafts / handmade goods</option>
            <option>Art</option>
            <option>Bath & body</option>
            <option>Other</option>
          </select>
        </F>
        <F label="Tell us about your products *" hint="What you make, what it sells for, what makes it good.">
          <textarea rows={4} value={f.products || ""} onChange={set("products")} />
        </F>
        <F label="Who makes / grows it? *" hint="We're a homegrown + homemade market — resale of manufactured goods generally isn't a fit. Be straight with us.">
          <textarea rows={2} value={f.madeByYou || ""} onChange={set("madeByYou")} />
        </F>
        <F label="Photos of your work — links" hint="Facebook, Instagram, website, or a shared photo album.">
          <input value={f.links || ""} onChange={set("links")} placeholder="instagram.com/yourbooth" />
        </F>

        <h2 className="display" style={{ fontSize: 15, margin: "16px 0 2px" }}>FOOD VENDORS — OKLAHOMA&rsquo;S RULES</h2>
        <div style={{ fontSize: 12.5, border: "1px solid #000", padding: "10px 12px", lineHeight: 1.6, margin: "6px 0" }}>
          Good news: under Oklahoma&rsquo;s <b>Homemade Food Freedom Act</b>, most homemade food needs <b>no license and no inspection</b>. You just have to follow these:
          <ul style={{ margin: "6px 0 0 18px", listStyle: "disc" }}>
            <li><b>Label every product</b> (10-point font or larger): your name and contact (or your optional $15/yr ODAFF registration number instead of your home address), the product&rsquo;s ingredients, a note for any of the 9 major allergens (milk, eggs, peanuts, tree nuts, fish, shellfish, wheat, soy, sesame), and this exact sentence: <i>&ldquo;This product was produced in a private residence that is exempt from government licensing and inspection.&rdquo;</i></li>
            <li><b>Under $75,000/year</b> in homemade food sales.</li>
            <li><b>Refrigerated items are the big one for our market:</b> Oklahoma law says homemade foods needing refrigeration require accredited food-safety training and must be sold by the producer <b>directly</b> to the customer. That means <b>you man your booth and hand those sales across the table yourself</b> — refrigerated items can&rsquo;t ring through the market&rsquo;s register. Shelf-stable goods sell through our register every open day, booth attended or not.</li>
          </ul>
        </div>
        <F label="Which describes your food products?">
          <select value={f.foodStatus || ""} onChange={set("foodStatus")}>
            <option value="">Choose one…</option>
            <option>Not a food vendor</option>
            <option>Shelf-stable homemade foods, labeled per HFFA</option>
            <option>Some refrigerated items — let&apos;s talk</option>
            <option>Made in a licensed commercial kitchen</option>
          </select>
        </F>
        {isFood && (
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", fontWeight: 600, fontSize: 12.5 }}>
            <input type="checkbox" checked={hffaAck} onChange={(e) => setHffaAck(e.target.checked)} style={{ width: "auto", marginTop: 2 }} />
            I&rsquo;ve read the rules above and my products will comply, labels included.
          </label>
        )}
        <F label="Anything else about your kitchen or licensing?" hint="Optional — commercial kitchen, ODAFF registration, food-safety training, etc.">
          <input value={f.licenseNotes || ""} onChange={set("licenseNotes")} />
        </F>
        <F label="Liability insurance?">
          <select value={f.insurance || ""} onChange={set("insurance")}>
            <option value="">Choose one…</option>
            <option>Yes, currently insured</option>
            <option>No, but willing to obtain</option>
            <option>No</option>
            <option>Not sure what I need</option>
          </select>
        </F>

        <h2 className="display" style={{ fontSize: 15, margin: "16px 0 2px" }}>BOOTH SIZE</h2>
        <div style={{ fontSize: 12, color: "var(--ash)", margin: "2px 0 6px" }}>Booths price by the square foot (${rate}/sqft per month). Pick the standard or tell us what you need — final size and spot get settled on the call.</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" className={`btn small ${boothMode === "standard" ? "" : "ghost"}`} onClick={() => setBoothMode("standard")}>
            STANDARD 5×5 — ${standardRent.toFixed(0)}/MO
          </button>
          <button type="button" className={`btn small ${boothMode === "custom" ? "" : "ghost"}`} onClick={() => setBoothMode("custom")}>
            CUSTOM SIZE
          </button>
          <button type="button" className={`btn small ${boothMode === "tent" ? "" : "ghost"}`} onClick={() => setBoothMode("tent")}>
            OUTDOOR TENT — DAILY
          </button>
        </div>
        {boothMode === "tent" && (
          <div style={{ fontSize: 12.5, border: "1px solid #000", padding: "10px 12px", lineHeight: 1.65, marginTop: 8 }}>
            <b>Outdoor tent spots — how they work:</b>
            <ul style={{ margin: "4px 0 0 18px", listStyle: "disc" }}>
              <li><b>$25 per day.</b> A $12.50 deposit (half) books your date at <b>market.dailybreadbaked.com/tents</b>; the $12.50 balance is due at the front desk when you set up.</li>
              <li><b>Bring your own tent and tables</b> — the market doesn&rsquo;t supply them. Your tent must be <b>manned by you</b> the whole time; outdoor sales are yours, hand to hand.</li>
              <li>Outdoor days are <b>contingent on weather</b>. If we call a weather day, deposits are non-refundable but <b>apply in full to a future date</b>.</li>
            </ul>
          </div>
        )}
        {boothMode === "custom" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <span style={{ flex: "0 0 90px" }}><label style={{ margin: "0 0 4px" }}>Width (ft)</label>
              <input type="number" min="1" step="1" value={bw} onChange={(e) => setBw(e.target.value)} /></span>
            <b style={{ marginTop: 16 }}>×</b>
            <span style={{ flex: "0 0 90px" }}><label style={{ margin: "0 0 4px" }}>Depth (ft)</label>
              <input type="number" min="1" step="1" value={bd} onChange={(e) => setBd(e.target.value)} /></span>
            <span style={{ fontSize: 13, fontWeight: 700, marginTop: 14 }}>
              = {sqft} sqft → ${customRent.toFixed(2)}/mo
            </span>
          </div>
        )}

        <h2 className="display" style={{ fontSize: 15, margin: "16px 0 2px" }}>LOGISTICS</h2>
        <F label="How often can you stock your booth?" hint="Booths are rented monthly; the market sells for you every open day — you restock on your schedule.">
          <input value={f.availability || ""} onChange={set("availability")} placeholder="Weekly restock, more in spring" />
        </F>
        <F label="How did you hear about us?"><input value={f.heardFrom || ""} onChange={set("heardFrom")} /></F>
        <F label="Anything else we should know?"><textarea rows={2} value={f.notes || ""} onChange={set("notes")} /></F>

        <div style={{ marginTop: 16 }}>
          <button className="btn" disabled={busy} onClick={submit}>SUBMIT APPLICATION</button>
        </div>
        {msg && <p className="err">{msg}</p>}
        <p style={{ fontSize: 11, color: "var(--ash)", marginTop: 8 }}>* required · We review personally and reply to every application.</p>
      </div>
    </main>
  );
}

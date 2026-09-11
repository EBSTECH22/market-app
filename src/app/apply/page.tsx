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
  const [hffaAck, setHffaAck] = useState(false);
  const [msg, setMsg] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    fetch("/api/public/banner").then(async (r) => { if (r.ok) setBanner((await r.json()).banner); }).catch(() => {});
  }, []);

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
      body: JSON.stringify({ ...f, licenses, website: "" }),
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
          Year-round indoor market. 5×5 booths, monthly rent, we run the register — you make, we sell, you get paid.
        </p>
      </div>

      {banner?.enabled && (
        <div style={{ background: "#000", color: "#fff", textAlign: "center", padding: "18px 14px", marginBottom: 16 }}>
          <div className="display" style={{ fontSize: 26, letterSpacing: "0.04em" }}>{banner.title}</div>
          <div className="display" style={{ fontSize: 17, marginTop: 6 }}>{banner.dateLine}</div>
          {banner.message && <div style={{ fontSize: 13, marginTop: 8 }}>{banner.message}</div>}
        </div>
      )}

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
            <li><b>Refrigerated items are the big one for our market:</b> foods needing refrigeration require accredited food-safety training and by law must be sold by <b>you directly</b> to the customer — so they can&rsquo;t run through the market&rsquo;s register. <b>Shelf-stable goods can.</b> Have refrigerated products? Apply anyway — we&rsquo;ll talk through options on the call.</li>
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

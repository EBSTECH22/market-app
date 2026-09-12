"use client";

import { useCallback, useEffect, useState } from "react";
import SignaturePad from "@/components/SignaturePad";
import RulesBody, { RULES_UPDATED } from "@/components/RulesBody";

type Packet = {
  role: "STAFF" | "VENDOR";
  contract: {
    id: string; boothLabel: string; monthlyRentCents: number; startDate: string; status: string;
    vendorSignedName: string; vendorSignatureData: string; vendorSignedAt: string | null;
    marketSignedName: string; marketSignatureData: string; marketSignedAt: string | null;
  };
  vendor: { businessName: string; contactName: string; email: string; commissionPercent: number };
  application: {
    businessName: string; contactName: string; email: string; phone: string; category: string;
    products: string; madeByYou: string; links: string; licenses: string; insurance: string;
    availability: string; boothRequest: string; heardFrom: string; submittedAt: string;
  } | null;
};

const fmtDay = (d: string) => new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

function AppRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", color: "#6b7280" }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap" }}>{value}</div>
    </div>
  );
}

function SigBlock({ title, name, data, at }: { title: string; name: string; data: string; at: string | null }) {
  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      {data ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={data} alt={`${title} signature`} style={{ height: 64, display: "block", marginBottom: 2 }} />
      ) : (
        <div style={{ height: 64 }} />
      )}
      <div style={{ borderTop: "1.5px solid #111", paddingTop: 4, fontSize: 12.5 }}>
        {title}{name ? <> — <b>{name}</b></> : null}{at ? <> · {fmtDay(at)}</> : null}
      </div>
    </div>
  );
}

export default function ContractPacketView({ apiPath }: { apiPath: string }) {
  const [p, setP] = useState<Packet | null>(null);
  const [err, setErr] = useState("");
  const [signing, setSigning] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(apiPath);
    const d = await r.json();
    if (!r.ok) { setErr(d.error || "Couldn't load."); return; }
    setP(d);
  }, [apiPath]);

  useEffect(() => { load(); }, [load]);

  const sign = async (dataUrl: string, typedName: string) => {
    setSigning(true);
    const r = await fetch(apiPath, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signatureData: dataUrl, typedName }),
    });
    const d = await r.json();
    setSigning(false);
    if (!r.ok) { setErr(d.error || "Couldn't sign."); return; }
    setErr("");
    load();
  };

  if (err && !p) return <main style={{ padding: 60, textAlign: "center" }}>{err}</main>;
  if (!p) return (
    <main style={{ maxWidth: 700, margin: "0 auto", padding: "30px 20px" }}>
      <div className="skel" style={{ height: 30, width: 260, margin: "0 auto 16px" }} />
      <div className="skel" style={{ height: 500 }} />
    </main>
  );

  const c = p.contract;
  const rent = (c.monthlyRentCents / 100).toFixed(2);
  const fullySigned = !!c.vendorSignedAt && !!c.marketSignedAt;
  const mySideSigned = p.role === "VENDOR" ? !!c.vendorSignedAt : !!c.marketSignedAt;

  return (
    <main style={{ maxWidth: 700, margin: "0 auto", padding: "24px 22px 70px", background: "#fff", minHeight: "100vh", fontSize: 13.5, lineHeight: 1.55, color: "#111" }}>
      <style>{`
        @media print { .no-print { display: none !important; } .page-break { break-before: page; } main { padding: 0 !important; } }
        h2 { font-size: 14px; margin: 14px 0 4px; } p { margin: 6px 0; }
      `}</style>

      <div className="no-print" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <button className="btn small" onClick={() => window.print()}>🖨 PRINT / SAVE PDF — FULL PACKET</button>
        {fullySigned && <span className="ok" style={{ margin: 0 }}>Fully signed ✓</span>}
        {!fullySigned && mySideSigned && <span style={{ fontSize: 12.5, color: "var(--ash)", fontWeight: 600 }}>Waiting on the other signature…</span>}
      </div>

      {/* ── THE AGREEMENT ─────────────────────────────── */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="" style={{ width: 84, height: 84, display: "block", margin: "0 auto 6px" }} />
      <h1 style={{ textAlign: "center", fontSize: 20, fontWeight: 900, marginBottom: 2 }}>BOOTH RENTAL AGREEMENT</h1>
      <p style={{ textAlign: "center", color: "#555", marginBottom: 14 }}>Community Harvest — Food and Craft Market · Noble, Oklahoma</p>

      <p>
        This Booth Rental Agreement (the &ldquo;Agreement&rdquo;) is entered into as of <b>{fmtDay(c.startDate)}</b> between
        <b> Community Harvest</b> (&ldquo;Market&rdquo;) and <b>{p.vendor.businessName}</b>
        {p.vendor.contactName ? <> ({p.vendor.contactName})</> : null} (&ldquo;Vendor&rdquo;).
      </p>

      <h2>1. CONSIGNMENT; TITLE &amp; RISK OF LOSS</h2>
      <p>The Market operates on a consignment model. All goods remain <b>Vendor&rsquo;s property until sold</b>; the Market acts as Vendor&rsquo;s limited sales agent for register transactions. <b>Vendor bears all risk of loss or damage to Vendor&rsquo;s goods</b> — including theft, breakage, spoilage, or equipment failure — except loss caused by the Market&rsquo;s gross negligence or willful misconduct. Vendor is <b>strongly encouraged to carry general liability and product liability insurance</b>; the Market does not insure Vendor&rsquo;s goods or activities.</p>

      <h2>2. BOOTH &amp; RENT</h2>
      <p>Market rents Vendor booth space <b>{c.boothLabel}</b> for <b>${rent} per month</b>, due on the first day of each month. No security deposit is required. Late rent may result in suspension of selling privileges until paid. The Market may adjust rent with at least <b>thirty (30) days&rsquo; written notice</b>; Vendor&rsquo;s remedy if unwilling is termination under Section 4.</p>

      <h2>3. MONTH-TO-MONTH TERM</h2>
      <p>This Agreement runs month to month beginning on the date above and <b>automatically renews on the first day of each month</b> unless terminated as described below.</p>

      <h2>4. TERMINATION</h2>
      <p>Either party may terminate with <b>written notice at least thirty (30) days</b> before the intended end date; rent remains due through the notice period. The Market may terminate <b>immediately</b> for violation of this Agreement or the Market Rules, illegal activity, unsafe products, or nonpayment. Vendor shall remove all goods within <b>seven (7) days</b> after the end date; goods left longer are handled under Section 12. Vendor&rsquo;s final balance, net of any amounts owed to the Market, is paid with the next regular payout cycle.</p>

      <h2>5. GOODS &amp; COMPLIANCE</h2>
      <p>The Market is a homegrown and homemade marketplace. Vendor agrees to sell only items grown, raised, made, or crafted by Vendor; resale of commercially manufactured goods requires written Market approval. Items sold through the Market&rsquo;s register must be <b>shelf stable</b>. Foods requiring temperature control (TCS) that are produced under Oklahoma&rsquo;s Homemade Food Freedom Act may be sold <b>only by Vendor in person, direct to the customer, at a booth or table Vendor staffs</b> — never through the Market register. Vendor is solely responsible for compliance with all applicable law, including HFFA labeling (producer name, address, and required disclosure statements), licenses, and permits.</p>

      <h2>6. APPLICATION; MARKET RULES</h2>
      <p>Vendor&rsquo;s application to the Market is attached as <b>Exhibit A</b> and incorporated into this Agreement. <b>Vendor certifies that the statements in the application are true and complete</b>; any material misstatement is grounds for immediate termination. Vendor further agrees to follow the <b>Market Rules</b> attached as <b>Exhibit B</b> and as posted and updated by the Market from time to time, which are incorporated into this Agreement. Restocking is coordinated by Market staff per the Market Rules; delivery of accepted customer pre-orders to staff is permitted anytime. Vendor agrees to keep item quantities current in the vendor portal.</p>

      <h2>7. SALES, TAX &amp; PAYOUTS</h2>
      <p>Register sales are rung through the Market&rsquo;s central register using Vendor&rsquo;s barcoded items; the Market collects and remits applicable sales tax on those sales. Vendor proceeds{p.vendor.commissionPercent > 0 ? <>, less a <b>{p.vendor.commissionPercent}%</b> Market commission,</> : null} are credited to Vendor&rsquo;s account and paid <b>by the 15th of the following month</b>. Booth rent and other amounts owed may be deducted from Vendor&rsquo;s balance. Vendor&rsquo;s statement is available in the vendor portal; a statement is <b>deemed accepted unless disputed in writing within thirty (30) days</b>.</p>

      <h2>8. NO GUARANTEE</h2>
      <p>The Market makes <b>no guarantee of sales volume, foot traffic, booth placement, or business results</b>. Rent is for space and services, not outcomes.</p>

      <h2>9. LIABILITY &amp; INDEMNIFICATION</h2>
      <p>Vendor displays and sells at Vendor&rsquo;s own risk. Vendor is <b>solely responsible for Vendor&rsquo;s products</b>, including their safety, quality, labeling, and legality. Vendor shall <b>defend, indemnify, and hold harmless</b> the Market and its owners, employees, and agents from all claims, damages, and expenses (including reasonable attorney fees) arising out of Vendor&rsquo;s products, booth, or conduct — including product liability, foodborne illness, and intellectual-property claims relating to Vendor&rsquo;s goods.</p>

      <h2>10. MARKET CLOSURES</h2>
      <p>The Market may close for weather, holidays, or events beyond its control. If the Market is closed <b>three (3) or more scheduled selling days in a calendar month</b>, that month&rsquo;s rent is prorated for all closed days; closures of one or two days do not adjust rent.</p>

      <h2>11. ASSIGNMENT</h2>
      <p>Vendor may not assign this Agreement or sublet or share the booth without the Market&rsquo;s written consent.</p>

      <h2>12. ABANDONMENT &amp; LIEN</h2>
      <p>If Vendor fails to pay rent or abandons the booth, the Market may give written notice; if not cured within <b>fifteen (15) days</b>, the Market may remove and store Vendor&rsquo;s goods at Vendor&rsquo;s expense and is granted a <b>lien on Vendor&rsquo;s goods and account balance</b> for amounts owed. The Market may sell such goods at reasonable prices and apply proceeds to the debt, returning any excess; unsalable goods may be discarded.</p>

      <h2>13. NOTICES</h2>
      <p>Written notice is effective when sent by email to the addresses on file in the Market&rsquo;s vendor system (for the Market, the address on the Market&rsquo;s website), or when hand-delivered.</p>

      <h2>14. RELATIONSHIP; TAXES; MARKETING</h2>
      <p>Vendor is an independent business, not an employee or partner of the Market, and is responsible for Vendor&rsquo;s own income taxes. Vendor grants the Market a non-exclusive license to photograph Vendor&rsquo;s booth and products and to use Vendor&rsquo;s name, logo, and content Vendor uploads to the Market system to operate and promote the Market.</p>

      <h2>15. GENERAL</h2>
      <p>This is the entire agreement and may only be changed in writing signed by both parties (Market Rules may be updated by posting). If any provision is unenforceable, the rest remains in effect. Oklahoma law governs; venue is Cleveland County, Oklahoma. This Agreement may be signed electronically; electronic signatures captured below are intended to be binding.</p>

      <div style={{ display: "flex", gap: 40, marginTop: 26, flexWrap: "wrap" }}>
        <SigBlock title="Market" name={c.marketSignedName} data={c.marketSignatureData} at={c.marketSignedAt} />
        <SigBlock title="Vendor" name={c.vendorSignedName} data={c.vendorSignatureData} at={c.vendorSignedAt} />
      </div>

      {/* ── SIGN HERE ─────────────────────────────── */}
      {!mySideSigned && (
        <div className="card no-print" style={{ marginTop: 22, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
          <h2 className="display" style={{ fontSize: 16, margin: "0 0 4px" }}>
            {p.role === "VENDOR" ? "SIGN AS VENDOR" : "SIGN FOR THE MARKET"}
          </h2>
          <p style={{ fontSize: 12.5, color: "var(--ash)" }}>
            By signing you agree to the Agreement above, certify the attached application (Exhibit A) is true, and agree to the Market Rules (Exhibit B).
          </p>
          <SignaturePad label={signing ? "SIGNING…" : "ADOPT & SIGN"} onSign={sign} />
          {err && <p className="err">{err}</p>}
        </div>
      )}

      {/* ── EXHIBIT A: APPLICATION ─────────────────────────────── */}
      <div className="page-break" style={{ marginTop: 34, borderTop: "2px solid #111", paddingTop: 14 }}>
        <h1 style={{ fontSize: 16, fontWeight: 900 }}>EXHIBIT A — VENDOR APPLICATION</h1>
        {p.application ? (
          <>
            <p style={{ fontSize: 12, color: "#555" }}>Submitted {fmtDay(p.application.submittedAt)} · Vendor certifies these statements are true and complete.</p>
            <AppRow label="Business name" value={p.application.businessName} />
            <AppRow label="Contact" value={p.application.contactName} />
            <AppRow label="Email" value={p.application.email} />
            <AppRow label="Phone" value={p.application.phone} />
            <AppRow label="Category" value={p.application.category} />
            <AppRow label="What they make / grow" value={p.application.products} />
            <AppRow label="Made / grown by applicant" value={p.application.madeByYou} />
            <AppRow label="Links" value={p.application.links} />
            <AppRow label="Licenses / permits" value={p.application.licenses} />
            <AppRow label="Insurance" value={p.application.insurance} />
            <AppRow label="Availability" value={p.application.availability} />
            <AppRow label="Booth request" value={p.application.boothRequest} />
            <AppRow label="How they heard about us" value={p.application.heardFrom} />
          </>
        ) : (
          <p style={{ fontSize: 13, color: "#555" }}>No application on file for {p.vendor.email} — Vendor was onboarded directly by the Market.</p>
        )}
      </div>

      {/* ── EXHIBIT B: MARKET RULES ─────────────────────────────── */}
      <div className="page-break" style={{ marginTop: 30, borderTop: "2px solid #111", paddingTop: 14 }}>
        <h1 style={{ fontSize: 16, fontWeight: 900 }}>EXHIBIT B — MARKET RULES &amp; BOOTH STANDARDS</h1>
        <p style={{ fontSize: 12, color: "#555" }}>As posted at market.dailybreadbaked.com/rules · Last updated {RULES_UPDATED}. The posted version, as updated from time to time, controls.</p>
        <RulesBody />
      </div>
    </main>
  );
}

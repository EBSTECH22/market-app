"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import SignaturePad from "@/components/SignaturePad";
import RulesBody, { RULES_UPDATED } from "@/components/RulesBody";
import { Badge, Button, Card, Note, Skeleton } from "@/components/ui";

type Packet = {
  role: "STAFF" | "VENDOR";
  contract: {
    id: string; boothLabel: string; monthlyRentCents: number; startDate: string; status: string;
    vendorSignedName: string; vendorSignatureData: string; vendorSignedAt: string | null;
    marketSignedName: string; marketSignatureData: string; marketSignedAt: string | null;
    /* Which agreement this is. Missing on everything signed before the eggs
       and dairy version existed, which is exactly the standard one. */
    termsVersion?: string;
  };
  vendor: { businessName: string; contactName: string; email: string; commissionPercent: number };
  application: {
    businessName: string; contactName: string; email: string; phone: string; category: string;
    products: string; madeByYou: string; links: string; licenses: string; insurance: string;
    availability: string; boothRequest: string; heardFrom: string; submittedAt: string;
  } | null;
};

const fmtDay = (d: string) => new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

/**
 * The packet is a legal document: it is rendered on white with black text so
 * the screen matches the page that comes out of the printer. That means the
 * kit's chrome sitting on top of it (print button, signed badge, the signing
 * card) has to stay legible even when the rest of the app is in dark mode, so
 * the theme tokens are re-pointed at their light values for this subtree only.
 * These are the same token names globals.css defines — no new colours.
 */
const PAPER_TOKENS = {
  "--surface": "var(--n-0)",
  "--surface-hover": "var(--n-50)",
  "--surface-active": "var(--n-100)",
  "--bg-elevated": "var(--n-0)",
  "--bg-inset": "var(--n-50)",
  "--bg-sunken": "var(--n-100)",
  "--text": "var(--n-900)",
  "--text-secondary": "var(--n-600)",
  "--text-muted": "var(--n-500)",
  "--border": "var(--n-200)",
  "--border-strong": "var(--n-300)",
  "--border-subtle": "var(--n-150)",
  "--accent": "var(--brand-600)",
  "--accent-hover": "var(--brand-700)",
  "--accent-soft": "var(--brand-50)",
  "--accent-border": "var(--brand-200)",
  "--accent-text": "var(--brand-700)",
  "--danger-soft": "var(--danger-50)",
  "--danger-text": "var(--danger-700)",
  "--warn-soft": "var(--warn-50)",
  "--warn-text": "var(--warn-700)",
} as unknown as CSSProperties;

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

/**
 * The agreement, as a list of sections rather than fifteen hand-numbered
 * headings.
 *
 * There are two versions of it now. Writing them out twice would mean every
 * future change to a shared clause has to be made in both places, and the
 * day somebody forgets is the day two vendors are on terms that differ by
 * accident. So the shared sections are written once, the eggs-and-dairy
 * version swaps Section 1 and inserts its own section after Section 5, and
 * the numbers come from the position in the list.
 */
function agreementSections(
  eggsDairy: boolean,
  rent: string,
  boothLabel: string,
  commissionPercent: number
): { h: string; body: React.ReactNode }[] {
  const shared = {
    s1: { h: 'CONSIGNMENT; TITLE &amp; RISK OF LOSS', body: (<p>The Market operates on a consignment model. All goods remain <b>Vendor&rsquo;s property until sold</b>; the Market acts as Vendor&rsquo;s limited sales agent for register transactions. <b>Vendor bears all risk of loss or damage to Vendor&rsquo;s goods</b> — including theft, breakage, spoilage, or equipment failure — except loss caused by the Market&rsquo;s gross negligence or willful misconduct. Vendor is <b>strongly encouraged to carry general liability and product liability insurance</b>; the Market does not insure Vendor&rsquo;s goods or activities.</p>) },
    s2: { h: 'BOOTH &amp; RENT', body: (<p>Market rents Vendor booth space <b>{boothLabel}</b> for <b>${rent} per month</b>, due on the first day of each month. No security deposit is required. Late rent may result in suspension of selling privileges until paid. The Market may adjust rent with at least <b>thirty (30) days&rsquo; written notice</b>; Vendor&rsquo;s remedy if unwilling is termination under Section 4. Rent is first offset against Vendor&rsquo;s sales balance. If the balance does not cover rent, Vendor may pay the remainder by cash or check at no charge, or authorize a card on file; <b>card charges for unpaid rent include a three percent (3%) card-processing adjustment on the amount charged</b>, itemized on Vendor&rsquo;s statement. By saving a card on file, Vendor authorizes the Market to charge unpaid rent balances plus the processing adjustment to that card, and may revoke this authorization or update the card at any time in the vendor portal.</p>) },
    s3: { h: 'MONTH-TO-MONTH TERM', body: (<p>This Agreement runs month to month beginning on the date above and <b>automatically renews on the first day of each month</b> unless terminated as described below.</p>) },
    s4: { h: 'TERMINATION', body: (<p>Either party may terminate with <b>written notice at least thirty (30) days</b> before the intended end date; rent remains due through the notice period. The Market may terminate <b>immediately</b> for violation of this Agreement or the Market Rules, illegal activity, unsafe products, or nonpayment. Vendor shall remove all goods within <b>seven (7) days</b> after the end date; goods left longer are handled under Section 12. Vendor&rsquo;s final balance, net of any amounts owed to the Market, is paid with the next regular payout cycle.</p>) },
    s5: { h: 'GOODS &amp; COMPLIANCE', body: (
      <>
        <p>The Market is a homegrown and homemade marketplace. Vendor agrees to sell only items grown, raised, made, or crafted by Vendor; resale of commercially manufactured goods requires written Market approval.</p>
        <p>Homemade foods produced under Oklahoma&rsquo;s Local Food Freedom Act may be sold at the Market, <b>including through the Market&rsquo;s register</b>. Those sales are handled as Vendor&rsquo;s own: under Section 1 the Market never owns the food, takes payment only as Vendor&rsquo;s agent, and title passes directly from Vendor to the customer.</p>
        <p>Vendor is <b>solely responsible for everything that Act requires of Vendor</b> \u2014 including the approved food-safety training required before making or selling any product needing time or temperature control, the Act&rsquo;s labeling and disclosure statement, and staying within its annual gross sales limit. The Market will display the required placard for unpackaged goods. Refrigerated homemade foods must be kept at <b>41&deg;F or below</b> from delivery until sale, and Vendor shall remove anything past its date.</p>
      </>
    ) },
    s6: { h: 'APPLICATION; MARKET RULES', body: (<p>Vendor&rsquo;s application to the Market is attached as <b>Exhibit A</b> and incorporated into this Agreement. <b>Vendor certifies that the statements in the application are true and complete</b>; any material misstatement is grounds for immediate termination. Vendor further agrees to follow the <b>Market Rules</b> attached as <b>Exhibit B</b> and as posted and updated by the Market from time to time, which are incorporated into this Agreement. Restocking is coordinated by Market staff per the Market Rules; delivery of accepted customer pre-orders to staff is permitted anytime. Vendor agrees to keep item quantities current in the vendor portal.</p>) },
    s7: { h: 'SALES, TAX &amp; PAYOUTS', body: (<p>Register sales are rung through the Market&rsquo;s central register using Vendor&rsquo;s barcoded items; the Market collects and remits applicable sales tax on those sales. Vendor proceeds{commissionPercent > 0 ? <>, less a <b>{commissionPercent}%</b> Market commission,</> : null} are credited to Vendor&rsquo;s account and paid <b>by the 15th of the following month</b>. Booth rent and other amounts owed may be deducted from Vendor&rsquo;s balance. Vendor&rsquo;s statement is available in the vendor portal; a statement is <b>deemed accepted unless disputed in writing within thirty (30) days</b>.</p>) },
    s8: { h: 'NO GUARANTEE', body: (<p>The Market makes <b>no guarantee of sales volume, foot traffic, booth placement, or business results</b>. Rent is for space and services, not outcomes.</p>) },
    s9: { h: 'LIABILITY &amp; INDEMNIFICATION', body: (<p>Vendor displays and sells at Vendor&rsquo;s own risk. Vendor is <b>solely responsible for Vendor&rsquo;s products</b>, including their safety, quality, labeling, and legality. Vendor shall <b>defend, indemnify, and hold harmless</b> the Market and its owners, employees, and agents from all claims, damages, and expenses (including reasonable attorney fees) arising out of Vendor&rsquo;s products, booth, or conduct — including product liability, foodborne illness, and intellectual-property claims relating to Vendor&rsquo;s goods.</p>) },
    s10: { h: 'MARKET CLOSURES', body: (<p>The Market may close for weather, holidays, or events beyond its control. If the Market is closed <b>three (3) or more scheduled selling days in a calendar month</b>, that month&rsquo;s rent is prorated for all closed days; closures of one or two days do not adjust rent.</p>) },
    s11: { h: 'ASSIGNMENT', body: (<p>Vendor may not assign this Agreement or sublet or share the booth without the Market&rsquo;s written consent.</p>) },
    s12: { h: 'ABANDONMENT &amp; LIEN', body: (<p>If Vendor fails to pay rent or abandons the booth, the Market may give written notice; if not cured within <b>fifteen (15) days</b>, the Market may remove and store Vendor&rsquo;s goods at Vendor&rsquo;s expense and is granted a <b>lien on Vendor&rsquo;s goods and account balance</b> for amounts owed. The Market may sell such goods at reasonable prices and apply proceeds to the debt, returning any excess; unsalable goods may be discarded.</p>) },
    s13: { h: 'NOTICES', body: (<p>Written notice is effective when sent by email to the addresses on file in the Market&rsquo;s vendor system (for the Market, the address on the Market&rsquo;s website), or when hand-delivered.</p>) },
    s14: { h: 'RELATIONSHIP; TAXES; MARKETING', body: (<p>Vendor is an independent business, not an employee or partner of the Market, and is responsible for Vendor&rsquo;s own income taxes. Vendor grants the Market a non-exclusive license to photograph Vendor&rsquo;s booth and products and to use Vendor&rsquo;s name, logo, and content Vendor uploads to the Market system to operate and promote the Market.</p>) },
    s15: { h: 'GENERAL', body: (<p>This is the entire agreement and may only be changed in writing signed by both parties (Market Rules may be updated by posting). If any provision is unenforceable, the rest remains in effect. Oklahoma law governs; venue is Cleveland County, Oklahoma. This Agreement may be signed electronically; electronic signatures captured below are intended to be binding.</p>) },
  };

  /* Section 1, strengthened. Same promise the standard agreement makes —
     the goods are the vendor's until sold — said in the terms that matter
     when a regulator asks who was selling the eggs. */
  const title1 = {
    h: "TITLE, OWNERSHIP &amp; RISK OF LOSS",
    body: (
      <>
        <p>Vendor at all times retains <b>full legal and equitable title to Vendor&rsquo;s goods until the moment they are sold to a customer</b>. The Market does not purchase Vendor&rsquo;s goods, does not take title to them, and acquires no ownership interest in them at any point. The Market acts solely as <b>Vendor&rsquo;s disclosed limited sales agent</b>, authorized only to display Vendor&rsquo;s goods, to accept payment at the Market&rsquo;s central register on Vendor&rsquo;s behalf, and to hand the goods to the customer. <b>Title passes directly from Vendor to the customer</b> at the point of sale and never passes to or through the Market. The Market is not a reseller, wholesaler, distributor, or purchaser for resale of Vendor&rsquo;s goods.</p>
        <p><b>Vendor bears all risk of loss or damage to Vendor&rsquo;s goods</b> — including theft, breakage, spoilage, pest damage, power loss, and refrigeration or other equipment failure — except loss caused by the Market&rsquo;s gross negligence or willful misconduct. The Market does not insure Vendor&rsquo;s goods or activities. Vendor is strongly encouraged to carry general liability and product liability insurance; <b>Vendor must carry product liability insurance of not less than $1,000,000 per occurrence in order to sell eggs or dairy products under Section 6</b>, and shall name the Market as an additional insured and provide a certificate of insurance before placing any such product.</p>
      </>
    ),
  };

  const eggsDairySection = {
    h: "EGGS &amp; DAIRY",
    body: (
      <>
        <p>This Section governs shell eggs and dairy products placed with the Market. It is in addition to, not instead of, the rest of this Agreement. Nothing in this Section transfers ownership of the goods to the Market; Section 1 continues to apply.</p>
        <h3>6.1 Vendor is responsible for compliance</h3>
        <p>Shell eggs and dairy are regulated under their own Oklahoma statutes rather than the Local Food Freedom Act. <b>Vendor warrants that Vendor is legally entitled to sell every egg and dairy product Vendor places with the Market</b>, and that each one meets whatever Oklahoma law requires of Vendor as it stands from time to time. Vendor shall notify the Market in writing <b>within three (3) days</b> if that stops being true of any product, and shall remove that product from sale at once.</p>
        <h3>6.2 Shell eggs</h3>
        <p>(a) Vendor may place only shell eggs produced by Vendor&rsquo;s own flock.</p>
        <p>(b) Eggs must be clean and sound, and must be presented in <b>cartons</b> — never loose or in bulk containers. Cartons must be new or sanitized, must not be reused consumer cartons, and must not bear another producer&rsquo;s name, brand, or grade.</p>
        <p>(c) Each carton must carry everything the law requires of Vendor, which will ordinarily include Vendor&rsquo;s name and address, the pack date, safe-handling instructions, and — where the eggs are sold ungraded under an exemption — a clear statement that they are ungraded. Where eggs are sold as graded, Vendor shall provide the grade and size so the Market can display price, grade and size at the point of sale.</p>
        <p>(d) Eggs must be held at an ambient temperature of <b>45&deg;F or below</b> from the moment of delivery until sale, and must not be frozen. Vendor shall deliver eggs already at or below that temperature; the Market may refuse any delivery that arrives warm.</p>
        <h3>6.3 Dairy products</h3>
        <p>(a) <b>Pasteurized</b> milk and milk products — fluid milk, cream, butter, cheese, yogurt, and frozen dairy desserts — may be placed with the Market where Vendor is entitled to produce and sell them.</p>
        <p>(b) <b>Raw and unpasteurized milk, and products made from raw or unpasteurized milk</b>, may be placed only where the law then in force permits Vendor to sell that product away from the farm where it was produced, and the Market has given <b>written approval</b> for that specific product. Vendor shall give the consumer any notice the law requires. The Market may withhold or withdraw approval for any reason.</p>
        <p>(c) Dairy products must be held at <b>41&deg;F or below</b> from delivery until sale. Nothing may be offered after its sell-by or use-by date, and Vendor is responsible for removing and replacing stock before it dates.</p>
        <h3>6.4 Cold chain</h3>
        <p>The Market will provide refrigeration for eggs and dairy, will check and record temperatures at least twice on each selling day, and will keep those records available to Vendor and to any inspector. If refrigeration fails, the Market will remove the affected goods from sale and notify Vendor within twenty-four (24) hours. Loss arising from that failure is borne by Vendor under Section 1 except where caused by the Market&rsquo;s gross negligence or willful misconduct.</p>
        <h3>6.5 Inspection, complaints and recalls</h3>
        <p>(a) Vendor acknowledges that the Market premises may be inspected as a location selling eggs and dairy, and agrees to cooperate fully with any inspection and to supply records on request.</p>
        <p>(b) Vendor shall notify the Market <b>within twenty-four (24) hours</b> of any complaint of illness, any recall, or any regulatory action concerning Vendor&rsquo;s products, whether or not it relates to goods placed with the Market. The Market may remove any product from sale immediately, at its sole discretion, without that removal being a breach of this Agreement.</p>
        <p>(c) The Market may decline, limit, or discontinue any product category at any time on written notice.</p>
      </>
    ),
  };

  /* Section 5 gains two sentences in the eggs-and-dairy version: the
     homemade-food rule is left exactly as it is, and eggs and dairy are
     pointed at their own section so the two can't be read together. */
  const goods5 = eggsDairy
    ? {
        h: shared.s5.h,
        body: (
          <>
            {shared.s5.body}
            <p>Shell eggs and dairy products are <b>not</b> homemade foods under that Act. They are regulated under the Oklahoma Egg Law and the Oklahoma Milk and Milk Products Act respectively, and may be sold through the Market&rsquo;s register only on the terms set out in Section 6.</p>
          </>
        ),
      }
    : shared.s5;

  const tail = [shared.s6, shared.s7, shared.s8, shared.s9, shared.s10, shared.s11, shared.s12, shared.s13, shared.s14, shared.s15];

  return eggsDairy
    ? [title1, shared.s2, shared.s3, shared.s4, goods5, eggsDairySection, ...tail]
    : [shared.s1, shared.s2, shared.s3, shared.s4, shared.s5, ...tail];
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

  if (err && !p) {
    return (
      <main className="public-wrap public-narrow">
        <Note tone="error" title="This contract couldn't be opened">{err}</Note>
      </main>
    );
  }

  if (!p) {
    return (
      <main className="public-wrap public-narrow" aria-busy="true">
        <span className="sr-only">Loading the contract packet…</span>
        <Skeleton width={260} height={30} style={{ margin: "0 auto var(--sp-4)" }} />
        <Skeleton height={500} />
      </main>
    );
  }

  const c = p.contract;
  const rent = (c.monthlyRentCents / 100).toFixed(2);
  const fullySigned = !!c.vendorSignedAt && !!c.marketSignedAt;
  const mySideSigned = p.role === "VENDOR" ? !!c.vendorSignedAt : !!c.marketSignedAt;

  return (
    <main className="packet" style={{ maxWidth: 700, margin: "0 auto", padding: "24px 22px 70px", background: "#fff", minHeight: "100vh", fontSize: 13.5, lineHeight: 1.55, color: "#111", ...PAPER_TOKENS }}>
      {/* The document's own typography. Scoped to unclassed elements so it
          can't reach into the kit chrome (the Card heading, the Note body). */}
      <style>{`
        @media print { .no-print { display: none !important; } .page-break { break-before: page; } .packet { padding: 0 !important; } }
        .packet h2:not([class]) { font-size: 14px; margin: 14px 0 4px; }
        .packet h3:not([class]) { font-size: 12.5px; font-style: italic; margin: 10px 0 2px; }
        .packet p:not([class]) { margin: 6px 0; }
      `}</style>

      <div className="no-print row wrap g-3" style={{ marginBottom: 14 }}>
        <Button variant="secondary" icon="print" onClick={() => window.print()}>
          Print or save the full packet
        </Button>
        {fullySigned && <Badge tone="success" dot>Fully signed</Badge>}
        {!fullySigned && mySideSigned && <Badge tone="warn" dot>Waiting on the other signature</Badge>}
      </div>

      {/* ── THE AGREEMENT ─────────────────────────────── */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="" style={{ width: 84, height: 84, display: "block", margin: "0 auto 6px" }} />
      <h1 style={{ textAlign: "center", fontSize: 20, fontWeight: 900, marginBottom: 2 }}>BOOTH RENTAL AGREEMENT</h1>
      <p style={{ textAlign: "center", color: "#555", marginBottom: 14 }}>Community Harvest — Food and Craft Market · 510 N Main St, Noble, OK 73068</p>

      <p>
        This Booth Rental Agreement (the &ldquo;Agreement&rdquo;) is entered into as of <b>{fmtDay(c.startDate)}</b> between
        <b> Community Harvest</b>, 510 N Main St, Noble, OK 73068 (&ldquo;Market&rdquo;) and <b>{p.vendor.businessName}</b>
        {p.vendor.contactName ? <> ({p.vendor.contactName})</> : null} (&ldquo;Vendor&rdquo;).
      </p>

      {agreementSections(c.termsVersion === "EGGS_DAIRY", rent, c.boothLabel, p.vendor.commissionPercent).map((sec, i) => (
        <Fragment key={i}>
          <h2 dangerouslySetInnerHTML={{ __html: `${i + 1}. ${sec.h}` }} />
          {sec.body}
        </Fragment>
      ))}

      <div style={{ display: "flex", gap: 40, marginTop: 26, flexWrap: "wrap" }}>
        <SigBlock title="Market" name={c.marketSignedName} data={c.marketSignatureData} at={c.marketSignedAt} />
        <SigBlock title="Vendor" name={c.vendorSignedName} data={c.vendorSignatureData} at={c.vendorSignedAt} />
      </div>

      {/* ── SIGN HERE ─────────────────────────────── */}
      {!mySideSigned && (
        <div className="no-print" style={{ marginTop: 22 }}>
          <Card
            title={p.role === "VENDOR" ? "Sign as vendor" : "Sign for the market"}
            subtitle="Electronic signatures on this packet are binding."
          >
            <div className="stack g-4">
              <p className="t-sm t-secondary" style={{ margin: 0 }}>
                By signing you agree to the Agreement above, certify the attached application (Exhibit A) is true, and agree to the Market Rules (Exhibit B).
              </p>
              <SignaturePad label={signing ? "Signing…" : "Adopt & sign"} onSign={sign} />
              {err && <Note tone="error">{err}</Note>}
            </div>
          </Card>
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

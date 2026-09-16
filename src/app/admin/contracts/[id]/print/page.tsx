import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { fmtDay } from "@/lib/time";
import { LinkButton } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ContractPrintPage({ params }: { params: { id: string } }) {
  if (!isAdmin()) {
    return <main style={{ padding: 60, textAlign: "center", fontWeight: 600 }}>Not logged in — open the admin side first.</main>;
  }

  const contract = await db.contract.findUnique({
    where: { id: params.id },
    include: { vendor: true },
  });
  if (!contract) return <main style={{ padding: 40 }}>Contract not found.</main>;

  const marketName = process.env.MARKET_NAME || "Community Harvest";
  const rent = (contract.monthlyRentCents / 100).toFixed(2);

  return (
    <main style={{ maxWidth: 700, margin: "0 auto", padding: "30px 26px 60px", background: "#fff", color: "#111", minHeight: "100vh", fontSize: 13.5, lineHeight: 1.55 }}>
      <style>{`@media print { .no-print { display: none !important; } } h2 { font-size: 14px; margin: 16px 0 4px; } p { margin: 6px 0; }`}</style>

      <div className="no-print row wrap g-3" style={{ marginBottom: 14 }}>
        <LinkButton href="/admin" variant="secondary" size="sm" icon="arrowLeft">Back</LinkButton>
        <span style={{ fontSize: 12, color: "#777" }}>Print with Ctrl+P (or Share → Print on a phone)</span>
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="" style={{ width: 90, height: 90, display: "block", margin: "0 auto 8px" }} />
      <h1 style={{ textAlign: "center", fontSize: 20, fontWeight: 900, marginBottom: 2 }}>BOOTH RENTAL AGREEMENT</h1>
      <p style={{ textAlign: "center", color: "#555", marginBottom: 18 }}>{marketName} — Food and Craft Market · Noble, Oklahoma</p>

      <p>
        This Booth Rental Agreement (the &ldquo;Agreement&rdquo;) is entered into as of <b>{fmtDay(contract.startDate)}</b> between
        <b> {marketName}</b> (&ldquo;Market&rdquo;) and <b>{contract.vendor.businessName}</b>
        {contract.vendor.contactName ? <> ({contract.vendor.contactName})</> : null} (&ldquo;Vendor&rdquo;).
      </p>

      <h2>1. BOOTH &amp; RENT</h2>
      <p>
        Market rents Vendor booth space <b>{contract.boothLabel}</b> for
        <b> ${rent} per month</b>, due on the first day of each month. Late rent may result in suspension of selling privileges until paid.
      </p>

      <h2>2. MONTH-TO-MONTH TERM &amp; AUTOMATIC RENEWAL</h2>
      <p>
        This Agreement runs month to month beginning on the date above and <b>automatically renews on the first day of each month</b> unless terminated as described below.
      </p>

      <h2>3. TERMINATION — 30-DAY NOTICE</h2>
      <p>
        Either party may terminate this Agreement by giving the other party <b>written notice at least thirty (30) days</b> before the intended end date.
        Rent remains due through the end of the notice period. The Market may terminate immediately for violation of Market rules, illegal activity, or nonpayment.
      </p>

      <h2>4. GOODS</h2>
      <p>
        The Market is a homegrown and homemade marketplace. Vendor agrees to sell only items grown, raised, made, or crafted by Vendor.
        Resale of commercially manufactured goods is not permitted without written approval from the Market.
      </p>

      <h2>5. RESTOCKING</h2>
      <p>
        Restocking is <b>coordinated by Market staff</b>. Standard restocking windows are <b>7:00–8:00 AM</b> (before opening) and <b>6:00–8:00 PM</b> (after closing);
        restocking at any other time requires <b>prior staff approval</b>. To protect the shopping experience, staff may limit how many vendors restock at once
        and may ask a Vendor to wait or return at a later time. Delivery of accepted customer pre-orders to Market staff is permitted at any time and does not count as restocking.
        Vendor agrees to keep item quantities current in the vendor portal so the Market&rsquo;s live inventory stays accurate.
      </p>

      <h2>6. SALES, TAX &amp; PAYOUTS</h2>
      <p>
        Sales are rung through the Market&rsquo;s central register using Vendor&rsquo;s barcoded items. The Market collects and remits applicable sales tax.
        Vendor sale proceeds{contract.vendor.commissionPercent > 0 ? <>, less a <b>{contract.vendor.commissionPercent}%</b> Market commission,</> : null} are credited
        to Vendor&rsquo;s account and paid out monthly. Booth rent and any charges owed to the Market may be deducted from Vendor&rsquo;s balance.
      </p>

      <h2>7. LIABILITY</h2>
      <p>
        Vendor displays and sells at Vendor&rsquo;s own risk and is responsible for the safety and legality of Vendor&rsquo;s products, including any required
        licenses, permits, or cottage food compliance. Vendor agrees to hold the Market harmless from claims arising out of Vendor&rsquo;s products or booth.
      </p>

      <h2>8. ENTIRE AGREEMENT</h2>
      <p>
        This is the entire agreement between the parties and may only be changed in writing signed by both parties. Oklahoma law governs.
      </p>

      <div style={{ display: "flex", gap: 40, marginTop: 40 }}>
        <div style={{ flex: 1 }}>
          <div style={{ borderTop: "1.5px solid #111", paddingTop: 4 }}>Market — signature &amp; date</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ borderTop: "1.5px solid #111", paddingTop: 4 }}>Vendor — signature &amp; date</div>
        </div>
      </div>

      <p className="no-print" style={{ marginTop: 30, fontSize: 11, color: "#777" }}>
        Template generated by your market system — have an Oklahoma attorney review it once before first use.
      </p>
    </main>
  );
}

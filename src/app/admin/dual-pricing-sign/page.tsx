"use client";

// Printable dual-pricing disclosure — post at the entry and the register
export default function DualPricingSign() {
  return (
    <main style={{ maxWidth: 520, margin: "0 auto", padding: "20px 16px 50px", textAlign: "center" }}>
      <button className="btn no-print" style={{ marginBottom: 14 }} onClick={() => window.print()}>🖨 PRINT THIS SIGN</button>
      <div style={{ border: "2px solid #000", padding: "30px 22px", background: "#fff" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 220, maxWidth: "76%", height: "auto", margin: "0 auto 10px", display: "block" }} />
        <div style={{ fontWeight: 800, fontSize: 30, letterSpacing: "-0.02em", lineHeight: 1.15 }}>PAY CASH, PAY LESS 💵</div>
        <p style={{ fontSize: 16, fontWeight: 600, margin: "12px 0 0" }}>
          Our posted prices are card prices. A non-cash adjustment is included in all card purchases.
        </p>
        <p style={{ fontSize: 16, fontWeight: 800, margin: "10px 0 0" }}>
          Pay with cash and the adjustment comes off — automatically.
        </p>
        <div style={{ borderTop: "2px solid #000", margin: "16px 0 0", paddingTop: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 20, letterSpacing: "0.02em" }}>ALL SALES FINAL</div>
          <p style={{ fontSize: 13, fontWeight: 600, margin: "4px 0 0" }}>No refunds or exchanges.</p>
        </div>
        <p style={{ fontSize: 12, color: "#555", marginTop: 12 }}>
          The adjustment appears as its own line on every card receipt. Questions? Our register team is happy to explain.
        </p>
      </div>
    </main>
  );
}

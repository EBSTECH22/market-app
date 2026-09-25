"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";

// Printable dual-pricing disclosure — post at the entry and the register
export default function DualPricingSign() {
  /* The percentage comes from the owner's setting so the sign never disagrees
     with the register. */
  const [pct, setPct] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/admin/settings").then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d && typeof d.cardAdjustPercent === "number") setPct(d.cardAdjustPercent);
    }).catch(() => {});
  }, []);
  const save = pct ? `${pct}%` : "";
  return (
    <main style={{ maxWidth: 520, margin: "0 auto", padding: "20px 16px 50px", textAlign: "center" }}>
      <div className="no-print" style={{ marginBottom: 14 }}>
        <Button variant="secondary" icon="print" className="no-print" onClick={() => window.print()}>
          Print this sign
        </Button>
      </div>
      {/* The sign prints on white paper, so it is rendered on white whatever the
          app theme is — which means it has to pin its own ink colour too. */}
      <div style={{ border: "2px solid #000", padding: "30px 22px", background: "#fff", color: "var(--n-900)" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 220, maxWidth: "76%", height: "auto", margin: "0 auto 10px", display: "block" }} />
        <div style={{ fontWeight: 800, fontSize: 30, letterSpacing: "-0.02em", lineHeight: 1.15 }}>PAY CASH, PAY LESS 💵</div>
        <p style={{ fontSize: 16, fontWeight: 600, margin: "12px 0 0" }}>
          Our posted prices are card prices.
        </p>
        <p style={{ fontSize: 16, fontWeight: 800, margin: "10px 0 0" }}>
          Pay with cash and you pay the lower cash price{save ? ` (card prices are ${save} higher)` : ""} — taken off automatically at the register.
        </p>
        <div style={{ borderTop: "2px solid #000", margin: "16px 0 0", paddingTop: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 20, letterSpacing: "0.02em" }}>ALL SALES FINAL</div>
          <p style={{ fontSize: 13, fontWeight: 600, margin: "4px 0 0" }}>No refunds or exchanges.</p>
        </div>
        <p style={{ fontSize: 12, color: "#555", marginTop: 12 }}>
          Cash receipts show the discount as its own line. Questions? Our register team is happy to explain.
        </p>
      </div>
    </main>
  );
}

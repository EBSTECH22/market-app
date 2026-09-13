"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

// Printable sign: post at the door, shelves, and register
export default function ShopSign() {
  const [qr, setQr] = useState("");
  useEffect(() => {
    const url = `${window.location.origin}/shop`;
    QRCode.toDataURL(url, { width: 700, margin: 1, color: { dark: "#000000", light: "#ffffff" } }).then(setQr);
  }, []);
  if (!qr) return <main style={{ padding: 60, textAlign: "center" }}>Building your sign…</main>;
  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px 50px", textAlign: "center" }}>
      <button className="btn no-print" style={{ marginBottom: 14 }} onClick={() => window.print()}>🖨 PRINT THIS SIGN</button>
      <div style={{ border: "2px solid #000", padding: "26px 20px", background: "#fff" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 230, maxWidth: "80%", height: "auto", margin: "0 auto 8px", display: "block" }} />
        <div style={{ fontWeight: 800, fontSize: 34, letterSpacing: "-0.02em", lineHeight: 1.1 }}>SKIP THE LINE</div>
        <div style={{ fontWeight: 700, fontSize: 16, margin: "4px 0 14px" }}>SCAN · SHOP · PAY · GO</div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt="Scan to shop" style={{ width: 290, maxWidth: "88%", margin: "0 auto", display: "block" }} />
        <div style={{ fontSize: 15, fontWeight: 600, marginTop: 12 }}>Point your camera here — scan your items&rsquo; barcodes and pay by card, right on your phone.</div>
        <div style={{ fontSize: 12, color: "#555", marginTop: 8 }}>Cash or help? Our register up front is always happy to see you. 🌾</div>
        <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: "0.02em", marginTop: 10, borderTop: "2px solid #000", paddingTop: 8 }}>ALL SALES FINAL — NO REFUNDS OR EXCHANGES</div>
      </div>
    </main>
  );
}

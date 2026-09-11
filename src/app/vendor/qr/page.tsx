"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

// Printable table card: vendor QR → their public page
export default function VendorQrPage() {
  const [qr, setQr] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/vendor/me").then(async (r) => {
      if (!r.ok) { setErr("Log in to your vendor portal first, then come back."); return; }
      const me = await r.json();
      setName(me.vendor.businessName); setCode(me.vendor.code);
      const url = `${window.location.origin}/v/${me.vendor.code}`;
      setQr(await QRCode.toDataURL(url, { width: 600, margin: 1, color: { dark: "#000000", light: "#ffffff" } }));
    });
  }, []);

  if (err) return <main style={{ padding: 60, textAlign: "center" }}>{err}</main>;
  if (!qr) return <main style={{ padding: 60, textAlign: "center" }}>Building your card…</main>;

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "20px 14px 60px" }}>
      <div className="no-print" style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button className="btn" style={{ flex: 1 }} onClick={() => window.print()}>🖨 PRINT TABLE CARD</button>
        <a className="btn small ghost" href="/vendor">← BACK</a>
      </div>
      <p className="no-print" style={{ fontSize: 12, color: "var(--ash)", marginBottom: 14 }}>
        Print, fold or frame it, and keep it visible on your table — it&rsquo;s required at Community Harvest so customers can always reach you. Card is sized for a half sheet.
      </p>

      <div style={{ border: "2px solid #000", padding: "26px 20px", textAlign: "center", background: "#fff" }}>
        <img src="/logo-receipt.png" alt="Community Harvest" style={{ width: 120, margin: "0 auto 6px", display: "block" }} />
        <div className="display" style={{ fontSize: 22, borderBottom: "2px solid #000", paddingBottom: 8, marginBottom: 12 }}>
          {name.toUpperCase()}
        </div>
        <img src={qr} alt="Scan me" style={{ width: 240, height: 240, margin: "0 auto", display: "block" }} />
        <div className="display" style={{ fontSize: 16, marginTop: 10 }}>SCAN ME 📱</div>
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6, lineHeight: 1.6 }}>
          Pre-orders · Requests · Reviews<br />
          Questions or a problem with your purchase?<br />
          Message me directly — I&rsquo;ll make it right.
        </div>
        <div style={{ fontSize: 10.5, color: "#555", marginTop: 10 }}>
          market.dailybreadbaked.com/v/{code}
        </div>
      </div>
    </main>
  );
}

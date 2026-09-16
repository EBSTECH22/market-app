"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  Button, LinkButton, Card, Note, Skeleton, PageHeader,
} from "@/components/ui";

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
    }).catch(() => {
      setErr("Something went wrong building your card. Try again in a moment.");
    });
  }, []);

  /* The error state used to be a bare sentence with no way out of it. */
  if (err) {
    return (
      <main className="content content-narrow">
        <PageHeader title="Table QR card" />
        <Note
          tone="error"
          title="Couldn't build your card"
          action={<LinkButton href="/vendor" variant="secondary" icon="arrowLeft">Back to the portal</LinkButton>}
        >
          {err}
        </Note>
      </main>
    );
  }

  if (!qr) {
    return (
      <main className="content content-narrow" aria-busy="true">
        <PageHeader title="Table QR card" subtitle="Building your card…" />
        <div className="card card-pad stack g-4">
          <Skeleton width="60%" height={22} />
          <Skeleton width={240} height={240} style={{ margin: "0 auto" }} />
          <Skeleton width="45%" height={14} style={{ margin: "0 auto" }} />
          <Skeleton width="70%" height={13} style={{ margin: "0 auto" }} />
        </div>
      </main>
    );
  }

  return (
    <main className="content content-narrow">
      <div className="no-print">
        <PageHeader
          title="Table QR card"
          subtitle="Keep it visible on your table — it's required at Community Harvest so customers can always reach you."
          actions={
            <>
              <LinkButton href="/vendor" variant="ghost" icon="arrowLeft">Back to the portal</LinkButton>
              <Button variant="primary" icon="print" onClick={() => window.print()}>Print table card</Button>
            </>
          }
        />
        <div className="mb-4">
          <Note tone="info" title="Sized for a half sheet">
            Print it, fold or frame it, and set it where shoppers can see it from the front of your booth.
          </Note>
        </div>
      </div>

      <div style={{ border: "2px solid #000", padding: "26px 20px", textAlign: "center", background: "#fff" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-receipt.png" alt="Community Harvest" style={{ width: 120, margin: "0 auto 6px", display: "block" }} />
        <div className="display" style={{ fontSize: 22, borderBottom: "2px solid #000", paddingBottom: 8, marginBottom: 12, color: "#000" }}>
          {name}
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt={`QR code to the ${name} page`} style={{ width: 240, height: 240, margin: "0 auto", display: "block" }} />
        <div className="display" style={{ fontSize: 16, marginTop: 10, color: "#000" }}>Scan me</div>
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6, lineHeight: 1.6, color: "#000" }}>
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

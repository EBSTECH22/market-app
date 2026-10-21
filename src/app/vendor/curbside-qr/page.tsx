"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button, LinkButton, Note, Skeleton, PageHeader } from "@/components/ui";

/**
 * The printable sign for curbside ordering.
 *
 * SEPARATE FROM THE TABLE CARD, on purpose. That one sends somebody to the
 * vendor's page — pre-orders, reviews, a way to complain — and belongs on the
 * table in front of them. This one sends somebody to a menu they order from
 * while sitting in a car, and belongs on the door and on a stake in the
 * parking lot. One code doing both jobs would mean a customer in a car park
 * landing on a reviews page, which is exactly when they are least inclined to
 * go hunting for the right link.
 */
export default function CurbsideQrPage() {
  const [qr, setQr] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/vendor/me")
      .then(async (r) => {
        if (!r.ok) { setErr("Log in to your vendor portal first, then come back."); return; }
        const me = await r.json();
        setName(me.vendor.businessName);
        setCode(me.vendor.code);
        setEnabled(!!me.vendor.curbsideEnabled);
        const url = `${window.location.origin}/curb/${me.vendor.code}`;
        setQr(await QRCode.toDataURL(url, { width: 600, margin: 1, color: { dark: "#000000", light: "#ffffff" } }));
      })
      .catch(() => setErr("Something went wrong building your sign. Try again in a moment."));
  }, []);

  if (err) {
    return (
      <main className="content content-narrow">
        <PageHeader title="Curbside sign" />
        <Note
          tone="error"
          title="Couldn't build your sign"
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
        <PageHeader title="Curbside sign" subtitle="Building your sign…" />
        <div className="card card-pad stack g-4">
          <Skeleton width="60%" height={22} />
          <Skeleton width={240} height={240} style={{ margin: "0 auto" }} />
          <Skeleton width="45%" height={14} style={{ margin: "0 auto" }} />
        </div>
      </main>
    );
  }

  return (
    <main className="content content-narrow">
      <div className="no-print">
        <PageHeader
          title="Curbside sign"
          subtitle="The code customers scan to order from the car park. Different from your table card."
          actions={
            <>
              <LinkButton href="/vendor#curbside" variant="ghost" icon="arrowLeft">Back to the portal</LinkButton>
              <Button variant="primary" icon="print" onClick={() => window.print()}>Print the sign</Button>
            </>
          }
        />
        <div className="mb-4 stack g-3">
          {/* Printing a sign for a feature that is switched off is how a
              customer ends up scanning a code that tells them no. */}
          {enabled === false ? (
            <Note tone="warn" title="Curbside isn't switched on yet">
              The code will work the moment the market office turns curbside ordering on for you. Ask
              them before you put the sign out.
            </Note>
          ) : null}
          <Note tone="info" title="Where to put it">
            On the door, and on a stake where cars pull up. It is not your table card — that one goes
            on the table and sends people to your page.
          </Note>
        </div>
      </div>

      <div style={{ border: "2px solid #000", padding: "26px 20px", textAlign: "center", background: "#fff" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-receipt.png" alt="Community Harvest" style={{ width: 120, margin: "0 auto 6px", display: "block" }} />
        <div className="display" style={{ fontSize: 22, borderBottom: "2px solid #000", paddingBottom: 8, marginBottom: 10, color: "#000" }}>
          {name}
        </div>
        <div className="display" style={{ fontSize: 26, lineHeight: 1.15, marginBottom: 12, color: "#000" }}>
          ORDER FROM<br />YOUR CAR
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt={`QR code to order from ${name}`} style={{ width: 240, height: 240, margin: "0 auto", display: "block" }} />
        <div className="display" style={{ fontSize: 16, marginTop: 10, color: "#000" }}>Scan me</div>
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6, lineHeight: 1.6, color: "#000" }}>
          1. Scan and order<br />
          2. Park out front<br />
          3. Press <b>I&rsquo;m here</b> — we&rsquo;ll bring it out
        </div>
        <div style={{ fontSize: 10.5, color: "#555", marginTop: 10 }}>
          market.dailybreadbaked.com/curb/{code}
        </div>
      </div>
    </main>
  );
}

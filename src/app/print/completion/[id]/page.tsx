import { notFound, redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import CertAdminPanel from "./cert-admin-panel";
import ContractorSignPanel from "./contractor-sign-panel";

// Certificate of Completion — furnished to the insurance carrier as
// documentation that the ITEMISED work listed on it has been completed, without
// creating any new warranty, representation, or waiver.
//
// It certifies the listed items and nothing else. Certifying "the Insurance
// Scope" as a whole would assert that everything approved on the claim was
// done, which is frequently not the case on a partial or supplemented job.
//
// It deliberately says nothing about recoverable depreciation or the release of
// claim funds. A contractor directing a carrier on what to pay an insured is
// adjusting, which is a licensed activity in Oklahoma. This document states
// what was done; what that entitles anyone to is the carrier's determination.

export default async function CompletionCertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) redirect("/auth/login");

  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      contracts: {
        where: { status: "SIGNED" },
        orderBy: { signedAt: "desc" },
        take: 1,
      },
    },
  });
  if (!job) notFound();

  const contract = job.contracts[0] || null;
  const address = [job.propertyStreet, job.propertyCity, job.propertyState, job.propertyZip].filter(Boolean).join(", ");
  const certDate = new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric" });
  const cd = ((job as any).completionCertData ?? {}) as any;
  const shingle = contract
    ? [contract.shingleBrand, contract.shingleCustomType].filter(Boolean).join(" ") || String(contract.shingleType ?? "")
    : "";

  return (
    <>
      <style>{`
        @media print { .no-print { display: none !important; } body { padding: 0; } }
        body { font-family: Arial, sans-serif; font-size: 13px; color: #111; padding: 32px; max-width: 800px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #dc2626; }
        .company-info { font-size: 11px; color: #666; text-align: right; line-height: 1.5; }
        .title { font-size: 22px; font-weight: 800; letter-spacing: 0.06em; text-align: center; margin: 8px 0 2px; }
        .subtitle { text-align: center; font-size: 11px; color: #666; margin-bottom: 22px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; margin-bottom: 18px; }
        .field label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; display: block; margin-bottom: 2px; }
        .field p { font-weight: 600; margin: 0; }
        .cert-box { border: 2px solid #111; border-radius: 6px; padding: 14px 16px; margin: 18px 0; line-height: 1.55; }
        .limits { font-size: 11.5px; line-height: 1.55; margin: 14px 0; }
        .limits li { margin-bottom: 7px; }
        .line { border-bottom: 1px solid #444; display: inline-block; min-width: 220px; height: 14px; }
        .sig-grid { display: grid; grid-template-columns: 1fr; gap: 24px; margin-top: 26px; max-width: 420px; }
        .sig-box { border: 1px solid #d1d5db; border-radius: 6px; padding: 14px; background: #fafafa; }
        .sig-line { border-bottom: 1px solid #111; height: 40px; margin-bottom: 4px; }
        .sig-label { font-size: 9px; color: #888; text-transform: uppercase; }
        .footer-bar { margin-top: 34px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 10px; color: #999; text-align: center; line-height: 1.5; }
      `}</style>

      <div className="no-print" style={{ textAlign: "right", marginBottom: 12 }}>
        <button id="print-btn" style={{ padding: "8px 18px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer" }}>Print / Save PDF</button>
      </div>

      <CertAdminPanel
        jobId={job.id}
        completedDate={(job as any).completionCertCompletedDate ? new Date((job as any).completionCertCompletedDate).toISOString().slice(0, 10) : null}
        exceptions={(job as any).completionCertExceptions ?? null}
        token={(job as any).completionCertToken ?? null}
        signed={!!(job as any).completionCertSignedAt}
        certData={(job as any).completionCertData ?? null}
        defaults={{
          carrier: job.insuranceCompany || "",
          claimNumber: job.claimNumber || "",
          policyNumber: job.policyNumber || "",
          roofingSystem: shingle ? `${shingle}${contract?.shingleColor ? ` — ${contract.shingleColor}` : ""}` : "",
          ownerName: job.customerName || "",
        }}
      />

      <ContractorSignPanel jobId={job.id} adminSigned={!!(job as any).completionCertAdminSignedAt} />

      <div className="header">
        <div>
          <p style={{ fontWeight: 800, fontSize: 18, margin: 0 }}>LIGHTFOOT ROOFS</p>
          <p style={{ fontSize: 11, color: "#666", margin: "2px 0 0" }}>Residential &amp; Commercial Roofing</p>
        </div>
        <div className="company-info">
          Lightfoot Roofing Inc, DBA Lightfoot Roofs<br />
          2236 NW 164th St, Suite 12, Edmond, OK 73013<br />
          405-834-4799<br />
          Oklahoma CIB Registration #OK 80006087
        </div>
      </div>

      <p className="title">CERTIFICATE OF COMPLETION</p>
      <p className="subtitle">Issued for insurance claim documentation — certifies completion of the itemized work listed below</p>

      <div className="grid">
        <div className="field"><label>Insured / Property Owner</label><p>{cd.ownerName || job.customerName}</p></div>
        <div className="field"><label>Property Address</label><p>{address}</p></div>
        <div className="field"><label>Insurance Carrier</label><p>{cd.carrier || job.insuranceCompany || "—"}</p></div>
        <div className="field"><label>Claim Number</label><p>{cd.claimNumber || job.claimNumber || "—"}</p></div>
        <div className="field"><label>Policy Number</label><p>{cd.policyNumber || job.policyNumber || "—"}</p></div>
        <div className="field"><label>Contract No. / Date Signed</label><p>{contract ? `${contract.contractNumber}${contract.signedAt ? " · " + new Date(contract.signedAt).toLocaleDateString("en-US", { timeZone: "America/Chicago" }) : ""}` : "—"}</p></div>
        {(cd.roofingSystem || shingle) && <div className="field"><label>Roofing System Installed</label><p>{cd.roofingSystem || `${shingle}${contract?.shingleColor ? ` — ${contract.shingleColor}` : ""}`}</p></div>}
        <div className="field"><label>Certificate Date</label><p>{certDate}</p></div>
      </div>

      <div className="cert-box">
        {/* Certifies the ITEMISED work, not the scope as a whole.
            The previous wording certified that "the Insurance Scope has been
            substantially completed" and then listed items underneath — a
            broader claim than the list supports, and one that reads as though
            everything approved on the claim was done whether or not it was. */}
        <p style={{ margin: 0 }}>
          Lightfoot Roofing Inc, DBA Lightfoot Roofs (&quot;Contractor&quot;) hereby certifies that the work itemized below,
          performed under the above-referenced agreement in connection with the above-referenced
          insurance claim (the &quot;Insurance Scope&quot;), has been <strong>completed</strong> at the
          property identified above, in a good and workmanlike manner and in accordance with the
          agreement between Contractor and the Owner, the manufacturer&apos;s installation
          specifications, and the building codes applicable at the time of installation.
        </p>
        <p style={{ margin: "10px 0 0" }}>
          Date work was completed: {(job as any).completionCertCompletedDate
            ? <strong>{new Date((job as any).completionCertCompletedDate).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" })}</strong>
            : <span className="line"></span>}
        </p>
        {Array.isArray(cd.completedItems) && cd.completedItems.length > 0 ? (
          <div style={{ margin: "10px 0 0" }}>
            <p style={{ margin: 0, fontWeight: 700 }}>Work completed:</p>
            <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
              {cd.completedItems.map((it: string, i: number) => <li key={i}>{it}</li>)}
            </ul>
          </div>
        ) : (
          // With nothing itemised there is nothing being certified, and a
          // certificate that simply omits the list reads as though everything
          // was done. Say so plainly instead.
          <div style={{ margin: "10px 0 0" }}>
            <p style={{ margin: 0, fontWeight: 700 }}>Work completed:</p>
            <p style={{ margin: "4px 0 0", fontStyle: "italic" }}>
              No items have been itemized. This certificate does not certify any work until the
              completed items are listed.
            </p>
          </div>
        )}
        {/* Neither the excluded-scope list nor the exceptions line is printed.
            Stored values are left in place so a previously issued certificate
            can still be reproduced from the record if ever needed. */}
        <p style={{ margin: "12px 0 0", fontWeight: 700 }}>
          This certificate covers only the items listed above. It makes no representation as to
          any other portion of the Insurance Scope, whether approved, pending, or not yet performed.
        </p>
      </div>

      <div className="limits">
        <p style={{ fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Scope of this Certificate</p>
        <ol style={{ paddingLeft: 18, margin: 0 }}>
          <li>This certificate documents completion of the itemized work listed above only. It makes no statement regarding any other item, system, or condition, whether inside or outside the Insurance Scope.</li>
          <li>This certificate does not create, expand, or modify any warranty, guarantee, representation, or obligation. The only warranties applicable to the work are those stated in the agreement between Contractor and Owner — the manufacturer&apos;s warranty and Contractor&apos;s limited workmanship warranty — according to their own terms.</li>
          <li>This certificate is issued solely to document completion for insurance claim purposes. It is not a lien waiver and is not a release or waiver of Contractor&apos;s right to payment or of any lien right available under Oklahoma law.</li>
          <li>This certificate does not amend or modify the agreement between Contractor and Owner, which remains the entire agreement between the parties.</li>
        </ol>
      </div>

      <div className="sig-grid">
        <div className="sig-box">
          <p style={{ fontSize: 11, fontWeight: 700, marginBottom: 10 }}>CONTRACTOR</p>
          {(job as any).completionCertAdminSignedAt ? (
            <>
              {(job as any).completionCertAdminSignatureImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={(job as any).completionCertAdminSignatureImage} alt="Contractor signature" style={{ maxWidth: 260, maxHeight: 70, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 4 }} />
              )}
              <p className="sig-label" style={{ marginTop: 4 }}>Signature</p>
              <p style={{ fontSize: 12, fontWeight: 600, margin: "8px 0 0" }}>{(job as any).completionCertAdminSignedBy || "Lightfoot Roofing Inc, DBA Lightfoot Roofs"} — Lightfoot Roofing Inc, DBA Lightfoot Roofs</p>
              <p style={{ fontSize: 10, color: "#666", margin: "4px 0 0" }}>
                Electronically signed on {new Date((job as any).completionCertAdminSignedAt).toLocaleString("en-US", { timeZone: "America/Chicago" })} (Central Time)
              </p>
            </>
          ) : (
            <>
              <div className="sig-line"></div>
              <p className="sig-label">Signature</p>
              <p style={{ fontSize: 12, fontWeight: 600, margin: "8px 0 0" }}>Clint Lightfoot, Owner — Lightfoot Roofing Inc, DBA Lightfoot Roofs</p>
              <p style={{ fontSize: 11, color: "#666", margin: "8px 0 0" }}>Date: ______________</p>
            </>
          )}
        </div>
      </div>

      <div className="footer-bar">
        Lightfoot Roofs | 405-834-4799 | 2236 NW 164th St, Suite 12, Edmond, OK 73013 | License #OK 80006087
      </div>

      <script dangerouslySetInnerHTML={{ __html: `
        document.addEventListener("DOMContentLoaded", function() {
          var btn = document.getElementById("print-btn");
          if (btn) btn.onclick = function() { window.print(); };
        });
      `}} />
    </>
  );
}

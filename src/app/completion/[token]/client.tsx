"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import SignaturePad from "@/components/signature-pad";
import { signCompletionCert } from "@/actions/completion-cert";

const ESIGN_CONSENT = `By checking this box, you consent to sign this Certificate of Completion electronically and to receive it as an electronic record. You have the right to receive a paper copy of this certificate free of charge — request one at accounting@lightfootroofs.com or 405-834-4799. You may withdraw this consent at any time before signing by closing this page and requesting a paper certificate instead; there is no fee or penalty for doing so. This consent applies only to this Certificate of Completion. To access and keep this document you need a device with a current web browser and the ability to view and save PDF files. By checking the box you confirm you can access this document electronically.`;

export default function CompletionSignClient({ token, job }: { token: string; job: any }) {
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [signing, setSigning] = useState(false);
  const [done, setDone] = useState(false);
  const router = useRouter();

  const cd = (job.completionCertData ?? {}) as any;
  const address = [job.propertyStreet, job.propertyCity, job.propertyState, job.propertyZip].filter(Boolean).join(", ");
  const contract = job.contracts?.[0] || null;
  const shingle = contract ? ([contract.shingleBrand, contract.shingleCustomType].filter(Boolean).join(" ") || String(contract.shingleType ?? "")) : "";
  const alreadySigned = !!job.completionCertSignedAt || done;

  async function handleSign(signatureImage: string) {
    setError("");
    if (!consent) { setError("Please check the electronic-signature consent box first"); return; }
    if (!name.trim()) { setError("Please type your full name"); return; }
    setSigning(true);
    try {
      await signCompletionCert(token, name.trim(), signatureImage, consent);
      setDone(true);
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Signing failed — please try again");
    } finally {
      setSigning(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-4">

        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-start justify-between mb-4 pb-4 border-b-2 border-red-600">
            <div>
              <p className="text-lg font-extrabold text-gray-900">LIGHTFOOT ROOFS</p>
              <p className="text-xs text-gray-500">Residential &amp; Commercial Roofing</p>
            </div>
            <div className="text-right text-[11px] text-gray-500 leading-relaxed">
              Lightfoot Roofing Inc, DBA Lightfoot Roofs<br />2236 NW 164th St, Suite 12, Edmond, OK 73013<br />405-834-4799<br />CIB Registration #OK 80006087
            </div>
          </div>

          <h1 className="text-xl font-extrabold tracking-wide text-center text-gray-900">CERTIFICATE OF COMPLETION</h1>
          <p className="text-[11px] text-gray-500 text-center mb-5">Issued for insurance claim documentation — supports release of recoverable depreciation</p>

          <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-5 text-sm">
            <div><p className="text-[10px] uppercase tracking-wide text-gray-400">Insured / Owner</p><p className="font-semibold">{cd.ownerName || job.customerName}</p></div>
            <div><p className="text-[10px] uppercase tracking-wide text-gray-400">Property</p><p className="font-semibold">{address}</p></div>
            <div><p className="text-[10px] uppercase tracking-wide text-gray-400">Carrier</p><p className="font-semibold">{cd.carrier || job.insuranceCompany || "—"}</p></div>
            <div><p className="text-[10px] uppercase tracking-wide text-gray-400">Claim #</p><p className="font-semibold">{cd.claimNumber || job.claimNumber || "—"}</p></div>
            <div><p className="text-[10px] uppercase tracking-wide text-gray-400">Policy #</p><p className="font-semibold">{cd.policyNumber || job.policyNumber || "—"}</p></div>
            {(cd.roofingSystem || shingle) && <div><p className="text-[10px] uppercase tracking-wide text-gray-400">Roofing System</p><p className="font-semibold">{cd.roofingSystem || `${shingle}${contract?.shingleColor ? ` — ${contract.shingleColor}` : ""}`}</p></div>}
          </div>

          <div className="rounded-xl border-2 border-gray-900 p-4 text-sm leading-relaxed">
            <p>
              Lightfoot Roofing Inc, DBA Lightfoot Roofs certifies that the roofing work contracted under the agreement with the
              Owner and approved under the above-referenced insurance claim (the &quot;Insurance Scope&quot;)
              has been <strong>substantially completed</strong> at the property identified above, in a good and
              workmanlike manner and in accordance with the agreement, the manufacturer&apos;s installation
              specifications, and the building codes applicable at the time of installation.
            </p>
            <p className="mt-2">
              Date work was completed: <strong>{job.completionCertCompletedDate ? new Date(job.completionCertCompletedDate).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }) : "____________"}</strong>
            </p>
            {Array.isArray(cd.completedItems) && cd.completedItems.length > 0 && (
              <div className="mt-2">
                <p className="font-bold">Work completed (Insurance Scope):</p>
                <ul className="list-disc pl-5">{cd.completedItems.map((it: string, i: number) => <li key={i}>{it}</li>)}</ul>
              </div>
            )}
            {Array.isArray(cd.excludedItems) && cd.excludedItems.length > 0 ? (
              <div className="mt-2">
                <p className="font-bold">Excluded from the Insurance Scope — not certified by this document:</p>
                <ul className="list-disc pl-5">{cd.excludedItems.map((it: string, i: number) => <li key={i}>{it}</li>)}</ul>
              </div>
            ) : (
              <p className="mt-2">
                Exceptions or items remaining, if any: <strong>{job.completionCertExceptions || "None"}</strong>
              </p>
            )}
          </div>

          <div className="text-xs text-gray-600 leading-relaxed mt-4 space-y-1.5">
            <p className="font-bold uppercase tracking-wide text-[10px] text-gray-500">Scope of this Certificate</p>
            <p>1. This certificate documents completion of the Insurance Scope only and makes no statement regarding anything outside it.</p>
            <p>2. It does not create, expand, or modify any warranty, guarantee, representation, or obligation. The only warranties applicable to the work are those stated in the agreement — the manufacturer&apos;s warranty and Contractor&apos;s limited workmanship warranty — according to their own terms.</p>
            <p>3. It is issued solely to document completion for insurance claim purposes. It is not a lien waiver and does not release Contractor&apos;s right to payment or any lien right available under Oklahoma law.</p>
            <p>4. It does not amend or modify the agreement between Contractor and Owner.</p>
          </div>
        </div>

        {alreadySigned ? (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-6 text-center">
            <p className="text-base font-bold text-green-800">✓ Certificate signed</p>
            <p className="text-sm text-green-700 mt-1">
              Signed by {job.completionCertSignedBy || name}
              {job.completionCertSignedAt ? ` on ${new Date(job.completionCertSignedAt).toLocaleString("en-US", { timeZone: "America/Chicago" })} (CT)` : ""}.
              Lightfoot Roofs will submit this certificate to your insurance carrier.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
            <h2 className="text-sm font-bold text-gray-900">Owner Acceptance &amp; Signature</h2>
            <p className="text-xs text-gray-600 leading-relaxed">
              By signing below, I acknowledge that the work described above is complete and I accept the
              work, subject only to any exceptions listed above.
            </p>

            <label className="flex items-start gap-3 rounded-xl border border-gray-300 p-3 cursor-pointer">
              <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-1" />
              <span className="text-[11px] text-gray-600 leading-relaxed">
                <span className="font-semibold text-gray-800">Consent to Use Electronic Records and Signatures. </span>
                {ESIGN_CONSENT}
              </span>
            </label>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Type your full name <span className="text-red-500">*</span></label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Full legal name"
                className="block w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
            </div>

            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs font-semibold text-gray-700 mb-2">Draw your signature below, then submit:</p>
              <SignaturePad disabled={signing || !consent || !name.trim()} onSign={handleSign} />
              {(!consent || !name.trim()) && <p className="text-[11px] text-gray-400 mt-2">Check the consent box and type your name to enable signing.</p>}
            </div>

            {error && <p className="text-xs text-red-600 font-medium">{error}</p>}
          </div>
        )}

        <p className="text-center text-[11px] text-gray-400 pb-4">
          Lightfoot Roofs | 405-834-4799 | 2236 NW 164th St, Suite 12, Edmond, OK 73013 | License #OK 80006087
        </p>
      </div>
    </div>
  );
}

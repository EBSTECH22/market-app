"use client";
import { LOGO_B64 } from "@/lib/logo-b64";
import { FTC_SIGNATURE_STATEMENT, ftcNoticeFormText } from "@/lib/contract-terms-v2";

import { useState } from "react";
import { signEmergencyTarpAgreement } from "@/actions/inspections";

type Agreement = {
  id: string;
  customerName: string;
  customerEmail: string;
  propertyStreet: string;
  propertyCity: string;
  propertyState: string;
  signedAt: string | null;
  signedByName: string | null;
  status: string;
};

export default function TarpSigningClient({ agreement, token }: { agreement: Agreement; token: string }) {
  const [signedName, setSignedName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(agreement.status === "SIGNED");
  const [error, setError] = useState("");

  async function handleSign() {
    if (!signedName.trim() || !agreed) return;
    setSigning(true);
    setError("");
    try {
      await signEmergencyTarpAgreement(token, signedName.trim());
      setSigned(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSigning(false);
    }
  }

  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-lg mx-auto space-y-6">

        {/* Logo */}
        <div className="rounded-2xl overflow-hidden shadow-sm">
          <img src={`data:image/png;base64,${LOGO_B64}`} alt="Lightfoot Roofs" className="w-full block" style={{ height: "110px", objectFit: "cover" }} />
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-2">
          <h1 className="text-xl font-bold text-gray-900">Emergency Tarp Agreement</h1>
          <p className="text-xs text-gray-400">Lightfoot Roofing Inc, DBA Lightfoot Roofs · CIB Registration #OK 80006087</p>
          <p className="text-sm text-gray-500">{agreement.propertyStreet}, {agreement.propertyCity}, {agreement.propertyState}</p>
          <p className="text-sm text-gray-500">Prepared for: {agreement.customerName} · {today}</p>
        </div>

        {/* Agreement body */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5 text-sm text-gray-700">

          <div>
            <h3 className="text-sm font-bold text-gray-900 mb-2 uppercase tracking-wide">Condition of Roof Upon Arrival</h3>
            <p>I/We, <strong>{agreement.customerName}</strong>, acknowledge and confirm that upon arrival by Lightfoot Roofs at the property located at <strong>{agreement.propertyStreet}, {agreement.propertyCity}, {agreement.propertyState}</strong>, the roof was actively leaking and in a condition requiring immediate temporary protection to prevent further water intrusion and damage to the interior of the property.</p>
          </div>

          <div>
            <h3 className="text-sm font-bold text-gray-900 mb-2 uppercase tracking-wide">Emergency Tarp Authorization</h3>
            <div className="space-y-2">
              <p><span className="font-semibold text-gray-900">Authorization:</span> I/We hereby authorize Lightfoot Roofs to install an emergency tarp on the above-referenced property for the purpose of preventing further water damage pending permanent repairs.</p>
              <p><span className="font-semibold text-gray-900">Acknowledgment of Need:</span> I/We understand that the emergency tarp is a temporary measure only and does not constitute a permanent repair. Lightfoot Roofs makes no warranty regarding the tarp's ability to prevent all water intrusion during extreme weather events.</p>
              <p><span className="font-semibold text-gray-900">Service Fee:</span> I/We understand and agree that if the cost of this emergency tarp service is not covered by or tied to an approved insurance claim, the fee for this service is <strong>$500.00</strong>, due upon completion of the tarp installation. If an insurance claim is filed and approved for the related damage, the tarp cost will be incorporated into the insurance scope of work.</p>
              <p><span className="font-semibold text-gray-900">Liability:</span> Lightfoot Roofs shall not be held liable for any pre-existing damage to the property or damage caused by continued weather events following tarp installation. The homeowner accepts responsibility for ensuring timely permanent repairs are scheduled.</p>
              <p><span className="font-semibold text-gray-900">Survival:</span> This agreement and all acknowledgments herein shall remain in effect and binding regardless of the outcome of any related insurance claim or subsequent contractor selection.</p>
            </div>
          </div>

        </div>

        {/* Signature section */}
        {signed ? (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-6 text-center space-y-2">
            <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto">
              <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-green-900">Agreement Signed</h3>
            <p className="text-sm text-green-700">
              Signed by {agreement.signedByName || signedName}
              {agreement.signedAt ? ` on ${new Date(agreement.signedAt).toLocaleDateString()}` : ` on ${today}`}
            </p>
            <p className="text-sm text-green-600 mt-2">Thank you. Lightfoot Roofs has been notified and will be in touch shortly.</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
            <h3 className="text-base font-bold text-gray-900">Sign This Agreement</h3>
            <p className="text-sm text-gray-500">By typing your name and submitting, you confirm you have read and agree to the terms above. This electronic signature is legally binding.</p>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Full Name <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={signedName}
                onChange={e => setSignedName(e.target.value)}
                placeholder="Type your full legal name"
                className="block w-full rounded-xl border border-gray-300 px-4 py-3 text-sm focus:border-red-500 focus:outline-none font-medium"
              />
            </div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} className="mt-0.5 rounded text-red-600" />
              <span className="text-xs text-gray-600">
                I have read and understand this Emergency Tarp Agreement. I confirm that the roof was leaking upon Lightfoot Roofs&apos; arrival, I authorize the emergency tarp installation, and I understand the $500.00 fee applies if not covered by an approved insurance claim. I requested that Lightfoot Roofs perform this emergency service.
              </span>
            </label>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button
              onClick={handleSign}
              disabled={!signedName.trim() || !agreed || signing}
              className="w-full py-3 text-sm font-bold text-white bg-red-600 rounded-xl hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {signing ? "Submitting..." : "Sign Agreement"}
            </button>
          </div>
        )}

        <p className="text-center text-xs text-gray-400 pb-4">
          Lightfoot Roofs · 2236 NW 164th St, Ste 12, Edmond OK 73013 · (405) 834-4799
        </p>
        <div className="bg-white rounded-2xl border-2 border-gray-900 p-6 space-y-3 mt-4">
          <p className="text-xs font-bold text-gray-900 leading-snug">{FTC_SIGNATURE_STATEMENT}</p>
          <h3 className="text-sm font-bold text-gray-900 text-center tracking-wide">NOTICE OF CANCELLATION</h3>
          {ftcNoticeFormText("the third business day after the date of this transaction").split("\n\n").map((para, i) => (
            <p key={i} className="text-xs font-bold text-gray-900 leading-relaxed">{para}</p>
          ))}
          <p className="text-xs font-bold text-gray-900">I HEREBY CANCEL THIS TRANSACTION.&nbsp;&nbsp;&nbsp;Date: ____________&nbsp;&nbsp;&nbsp;Buyer&apos;s signature: ______________________</p>
        </div>
      </div>
    </div>
  );
}

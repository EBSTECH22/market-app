"use client";

import { useState } from "react";
import { ESTIMATE_DEDUCTIBLE_NOTICE, ESTIMATE_DEDUCTIBLE_NOTICE_TITLE, ESTIMATE_TERMS, ESTIMATE_TERMS_TITLE } from "@/lib/contract-terms-v2";
import { signEstimate } from "@/actions/crm";

type LineItem = {
  id: string;
  label: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  amount: number;
  sortOrder: number;
  isWarranty: boolean;
};

type Estimate = {
  id: string;
  estimateNumber: string;
  status: string;
  includeGafWarranty: boolean;
  includeLaborWarranty: boolean;
  includeFinancing: boolean;
  signedAt: string | null;
  signedByName: string | null;
  expiresAt: string | null;
  lineItems: LineItem[];
  job: {
    customerName: string | null;
    propertyStreet: string | null;
    propertyCity: string | null;
    propertyState: string | null;
    propertyZip: string | null;
  };
};

function fmt$(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const LOGO_B64 = "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lZVV77sciej+xEuERPcg79kj0zSxdu1aXLlyBZqmwTRNqKqKGzduYNy4cUH71VfYzJ8/H0899RQGDBgAt9uNqVOnIj09HUeOHEFZWRl+8IMfIDk5GW63u96XKIfazq1twi22bqf97RRyc+bMQd++fdG7d2+43W7MmDEDzz33HAoKCnDlyhUkJCTgscces465qqqYPXs2SkpKgo45c+ZM/Otf/4KmaWjdujUyMzOxaNEiHDt2DA888ABSUlIQHR0Nt9uNqKgonDp1KmARFmw/6/6TiO59EX8YF8Mwvrlx44aEcmufjh07+rwUuHv37vVuY9u2bSG3ISKSmZkZsP+FCxesNhMmTAjYZunSpVabQ4cOhdzvIUOGWO0rKirCOlZVVVVWn759+zb4WH/88cchj8HVq1flhRdeCGu8cePGWS+grs+BAwckNjY2rDF/9rOfWf2qqqoi/veTYZjQ4RksonvQxYsX0bp1a+ssltQ5e6GqKqqqqvz6lJSUoLS0FFFRUTBNEx6Pp95tjBkzBhMnTsSsWbPQs2dPn8XsLpcL586dw969e/H2228H7H/p0iU4nU4oihL0MmZVVRUqKyshIigvLw+53y6XCxUVFRARlJWVhWwP3DxW0dHRABBynwMZOnQoXnzxRbz44otITk5GixYtrN8uXLiAXbt2YdWqVTh9+nRY423ZsgVffPEFfvOb32D06NH40Y9+ZK2jq62txYkTJ5CZmYk1a9aEPcfa2lrruAS6K5KI7j0KblZaRNSEdezYETExMWjbti2+++47VFRU+L2AuCmIj4/Ho48+iqioKJSXl6OgoOB7j5mcnIwOHTrA5XKhtLQ05AuriahxYIFFREREZDPeRUhERERkMxZYRERERDbjInciapClS5ciJSUFuq4jPz8fS5YsCbvv66+/jqeeegqKoiAnJwfLly8Pu2///v3x29/+Fk6nE1evXsXixYvDXnj+17/+FU6nE5qmoaqqCtOmTQvZ59VXX0VaWhpM08TWrVvxpz/9Key5EhEB98CtjAzD3D85e/as/PrXv5aRI0fKvn37ZPPmzWH127Rpk3z66afSq1cvSU1NlcOHD8vatWvD6tuvXz8pLy+XGTNmyBNPPCELFiyQ4uLisPr26dNHvvnmG/n5z38u6enp8swzz4TsM378eDl16pQkJyfLT37yE0lLS4v4cWcY5r5LxCfAMMx9lPz8fOtzjx49pKysLGSfxMREuXTpkt/35eXlYT0Lau/evfLqq6/6fLd161b5/e9/H7Jvamqq5ObmNmgfZ86cKcePH4/4sWYY5v4N12ARUYNomoZly5Zh6tSpWL58OTZv3hyyz+OPP45jx475ff/1118jPj4+ZP8HH3wQn3zyic932dnZfq+2CaSmpgbJycnYvXs39u/fj1deeSVkn/Xr1yM/Px9nzpxp0POqiIi8uAaLiBpEVVW0b98eTz75JGJiYjB8+PCQfaqrq/HQQw/5fd+2bduw3rWoaRratGnj8127du2CvgOxrubNm6O4uBhz586Fqqo4efJkyD4AMG3aNCQmJmLJkiX47LPP0Ldv37D6ERF5Rfw0GsMw908KCgokLi5OAMiRI0dk+vTpYfU7f/68jBo1yvrzlClT5OzZs2H1XblypeTk5Ph8V1RUJJMnTw7ZNzU1Vf7zn/98r30uLy+P+HFnGOb+Cs9gEVGDqKqKDh06oKioCC+//DKysrKwadOmkP1mzZqF1atXIz09HQ6HA/369cMLL7wQ1jYzMjKwa9cu7N+/H4cPH8bgwYORnZ2N999/P2RfRVHgdDrD2o7XpEmTMGXKFBw5cgT9+/dHTk5Og/oTEfFJ7kTUIN27d/dZT/XjH/8YR44cCbv/pEmTICLIyspq8LaHDRuGmJgYfPXVVzh48GDY/ZKSknD8+PEGbWvkyJFo3749ysvLsWvXroZOlYiaOBZYRERERDbjXYRERERENmOBRURERGQzFlhERERENmOBRURERGQzFlhERERENmOBRURERGQzFlhERERENmOBRURERGQzFlhERERENmOBRURERGQzFlhERERENmOBRURERGQzFlhERERENmOBRURERGQzFlhERERENmOBRURERGQzFlhERERENmOBRURERGQzFlhERERENmOBRURERGQzFlhERERENmOBRURERGQzFlhERERENvs/Ae42f4GXT88AAAAASUVORK5CYII=";

export default function EstimateSigningClient({
  estimate,
  token,
}: {
  estimate: Estimate;
  token: string;
}) {
  const [signedName, setSignedName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(estimate.status === "SIGNED");
  const [error, setError] = useState("");
  // Pricing is hidden until customer taps to reveal (already revealed if signed)
  const [priceRevealed, setPriceRevealed] = useState(true);

  // Expired = manually voided OR past 30-day signing window
  // Page always loads — isExpired only hides the sign button, not the content
  const isExpired = estimate.status === "EXPIRED" ||
    !!(estimate.expiresAt && new Date(estimate.expiresAt) < new Date());

  const lineItems = estimate.lineItems.filter((i) => !i.isWarranty);
  const warrantyItems = estimate.lineItems.filter((i) => i.isWarranty && (
    (i.label.includes("GAF") && estimate.includeGafWarranty) ||
    (i.label.includes("Labor") && estimate.includeLaborWarranty)
  ));
  const total = lineItems.reduce((sum, i) => sum + i.amount, 0);

  async function handleSign() {
    if (!signedName.trim() || !agreed) return;
    setSigning(true);
    setError("");
    try {
      await signEstimate(token, signedName.trim(), "");
      setSigned(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSigning(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <style>{`
        @media print {
          body { background: white !important; }
          .no-print { display: none !important; }
          .print-break { page-break-before: always; }
        }
      `}</style>
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Logo Header */}
        <div className="rounded-2xl overflow-hidden shadow-sm">
          <img
            src={"data:image/png;base64," + LOGO_B64}
            alt="Lightfoot Roofs"
            className="w-full block"
            style={{ height: "120px", objectFit: "cover", objectPosition: "center" }}
          />
        </div>

        {/* Estimate Info */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Estimate {estimate.estimateNumber}</h2>
              <p className="text-sm text-gray-500 mt-1">
                Prepared for: <span className="font-medium text-gray-900">{estimate.job.customerName}</span>
              </p>
              <p className="text-sm text-gray-500">
                Property: <span className="font-medium text-gray-900">
                  {estimate.job.propertyStreet}, {estimate.job.propertyCity}, {estimate.job.propertyState}
                </span>
              </p>
              <p className="text-xs text-gray-400 mt-1">Lightfoot Roofing Inc, DBA Lightfoot Roofs · Edmond, Oklahoma · accounting@lightfootroofs.com</p>
            </div>
            <div className="flex-shrink-0 text-right">
              {signed && <span className="inline-block bg-green-100 text-green-700 text-xs font-bold px-3 py-1.5 rounded-full">✓ Signed</span>}
              {isExpired && !signed && <span className="inline-block bg-yellow-100 text-yellow-700 text-xs font-bold px-3 py-1.5 rounded-full">Signing Expired</span>}
              {!signed && !isExpired && estimate.expiresAt && (
                <p className="text-xs text-gray-400">Sign by {new Date(estimate.expiresAt).toLocaleDateString()}</p>
              )}

            </div>
          </div>
        </div>

        {/* Line items — hidden until customer taps to reveal */}
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-sm font-bold text-gray-900">Scope of Work & Pricing</h3>
            {!priceRevealed && (
              <span className="text-xs text-gray-400 font-medium">Tap to reveal</span>
            )}
          </div>

          {/* Blurred overlay when not revealed */}
          <div className="relative">
            <div className={priceRevealed ? "" : "blur-sm pointer-events-none select-none"}>
              <div className="divide-y divide-gray-100">
                {lineItems.map((item) => (
                  <div key={item.id} className="px-6 py-4 flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-gray-900">{item.label}</p>
                      {item.description && <p className="text-sm text-gray-500 mt-0.5 whitespace-pre-wrap">{item.description}</p>}
                      {item.quantity !== 1 && (
                        <p className="text-xs text-gray-400 mt-0.5">
                          {item.quantity} {item.unitPrice > 0 ? `× ${fmt$(item.unitPrice)}` : ""}
                        </p>
                      )}
                    </div>
                    <span className="text-sm font-bold text-gray-900 flex-shrink-0">{fmt$(item.amount)}</span>
                  </div>
                ))}
                {lineItems.length === 0 && (
                  <div className="px-6 py-8 text-center text-sm text-gray-400">No line items on this estimate.</div>
                )}
              </div>
              <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-between items-center">
                <span className="text-base font-bold text-gray-900">Total</span>
                <span className="text-xl font-bold text-gray-900">{fmt$(total)}</span>
              </div>
            </div>

            {/* Reveal button overlaid on top of blur */}
            {!priceRevealed && (
              <button
                onClick={() => setPriceRevealed(true)}
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/60"
              >
                <div className="bg-gray-900 text-white rounded-xl px-5 py-3 flex items-center gap-2.5 shadow-lg">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  </svg>
                  <span className="text-sm font-bold">Tap to View Pricing</span>
                </div>
                <p className="text-xs text-gray-500">Your estimate total is ready to review</p>
              </button>
            )}
          </div>
        </div>

        {/* Warranties */}
        {warrantyItems.length > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5">
            <h3 className="text-sm font-bold text-blue-900 mb-3">✓ Included Warranties</h3>
            <div className="space-y-4">
              {warrantyItems.map((item) => (
                <div key={item.id} className="flex gap-3">
                  <div className="w-5 h-5 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-blue-800">{item.label}</p>
                    {item.description && <p className="text-xs text-blue-600 mt-0.5">{item.description}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Financing */}
        {estimate.includeFinancing && (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-5">
            <h3 className="text-sm font-bold text-green-900 mb-1">💳 Financing Available</h3>
            <p className="text-sm text-green-700 mb-3">Monthly payment options available. Apply in minutes with no impact to your credit score.</p>
            <a href="#financing" className="inline-flex items-center gap-2 px-4 py-2.5 bg-green-600 text-white text-sm font-semibold rounded-xl hover:bg-green-700">
              Apply for Financing
            </a>
          </div>
        )}

        {/* Signing */}
        {!signed && !isExpired && (
          <div className="bg-white rounded-2xl border border-gray-200 p-6 no-print">
            <h3 className="text-base font-bold text-gray-900 mb-1">Approve & Sign Estimate</h3>
            <p className="text-sm text-gray-500 mb-4">
              By signing below, you agree to the scope of work and pricing outlined in this estimate.
              A copy will be emailed to you upon signing.
            </p>

            {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Full Name *</label>
                <input
                  type="text"
                  value={signedName}
                  onChange={(e) => setSignedName(e.target.value)}
                  placeholder="Type your full name to sign"
                  className="block w-full rounded-xl border border-gray-300 px-4 py-3 text-sm focus:border-red-500 focus:outline-none font-medium"
                />
              </div>

              {signedName && (
                <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Signature Preview</p>
                  <p className="text-2xl font-bold text-gray-800" style={{ fontFamily: "cursive" }}>{signedName}</p>
                </div>
              )}

              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 rounded text-red-600" />
                <span className="text-xs text-gray-600">
                  I agree to the scope of work and pricing in this estimate. I understand this is an authorization for Lightfoot Roofs to perform the described work at the stated price, and that changes must be agreed upon in writing via a change order.
                </span>
              </label>

              <button
                onClick={handleSign}
                disabled={!signedName.trim() || !agreed || signing}
                className="w-full py-3 bg-red-600 text-white font-bold rounded-xl hover:bg-red-700 disabled:opacity-50 text-sm"
              >
                {signing ? "Signing..." : "Sign & Approve Estimate"}
              </button>
            </div>
          </div>
        )}

        {/* Signing period expired — always viewable, signing disabled */}
        {isExpired && !signed && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center">
            <p className="text-amber-800 font-bold text-base">Signing Period Has Ended</p>
            <p className="text-amber-700 text-sm mt-2">The 30-day window to sign this estimate has passed, but you can still review it above. Give us a call and we'll get you a fresh one right away.</p>
            <a href="tel:4058344799" className="inline-block mt-4 px-5 py-2.5 bg-amber-700 text-white text-sm font-semibold rounded-xl hover:bg-amber-800">
              Call Us: 405-834-4799
            </a>
          </div>
        )}

        {/* Signed confirmation */}
        {signed && (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-6 text-center">
            <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-green-900">Welcome to the Lightfoot Family!</h3>
            <p className="text-sm text-green-700 mt-1">
              {estimate.signedByName ? `Signed by ${estimate.signedByName}` : "This estimate has been signed."}
              {estimate.signedAt ? ` on ${new Date(estimate.signedAt).toLocaleDateString()}` : ""}
            </p>
            <p className="text-sm text-green-600 mt-2">A copy of this estimate has been sent to your email. We will be in touch shortly to schedule your project.</p>
          </div>
        )}

        <div className="rounded-2xl border-2 border-gray-900 bg-white p-4 mb-4">
          <p className="text-xs font-bold tracking-wide text-gray-900 mb-2">{ESTIMATE_TERMS_TITLE}</p>
          {ESTIMATE_TERMS.map((term, i) => (
            <p key={i} className="text-xs text-gray-700 leading-relaxed mb-2">{term}</p>
          ))}
          <p className="text-xs font-bold tracking-wide text-gray-900 mb-2 mt-4">{ESTIMATE_DEDUCTIBLE_NOTICE_TITLE}</p>
          <p className="text-xs text-gray-700 leading-relaxed">{ESTIMATE_DEDUCTIBLE_NOTICE}</p>
        </div>

        <div className="text-center pb-4">
          <p className="text-xs text-gray-400">Questions? Contact us at accounting@lightfootroofs.com · (405) 834-4799</p>
          <button
            onClick={() => window.print()}
            className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 bg-gray-100 text-gray-700 text-sm font-semibold rounded-xl hover:bg-gray-200 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.75 19.817m0 0a.75.75 0 0 1-.686.467H4.5a.75.75 0 0 1-.75-.75v-1.5a.75.75 0 0 1 .75-.75h1.065A42.377 42.377 0 0 0 6.75 19.817Zm10.56-5.988L17.25 19.817m0 0a.75.75 0 0 0 .686.467H19.5a.75.75 0 0 0 .75-.75v-1.5a.75.75 0 0 0-.75-.75h-1.065A42.378 42.378 0 0 1 17.25 19.817ZM3 9.75h18m-18 0a1.5 1.5 0 0 1-1.5-1.5V6a1.5 1.5 0 0 1 1.5-1.5h18A1.5 1.5 0 0 1 22.5 6v2.25A1.5 1.5 0 0 1 21 9.75M3 9.75v8.25A1.5 1.5 0 0 0 4.5 19.5h15a1.5 1.5 0 0 0 1.5-1.5V9.75" />
            </svg>
            Print / Save as PDF
          </button>
          <p className="text-xs text-gray-400 mt-0.5">Lightfoot Roofing Inc, DBA Lightfoot Roofs · 2236 NW 164th St, Ste 12, Edmond OK, 73013 · CIB Registration #OK 80006087</p>
        </div>
      </div>
    </div>
  );
}

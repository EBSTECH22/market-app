import { notFound, redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

// Roof Measurement Report — the field/supplier-facing sheet. Prints net and
// gross squares side by side because net is what you check against an
// independent measurement and gross is what you order and price.

export const metadata = { title: "Roof Measurement Report" };

const n1 = (n: any) => Number(n ?? 0).toFixed(1);
const n2 = (n: any) => Number(n ?? 0).toFixed(2);
const fmt$ = (n: any) => `$${Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const EDGE_LABEL: Record<string, string> = {
  RIDGE: "Ridge", HIP: "Hip", VALLEY: "Valley", EAVE: "Eave", RAKE: "Rake", WALL: "Wall",
};

export default async function MeasurementPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) redirect("/auth/login");

  const m: any = await (prisma as any).roofMeasurement.findUnique({
    where: { id },
    include: {
      facets: { orderBy: { sortOrder: "asc" } },
      job: true,
      createdBy: { select: { fullName: true } },
    },
  });
  if (!m) notFound();

  const takeoff = m.takeoffResult?.takeoff ?? null;
  const edges: any[] = m.takeoffResult?.geometry?.edges ?? [];
  const confidence = m.takeoffResult?.confidence ?? null;

  const address = m.address
    ?? [m.job?.propertyStreet, m.job?.propertyCity, m.job?.propertyState, m.job?.propertyZip].filter(Boolean).join(", ");

  const printedAt = new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago", dateStyle: "long", timeStyle: "short",
  });

  // Edge lengths grouped by type for the summary block.
  const edgeTotals = ["RIDGE", "HIP", "VALLEY", "EAVE", "RAKE", "WALL"].map((t) => ({
    type: t,
    lf: edges.filter((e) => e.type === t).reduce((s, e) => s + Number(e.lengthFt ?? 0), 0),
    count: edges.filter((e) => e.type === t).length,
  })).filter((r) => r.lf > 0);

  return (
    <div className="min-h-screen bg-white text-black">
      <style>{`
        @page { size: letter; margin: 0.5in; }
        @media print { .no-print { display: none !important; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      `}</style>

      <div className="no-print sticky top-0 bg-gray-100 border-b border-gray-300 px-4 py-2 flex justify-between items-center">
        <span className="text-sm text-gray-600">Roof Measurement Report</span>
        <span className="text-xs text-gray-500">Print or save as PDF with Ctrl+P (Cmd+P on Mac)</span>
      </div>

      <div className="max-w-[7.5in] mx-auto p-6 text-[11px] leading-snug">
        {/* Header */}
        <div className="flex justify-between items-start border-b-2 border-black pb-3 mb-4">
          <div>
            <div className="text-xl font-bold">ROOF MEASUREMENT REPORT</div>
            <div className="text-xs mt-0.5">Lightfoot Roofing Inc, DBA Lightfoot Roofs · CIB Reg. #OK 80006087</div>
            <div className="text-xs">2236 NW 164th St Ste 12, Edmond, OK 73013</div>
          </div>
          <div className="text-right text-xs">
            <div><span className="font-bold">Printed:</span> {printedAt}</div>
            {m.solarImageryDate && <div><span className="font-bold">Aerial imagery:</span> {m.solarImageryDate}</div>}
            <div><span className="font-bold">Measured by:</span> {m.createdBy?.fullName ?? "—"}</div>
          </div>
        </div>

        {/* Property */}
        <table className="w-full mb-4">
          <tbody>
            <tr>
              <td className="w-24 font-bold align-top py-0.5">Customer</td>
              <td className="py-0.5">{m.job?.customerName ?? "—"}</td>
              <td className="w-24 font-bold align-top py-0.5">Claim #</td>
              <td className="py-0.5">{m.job?.claimNumber ?? "—"}</td>
            </tr>
            <tr>
              <td className="font-bold align-top py-0.5">Property</td>
              <td className="py-0.5" colSpan={3}>{address || "—"}</td>
            </tr>
          </tbody>
        </table>

        {!takeoff && (
          <div className="border border-black p-4 text-center">
            This measurement has not been traced yet.
          </div>
        )}

        {takeoff && (
          <>
            {/* Headline numbers */}
            <div className="border-2 border-black mb-4">
              <div className="bg-black text-white px-2 py-1 text-xs font-bold">MEASUREMENT SUMMARY</div>
              <div className="grid grid-cols-4 divide-x divide-black">
                <Cell label="NET SQUARES" value={n2(takeoff.netSquares)} sub="true roof area" />
                <Cell label="GROSS SQUARES" value={n2(takeoff.grossSquares)} sub={`incl. ${takeoff.wastePct}% waste`} strong />
                <Cell label="PREDOMINANT PITCH" value={`${takeoff.predominantPitch}/12`} sub={`${takeoff.facetCount} facets`} />
                <Cell label="PLAN AREA" value={`${Math.round(Number(m.planAreaSqFt ?? 0)).toLocaleString()} ft²`} sub="footprint" />
              </div>
              <div className="border-t border-black px-2 py-1 text-[10px]">
                Order and price from <span className="font-bold">gross squares</span>. Net is the measured roof area before waste.
                Waste basis: {takeoff.wasteSource === "MANUAL" ? "manual override" : takeoff.wasteSource === "GABLE" ? "simple gable" : "cut-up / hip"}.
              </div>
            </div>

            {/* Linear feet */}
            <div className="mb-4">
              <div className="font-bold text-xs border-b border-black mb-1 pb-0.5">LINEAR MEASUREMENTS</div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-400">
                    <th className="text-left py-0.5">Type</th>
                    <th className="text-right py-0.5">Linear Feet</th>
                    <th className="text-right py-0.5">Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {edgeTotals.map((r) => (
                    <tr key={r.type} className="border-b border-gray-200">
                      <td className="py-0.5">{EDGE_LABEL[r.type]}</td>
                      <td className="text-right py-0.5 font-bold">{n1(r.lf)}</td>
                      <td className="text-right py-0.5">{r.count}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-black">
                    <td className="py-0.5 font-bold">Ridge + Hip (cap)</td>
                    <td className="text-right py-0.5 font-bold">{n1(Number(takeoff.ridgeLf) + Number(takeoff.hipLf))}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Facets */}
            <div className="mb-4">
              <div className="font-bold text-xs border-b border-black mb-1 pb-0.5">FACET DETAIL</div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-400">
                    <th className="text-left py-0.5">Facet</th>
                    <th className="text-right py-0.5">Pitch</th>
                    <th className="text-right py-0.5">Faces</th>
                    <th className="text-right py-0.5">Plan ft²</th>
                    <th className="text-right py-0.5">Slope ft²</th>
                    <th className="text-right py-0.5">Squares</th>
                    <th className="text-right py-0.5">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {m.facets.map((f: any) => (
                    <tr key={f.id} className="border-b border-gray-200">
                      <td className="py-0.5">{f.label}</td>
                      <td className="text-right py-0.5">{Number(f.pitch)}/12</td>
                      <td className="text-right py-0.5">{Math.round(Number(f.azimuth))}°</td>
                      <td className="text-right py-0.5">{Math.round(Number(f.planAreaSqFt ?? 0)).toLocaleString()}</td>
                      <td className="text-right py-0.5">{Math.round(Number(f.slopeAreaSqFt ?? 0)).toLocaleString()}</td>
                      <td className="text-right py-0.5 font-bold">{n2(Number(f.slopeAreaSqFt ?? 0) / 100)}</td>
                      <td className="text-right py-0.5 text-[10px]">
                        {[f.isSecondStory ? "2nd story" : null, f.excluded ? "excluded" : null].filter(Boolean).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Materials */}
            {takeoff.tiers?.[0] && (
              <div className="mb-4">
                <div className="font-bold text-xs border-b border-black mb-1 pb-0.5">MATERIAL QUANTITIES</div>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-400">
                      <th className="text-left py-0.5">Item</th>
                      <th className="text-right py-0.5">Quantity</th>
                      <th className="text-right py-0.5">Order</th>
                      <th className="text-left py-0.5 pl-3">Basis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {takeoff.tiers[0].quantities.map((q: any, i: number) => (
                      <tr key={i} className="border-b border-gray-200">
                        <td className="py-0.5">
                          {q.label}
                          {q.mode === "BUNDLED" && <span className="text-[9px] ml-1 text-gray-600">(in per-sq price)</span>}
                        </td>
                        <td className="text-right py-0.5 font-bold">{n2(q.quantity)} {q.unit}</td>
                        <td className="text-right py-0.5">{q.purchaseQty ? `${q.purchaseQty} ${q.purchaseUnit}${q.purchaseQty === 1 ? "" : "s"}` : "—"}</td>
                        <td className="py-0.5 pl-3 text-[10px] text-gray-700">{q.basis}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Tier pricing */}
            <div className="mb-4">
              <div className="font-bold text-xs border-b border-black mb-1 pb-0.5">PRICING OPTIONS</div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-400">
                    <th className="text-left py-0.5">Option</th>
                    <th className="text-left py-0.5">Shingle</th>
                    <th className="text-right py-0.5">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {takeoff.tiers.map((t: any, i: number) => (
                    <tr key={i} className="border-b border-gray-200">
                      <td className="py-1 font-bold">{t.name}</td>
                      <td className="py-1">{t.shingleLabel}</td>
                      <td className="text-right py-1 font-bold">{fmt$(t.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-[10px] mt-1">
                Totals reflect the current price list at time of printing and are not a contract. Final scope and price are
                set by the signed Service Agreement.
              </div>
            </div>

            {/* Verification */}
            <div className="border border-black p-2 text-[10px]">
              <div className="font-bold text-xs mb-1">HOW THIS MEASUREMENT WAS PRODUCED</div>
              <p className="mb-1">
                Roof planes were traced from aerial imagery. Plan areas are computed from the traced outlines; slope area is
                plan area times the slope multiplier for each facet&apos;s pitch. Ridge, hip, valley, eave, and rake lengths are
                derived from where the traced planes meet.
              </p>
              {confidence?.status && confidence.status !== "NONE" && (
                <p className="mb-1">
                  <span className="font-bold">Cross-check:</span> traced footprint is within{" "}
                  {confidence.deltaPct > 0 ? "+" : ""}{confidence.deltaPct}% of the Google building model
                  {confidence.status === "OK" ? " (within tolerance)." : " — outside tolerance, review the trace."}
                </p>
              )}
              <p>
                <span className="font-bold">Pitch verification:</span>{" "}
                {m.pitchVerifiedAt
                  ? `Confirmed on site with a pitch gauge on ${new Date(m.pitchVerifiedAt).toLocaleDateString("en-US", { timeZone: "America/Chicago" })}.`
                  : "NOT yet confirmed on site. Pitch scales every quantity on this report — verify with a gauge before ordering material."}
              </p>
              {m.notes && <p className="mt-1"><span className="font-bold">Notes:</span> {m.notes}</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Cell({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={`px-2 py-2 text-center ${strong ? "bg-gray-100" : ""}`}>
      <div className="text-[9px] font-bold tracking-wide">{label}</div>
      <div className="text-lg font-bold leading-tight">{value}</div>
      {sub && <div className="text-[9px]">{sub}</div>}
    </div>
  );
}

import { db } from "@/lib/db";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

/**
 * The paystubs for one run, one per page, ready for the printer.
 *
 * Rendered on the server from the STORED figures, never recomputed. A stub is
 * a record of what was withheld on a particular Friday; recomputing it on read
 * means changing somebody's filing status in March silently restates what they
 * were handed in January. Everything here comes out of the Paystub row,
 * including the W-4 snapshot it was worked out from.
 */

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const hrs = (hundredths: number) => (hundredths / 100).toFixed(2);

const niceDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });

const STATUS_LABEL: Record<string, string> = {
  SINGLE: "Single or married filing separately",
  MFJ: "Married filing jointly",
  HOH: "Head of household",
  MARRIED: "Married",
};

export default async function PaystubsPage({ params }: { params: { runId: string } }) {
  const denied = await denyUnless("people");
  if (denied) {
    return <main style={{ padding: 40, fontFamily: "system-ui" }}><h1>Not allowed</h1></main>;
  }

  const run = await db.payRun.findUnique({
    where: { id: params.runId },
    include: { stubs: { orderBy: { employeeName: "asc" } } },
  });
  if (!run) {
    return <main style={{ padding: 40, fontFamily: "system-ui" }}><h1>No such payroll run</h1></main>;
  }

  const marketName = process.env.MARKET_NAME || "Community Harvest";

  return (
    <main style={{ fontFamily: "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif", color: "#111827", background: "#f3f4f6", margin: 0, padding: 0 }}>
      <style>{`
        @page { size: letter; margin: 0.5in; }
        .stub { background:#fff; max-width:680px; margin:0 auto 18px; padding:28px 30px; border:1px solid #e5e7eb; border-radius:12px; }
        .row { display:flex; justify-content:space-between; gap:12px; }
        .lbl { font-size:10px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:#6b7280; }
        table { width:100%; border-collapse:collapse; font-size:13px; }
        td { padding:5px 0; }
        td.n { text-align:right; font-variant-numeric:tabular-nums; }
        .tot { border-top:1px solid #d1d5db; font-weight:700; }
        .net { border-top:2px solid #111827; font-size:16px; font-weight:800; }
        .draft { color:#92400e; background:#fffbeb; border:1px solid #fde68a; padding:8px 12px; border-radius:8px; font-size:12px; margin-bottom:14px; }
        .bar { max-width:680px; margin:0 auto; padding:14px 2px; }
        @media print {
          body, main { background:#fff !important; }
          .bar { display:none !important; }
          .stub { border:0; border-radius:0; margin:0; padding:0; max-width:none; page-break-after:always; }
          .stub:last-child { page-break-after:auto; }
        }
      `}</style>

      <div className="bar">
        <strong style={{ fontSize: 15 }}>
          Paystubs — {niceDay(run.periodFrom)} to {niceDay(run.periodTo)}
        </strong>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
          {run.stubs.length} {run.stubs.length === 1 ? "stub" : "stubs"} · paid {niceDay(run.payDate)} ·{" "}
          {run.status === "PAID" ? "final" : "DRAFT — not yet paid"} · print with your browser (Ctrl+P / Cmd+P)
        </div>
      </div>

      {run.stubs.map((s) => {
        const w4 = JSON.parse(s.w4Json || "{}") as Record<string, unknown>;
        const deds = JSON.parse(s.deductionsJson || "[]") as { name: string; amountCents: number }[];
        const manual = JSON.parse(s.manualJson || "[]") as string[];
        const withheld = s.ssCents + s.medicareCents + s.federalCents + s.stateCents + s.otherDedCents;
        return (
          <section className="stub" key={s.id}>
            {run.status !== "PAID" ? (
              <div className="draft">
                <b>Draft.</b> This run hasn&rsquo;t been marked paid, so these figures can still change. Don&rsquo;t
                hand it out yet.
              </div>
            ) : null}

            <div className="row" style={{ alignItems: "flex-start", marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.01em" }}>{marketName}</div>
                <div style={{ fontSize: 11, color: "#6b7280" }}>510 N Main St, Noble, OK 73068</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="lbl">Statement of earnings</div>
                <div style={{ fontSize: 12, marginTop: 2 }}>
                  {niceDay(run.periodFrom)} – {niceDay(run.periodTo)}
                </div>
                <div style={{ fontSize: 12, color: "#6b7280" }}>Paid {niceDay(run.payDate)}</div>
              </div>
            </div>

            <div className="row" style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #e5e7eb" }}>
              <div>
                <div className="lbl">Employee</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{s.employeeName}</div>
              </div>
              <div style={{ textAlign: "right", fontSize: 11, color: "#6b7280" }}>
                <div>{STATUS_LABEL[String(w4.fedFilingStatus || "SINGLE")] || "Single"}</div>
                {w4.fedStep2 ? <div>W-4 Step 2 checked</div> : null}
                {Number(w4.okAllowances || 0) > 0 ? <div>{String(w4.okAllowances)} Oklahoma allowances</div> : null}
              </div>
            </div>

            <table>
              <tbody>
                <tr>
                  <td className="lbl" colSpan={2}>Earnings</td>
                </tr>
                <tr>
                  <td>
                    Hours worked
                    <span style={{ color: "#9ca3af", fontSize: 11 }}>
                      {" "}{hrs(s.hourHundredths)} at {money(s.rateCents)} an hour
                    </span>
                  </td>
                  <td className="n">{money(s.grossCents)}</td>
                </tr>
                <tr className="tot">
                  <td>Gross pay</td>
                  <td className="n">{money(s.grossCents)}</td>
                </tr>

                <tr><td style={{ height: 10 }} /></tr>
                <tr><td className="lbl" colSpan={2}>Taken off</td></tr>
                <tr>
                  <td>Federal income tax</td>
                  <td className="n">−{money(s.federalCents)}</td>
                </tr>
                <tr>
                  <td>Social Security <span style={{ color: "#9ca3af", fontSize: 11 }}>6.2%</span></td>
                  <td className="n">−{money(s.ssCents)}</td>
                </tr>
                <tr>
                  <td>Medicare <span style={{ color: "#9ca3af", fontSize: 11 }}>1.45%</span></td>
                  <td className="n">−{money(s.medicareCents)}</td>
                </tr>
                <tr>
                  <td>Oklahoma income tax</td>
                  <td className="n">−{money(s.stateCents)}</td>
                </tr>
                {deds.map((d, i) => (
                  <tr key={i}>
                    <td>{d.name}</td>
                    <td className="n">−{money(d.amountCents)}</td>
                  </tr>
                ))}
                <tr className="tot">
                  <td>Total taken off</td>
                  <td className="n">−{money(withheld)}</td>
                </tr>

                <tr className="net">
                  <td>Take-home pay</td>
                  <td className="n">{money(s.netCents)}</td>
                </tr>
              </tbody>
            </table>

            {run.status === "PAID" ? (
              <>
                <div className="lbl" style={{ marginTop: 20, marginBottom: 4 }}>Year to date — {run.taxYear}</div>
                <table>
                  <tbody>
                    <tr><td>Gross pay</td><td className="n">{money(s.ytdGrossCents)}</td></tr>
                    <tr><td>Federal income tax</td><td className="n">{money(s.ytdFederalCents)}</td></tr>
                    <tr><td>Social Security</td><td className="n">{money(s.ytdSsCents)}</td></tr>
                    <tr><td>Medicare</td><td className="n">{money(s.ytdMedicareCents)}</td></tr>
                    <tr><td>Oklahoma income tax</td><td className="n">{money(s.ytdStateCents)}</td></tr>
                    <tr className="tot"><td>Take-home pay</td><td className="n">{money(s.ytdNetCents)}</td></tr>
                  </tbody>
                </table>
              </>
            ) : null}

            <div style={{ marginTop: 18, fontSize: 10, color: "#9ca3af", lineHeight: 1.5 }}>
              {/* Said on the stub itself, because the employee is the person
                  who most needs to know a figure was keyed rather than
                  calculated — it is their money. */}
              {manual.length > 0 ? (
                <div style={{ marginBottom: 4 }}>
                  Entered by the office rather than calculated: {manual.join(", ")}.
                </div>
              ) : null}
              {s.note ? <div style={{ marginBottom: 4 }}>{s.note}</div> : null}
              Federal withholding is figured by the IRS percentage method for {run.taxYear} (Publication 15-T).
              Keep this for your records. Questions about your hours or your withholding go to the market office.
            </div>
          </section>
        );
      })}
    </main>
  );
}

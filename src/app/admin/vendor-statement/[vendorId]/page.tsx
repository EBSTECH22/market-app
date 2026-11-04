import { denyUnless } from "@/lib/perm";
import { buildVendorStatement } from "@/lib/vendorstatement";

export const dynamic = "force-dynamic";

/**
 * A vendor's statement, laid out for paper.
 *
 * Server-rendered from the same builder the email and the screen use, so the
 * sheet handed across the counter can't disagree with the one in the inbox.
 *
 * Two sections, in the order a dispute gets settled: the money, in order, with
 * a running balance — then what actually sold, line by line with the time on
 * it. The running balance is the point. "Why is my cheque this?" is answered
 * by reading down one column.
 */

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const signed = (c: number) => (c < 0 ? `−${money(-c)}` : money(c));
const nice = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });

export default async function VendorStatementPage({
  params, searchParams,
}: {
  params: { vendorId: string };
  searchParams: { from?: string; to?: string };
}) {
  const denied = await denyUnless("financials");
  if (denied) return <main style={{ padding: 40, fontFamily: "system-ui" }}><h1>Not allowed</h1></main>;

  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const from = DAY.test(searchParams.from || "") ? searchParams.from! : "";
  const to = DAY.test(searchParams.to || "") ? searchParams.to! : "";
  if (!from || !to) {
    return <main style={{ padding: 40, fontFamily: "system-ui" }}><h1>Pick a date range</h1><p>Open this from the vendor&rsquo;s record.</p></main>;
  }

  const [a, b] = from <= to ? [from, to] : [to, from];
  const s = await buildVendorStatement(params.vendorId, a, b);
  if (!s) return <main style={{ padding: 40, fontFamily: "system-ui" }}><h1>No such vendor</h1></main>;

  const marketName = process.env.MARKET_NAME || "Community Harvest";
  const owed = s.closingBalanceCents;

  return (
    <main style={{ fontFamily: "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif", color: "#111827", background: "#f3f4f6", margin: 0 }}>
      <style>{`
        @page { size: letter; margin: 0.5in; }
        .sheet { background:#fff; max-width:760px; margin:0 auto; padding:30px 34px; border:1px solid #e5e7eb; border-radius:12px; }
        table { width:100%; border-collapse:collapse; font-size:12px; }
        th { text-align:left; font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:#6b7280; border-bottom:1px solid #d1d5db; padding:6px 6px 5px; }
        td { padding:5px 6px; border-bottom:1px solid #f3f4f6; vertical-align:top; }
        td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
        .lbl { font-size:10px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:#6b7280; margin:22px 0 6px; }
        .bal { font-weight:700; background:#fafafa; }
        .bar { max-width:760px; margin:0 auto; padding:14px 2px; }
        @media print {
          body, main { background:#fff !important; }
          .bar { display:none !important; }
          .sheet { border:0; border-radius:0; margin:0; padding:0; max-width:none; }
          tr { page-break-inside:avoid; }
          thead { display:table-header-group; }
        }
      `}</style>

      <div className="bar">
        <strong style={{ fontSize: 15 }}>{s.vendor.businessName} — statement</strong>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
          {nice(a)} to {nice(b)} · print with your browser (Ctrl+P / Cmd+P) ·{" "}
          <a href={`/api/admin/vendor-statement?vendorId=${s.vendor.id}&from=${a}&to=${b}&csv=1`}>download the CSV</a>
        </div>
      </div>

      <section className="sheet">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.01em" }}>{marketName}</div>
            <div style={{ fontSize: 11, color: "#6b7280" }}>510 N Main St, Noble, OK 73068</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="lbl" style={{ margin: 0 }}>Vendor statement</div>
            <div style={{ fontSize: 12, marginTop: 2 }}>{nice(a)} – {nice(b)}</div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", paddingBottom: 14, marginBottom: 6, borderBottom: "1px solid #e5e7eb" }}>
          <div>
            <div className="lbl" style={{ margin: 0 }}>Vendor</div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{s.vendor.businessName}</div>
            <div style={{ fontSize: 11, color: "#6b7280" }}>
              {s.vendor.code}{s.vendor.contactName ? ` · ${s.vendor.contactName}` : ""}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="lbl" style={{ margin: 0 }}>
              {owed > 0 ? "The market owes you" : owed < 0 ? "Your account is behind" : "Account"}
            </div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{owed === 0 ? "Square" : money(Math.abs(owed))}</div>
          </div>
        </div>

        {/* ---- the money, in order ------------------------------------- */}
        <div className="lbl">Account activity</div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 118 }}>Date</th>
              <th style={{ width: 62 }}>Time</th>
              <th>What</th>
              <th className="n" style={{ width: 86 }}>Amount</th>
              <th className="n" style={{ width: 86 }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="bal">
              <td colSpan={3}>Balance at the start of {nice(a)}</td>
              <td className="n" />
              <td className="n">{money(s.openingBalanceCents)}</td>
            </tr>
            {s.lines.length === 0 ? (
              <tr><td colSpan={5} style={{ color: "#6b7280", padding: "10px 6px" }}>Nothing moved on the account in this period.</td></tr>
            ) : (
              s.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.dateStr}</td>
                  <td>{l.timeStr}</td>
                  <td>
                    {l.label}
                    {l.note ? <span style={{ color: "#9ca3af" }}> — {l.note}</span> : null}
                  </td>
                  <td className="n" style={{ color: l.amountCents < 0 ? "#b91c1c" : "#065f46" }}>{signed(l.amountCents)}</td>
                  <td className="n">{money(l.balanceCents)}</td>
                </tr>
              ))
            )}
            <tr className="bal">
              <td colSpan={3}>Balance at the end of {nice(b)}</td>
              <td className="n" />
              <td className="n">{money(s.closingBalanceCents)}</td>
            </tr>
          </tbody>
        </table>

        {/* ---- the summary, so the page can be read without adding up --- */}
        <div className="lbl">For the period</div>
        <table>
          <tbody>
            <tr><td>Rang up at the till{s.totals.unitsSold ? ` — ${s.totals.unitsSold} item${s.totals.unitsSold === 1 ? "" : "s"}` : ""}</td><td className="n">{money(s.totals.salesGrossCents)}</td></tr>
            <tr><td>Less the market&rsquo;s share</td><td className="n">−{money(s.totals.marketShareCents)}</td></tr>
            <tr><td><b>Your sales</b></td><td className="n"><b>{money(s.totals.salesGrossCents - s.totals.marketShareCents)}</b></td></tr>
            {s.totals.refundsCents ? <tr><td>Refunds to customers</td><td className="n">−{money(s.totals.refundsCents)}</td></tr> : null}
            {s.totals.rentChargedCents ? <tr><td>Booth rent charged</td><td className="n">−{money(s.totals.rentChargedCents)}</td></tr> : null}
            {s.totals.rentPaidCents ? <tr><td>Rent you paid in</td><td className="n">+{money(s.totals.rentPaidCents)}</td></tr> : null}
            {s.totals.adjustmentsCents ? <tr><td>Adjustments</td><td className="n">{signed(s.totals.adjustmentsCents)}</td></tr> : null}
            {s.totals.paidOutCents ? <tr><td>Paid out to you</td><td className="n">−{money(s.totals.paidOutCents)}</td></tr> : null}
            {s.totals.otherCents ? <tr><td>Other account activity</td><td className="n">{signed(s.totals.otherCents)}</td></tr> : null}
          </tbody>
        </table>

        {/* ---- what sold ------------------------------------------------- */}
        <div className="lbl">What sold</div>
        {s.sales.length === 0 ? (
          <p style={{ fontSize: 12, color: "#6b7280" }}>Nothing of yours sold in this period.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 118 }}>Date</th>
                <th style={{ width: 62 }}>Time</th>
                <th style={{ width: 52 }}>Ticket</th>
                <th>Item</th>
                <th className="n" style={{ width: 34 }}>Qty</th>
                <th className="n" style={{ width: 78 }}>Customer paid</th>
                <th className="n" style={{ width: 74 }}>Market&rsquo;s share</th>
                <th className="n" style={{ width: 70 }}>Yours</th>
              </tr>
            </thead>
            <tbody>
              {s.sales.map((x, i) => (
                <tr key={i}>
                  <td>{x.dateStr}</td>
                  <td>{x.timeStr}</td>
                  <td>#{x.ticket}</td>
                  <td>
                    {x.item}
                    {x.optionsText ? <span style={{ color: "#9ca3af" }}> · {x.optionsText}</span> : null}
                    {x.saleStatus !== "COMPLETE" ? (
                      <span style={{ color: "#92400e" }}> · {x.saleStatus === "REFUNDED" ? "refunded" : "part refunded"}</span>
                    ) : null}
                  </td>
                  <td className="n">{x.quantity}</td>
                  <td className="n">{money(x.grossCents)}</td>
                  <td className="n">{money(x.marketShareCents)}</td>
                  <td className="n">{money(x.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p style={{ marginTop: 20, fontSize: 10, color: "#9ca3af", lineHeight: 1.5 }}>
          {/* A refund shows in the account column on the day it was given, not
              against the original sale — which is why a sale can appear here at
              its full amount and the money still be back with the customer. */}
          A refund appears in the account activity on the day it was given rather than against the original ticket,
          so a sale can be listed in full above while the money has gone back. This is a record of what moved through
          the market&rsquo;s books for you — it is not tax advice and not a 1099. Anything that looks wrong, tell the
          office and we will go through it.
        </p>
      </section>
    </main>
  );
}

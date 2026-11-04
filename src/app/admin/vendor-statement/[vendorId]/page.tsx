import { denyUnless } from "@/lib/perm";
import { buildVendorStatement } from "@/lib/vendorstatement";
import { StatementSheet, STATEMENT_CSS, SHEET_FONT } from "@/components/StatementSheet";

export const dynamic = "force-dynamic";

/**
 * A vendor's statement, laid out for paper — the office's copy.
 *
 * The sheet itself is StatementSheet, shared with the vendor's own portal page,
 * so the copy handed across the counter cannot disagree with the one the vendor
 * printed at home. This file is only the permission check, the date range and
 * the toolbar that doesn't print.
 */

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

  return (
    <main style={{ fontFamily: SHEET_FONT, color: "#111827", background: "#f3f4f6", margin: 0 }}>
      <style>{STATEMENT_CSS}</style>

      <div className="bar">
        <strong style={{ fontSize: 15 }}>{s.vendor.businessName} — statement</strong>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
          {nice(a)} to {nice(b)} · print with your browser (Ctrl+P / Cmd+P) ·{" "}
          <a href={`/api/admin/vendor-statement?vendorId=${s.vendor.id}&from=${a}&to=${b}&csv=1`}>download the CSV</a>
        </div>
      </div>

      <StatementSheet s={s} marketName={marketName} />
    </main>
  );
}

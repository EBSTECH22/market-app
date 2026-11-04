import { currentVendorId } from "@/lib/auth";
import { buildVendorStatement } from "@/lib/vendorstatement";
import { StatementSheet, STATEMENT_CSS, SHEET_FONT } from "@/components/StatementSheet";

export const dynamic = "force-dynamic";

/**
 * The vendor's own statement, laid out for paper.
 *
 * Same sheet as the office prints — StatementSheet — so a vendor who prints
 * their own and a vendor who is handed one across the counter are holding the
 * same document. The only difference between this page and the admin one is
 * who it will show: this reads the vendor id off THEIR session, so there is no
 * URL anybody can edit to see somebody else's month.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const nice = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });

/** Last full calendar month, which is what a vendor almost always wants. */
function lastWholeMonth(): { from: string; to: string } {
  const now = new Date();
  const ym = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" })
    .format(now).slice(0, 7);
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 2, 1));
  const last = new Date(Date.UTC(y, m - 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export default async function VendorStatementPrintPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
}) {
  const vendorId = currentVendorId();
  if (!vendorId) {
    return (
      <main style={{ padding: 40, fontFamily: "system-ui" }}>
        <h1>Please sign in</h1>
        <p><a href="/vendor">Go to your portal</a> and sign in, then open your statement again.</p>
      </main>
    );
  }

  const fallback = lastWholeMonth();
  const rawFrom = DAY.test(searchParams.from || "") ? searchParams.from! : fallback.from;
  const rawTo = DAY.test(searchParams.to || "") ? searchParams.to! : fallback.to;
  const [from, to] = rawFrom <= rawTo ? [rawFrom, rawTo] : [rawTo, rawFrom];

  const s = await buildVendorStatement(vendorId, from, to);
  if (!s) {
    return <main style={{ padding: 40, fontFamily: "system-ui" }}><h1>We couldn&rsquo;t find your account</h1></main>;
  }

  const marketName = process.env.MARKET_NAME || "Community Harvest";

  return (
    <main style={{ fontFamily: SHEET_FONT, color: "#111827", background: "#f3f4f6", margin: 0 }}>
      <style>{STATEMENT_CSS}</style>

      <div className="bar">
        <strong style={{ fontSize: 15 }}>Your statement</strong>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
          {nice(from)} to {nice(to)} · print it with your browser (Ctrl+P / Cmd+P) ·{" "}
          <a href={`/api/vendor/period-statement?from=${from}&to=${to}&csv=1`}>download the spreadsheet</a> ·{" "}
          <a href="/vendor#money">back to your portal</a>
        </div>
      </div>

      <StatementSheet s={s} marketName={marketName} />
    </main>
  );
}

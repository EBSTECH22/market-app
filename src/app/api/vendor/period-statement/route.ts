import { NextRequest, NextResponse } from "next/server";
import { currentVendorId } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { buildVendorStatement, statementCsv } from "@/lib/vendorstatement";

export const dynamic = "force-dynamic";

/**
 * The vendor's own copy of a period statement.
 *
 * GET ?from=&to=        → the statement
 * GET ?from=&to=&csv=1  → the same thing for their bookkeeper
 *
 * SAME BUILDER AS THE OFFICE, and that is the entire point of this route
 * existing rather than the portal computing its own figures. A vendor who rings
 * up about a line on their statement is looking at the same numbers the person
 * answering the phone is looking at, down to the running balance.
 *
 * The vendor id comes from THEIR OWN SESSION and is never read from the query
 * string, so there is no version of this URL that shows one vendor another
 * vendor's takings.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  return runRoute("vendor/period-statement GET", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

    const p = req.nextUrl.searchParams;
    const rawFrom = (p.get("from") || "").trim();
    const rawTo = (p.get("to") || "").trim();
    if (!DAY.test(rawFrom) || !DAY.test(rawTo)) {
      return NextResponse.json({ error: "Pick a start and end date." }, { status: 400 });
    }
    const [from, to] = rawFrom <= rawTo ? [rawFrom, rawTo] : [rawTo, rawFrom];

    const statement = await buildVendorStatement(vendorId, from, to);
    if (!statement) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });

    if (p.get("csv")) {
      return new NextResponse(statementCsv(statement), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="statement-${from}-to-${to}.csv"`,
        },
      });
    }

    return NextResponse.json({ statement, settlement: statement.settlementNote });
  });
}

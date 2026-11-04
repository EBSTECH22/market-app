import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { denyUnless } from "@/lib/perm";
import { runRoute } from "@/lib/handler";
import { recordAudit } from "@/lib/audit";
import { buildVendorStatement, vendorsWithActivity, statementCsv } from "@/lib/vendorstatement";
import { sendVendorStatementEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

/**
 * Vendor statements, on demand.
 *
 * GET  ?vendorId=&from=&to=        → one statement
 * GET  ?vendorId=&from=&to=&csv=1  → the same as a CSV download
 * GET  ?who=1&from=&to=            → who would get one, without building any
 * POST { vendorId, from, to }      → email it to that vendor
 * POST { all: true, from, to }     → email every vendor who had activity
 *
 * "financials" — a statement spells out what the market took as its share, so
 * it is not an ops screen.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function range(req: NextRequest) {
  const from = (req.nextUrl.searchParams.get("from") || "").trim();
  const to = (req.nextUrl.searchParams.get("to") || "").trim();
  if (!DAY.test(from) || !DAY.test(to)) return null;
  /* Backwards dates are a slip, not a request for an empty statement. */
  return from <= to ? { from, to } : { from: to, to: from };
}

export async function GET(req: NextRequest) {
  return runRoute("admin/vendor-statement GET", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
    const r = range(req);
    if (!r) return NextResponse.json({ error: "Pick a start and end date." }, { status: 400 });

    /* Who would be emailed, so the button can say a number before it sends. */
    if (req.nextUrl.searchParams.get("who")) {
      const ids = await vendorsWithActivity(r.from, r.to);
      const vendors = await db.vendor.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, businessName: true, email: true },
        orderBy: { code: "asc" },
      });
      return NextResponse.json({
        ...r,
        vendors,
        withoutEmail: vendors.filter((v) => !v.email).map((v) => v.code),
      });
    }

    const vendorId = (req.nextUrl.searchParams.get("vendorId") || "").trim();
    if (!vendorId) return NextResponse.json({ error: "Which vendor?" }, { status: 400 });
    const statement = await buildVendorStatement(vendorId, r.from, r.to);
    if (!statement) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });

    if (req.nextUrl.searchParams.get("csv")) {
      return new NextResponse(statementCsv(statement), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="statement-${statement.vendor.code}-${r.from}-to-${r.to}.csv"`,
        },
      });
    }
    return NextResponse.json({ statement });
  });
}

export async function POST(req: NextRequest) {
  return runRoute("admin/vendor-statement POST", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const from = String(body.from || "").trim();
    const to = String(body.to || "").trim();
    if (!DAY.test(from) || !DAY.test(to)) {
      return NextResponse.json({ error: "Pick a start and end date." }, { status: 400 });
    }
    const [a, b] = from <= to ? [from, to] : [to, from];

    const all = body.all === true;
    const one = String(body.vendorId || "").trim();
    if (!all && !one) return NextResponse.json({ error: "Which vendor?" }, { status: 400 });

    const ids = all ? await vendorsWithActivity(a, b) : [one];
    if (ids.length === 0) {
      return NextResponse.json({ error: "Nothing happened on anybody's account in that period." }, { status: 400 });
    }

    const sent: string[] = [];
    const noEmail: string[] = [];
    const failed: string[] = [];
    /* Built and sent one at a time rather than in parallel: each statement is
       several queries, and a hundred at once is how a serverless function gets
       killed halfway through a send with no record of who already got one. */
    for (const id of ids) {
      const statement = await buildVendorStatement(id, a, b);
      if (!statement) continue;
      if (!statement.vendor.email) { noEmail.push(statement.vendor.code); continue; }
      try {
        await sendVendorStatementEmail(statement);
        sent.push(statement.vendor.code);
      } catch {
        failed.push(statement.vendor.code);
      }
    }

    if (sent.length > 0) {
      await recordAudit(
        { action: "VENDOR_EDIT", targetType: all ? "ALL" : "VENDOR", targetId: all ? "ALL" : one,
          targetLabel: all ? `${sent.length} vendors` : sent[0],
          detail: `Statement for ${a} to ${b} emailed to ${sent.length} ${sent.length === 1 ? "vendor" : "vendors"}${noEmail.length ? ` — ${noEmail.length} have no email on file` : ""}${failed.length ? ` — ${failed.length} failed to send` : ""}` },
        req
      );
    }

    return NextResponse.json({ sent: sent.length, sentCodes: sent, noEmail, failed });
  });
}

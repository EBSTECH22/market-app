import { NextRequest, NextResponse } from "next/server";
import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";
import { parseEntries, setFloorCounts, countSummary } from "@/lib/stockcounts";

export const dynamic = "force-dynamic";

/**
 * The market office correcting floor counts — any vendor, several at once.
 *
 * "ops", not "money": counting what is on a shelf is a counter job. The person
 * who takes a delivery or finds three jars behind a crate should be able to
 * put it right without fetching an owner, and nothing here moves money.
 *
 * Every change IS audited, individually and with the old number, because a
 * stock count is the one figure a vendor's settlement rests on that staff can
 * change without the vendor watching. "Who said there were four of these?" has
 * to have an answer.
 *
 * PATCH { counts: [{ id, quantity }] }
 */
export async function PATCH(req: NextRequest) {
  { const denied = await denyUnless("ops"); if (denied) return denied; }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Couldn't read that. Try saving again." }, { status: 400 });
  }

  const entries = parseEntries((body as { counts?: unknown })?.counts);
  if (entries.length === 0) {
    return NextResponse.json({ error: "No counts were filled in." }, { status: 400 });
  }

  const result = await setFloorCounts(null, entries);

  for (const c of result.changed) {
    await recordAudit(
      {
        action: "ITEM_STOCK",
        targetType: "Item",
        targetId: c.id,
        targetLabel: `${c.sku} ${c.name}`,
        detail: `Floor count ${c.from} → ${c.to}`,
        before: { quantity: c.from },
        after: { quantity: c.to },
      },
      req
    );
  }

  return NextResponse.json({ ...result, summary: countSummary(result) });
}

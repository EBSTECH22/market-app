import { NextRequest, NextResponse } from "next/server";
import { currentVendorId } from "@/lib/auth";
import { notifyVendorRestock } from "@/lib/customers";
import { parseEntries, setFloorCounts, countSummary } from "@/lib/stockcounts";

export const dynamic = "force-dynamic";

/**
 * A vendor setting their own floor counts, the whole sheet at once.
 *
 * PATCH { counts: [{ id, quantity }] }
 */
export async function PATCH(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

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

  const result = await setFloorCounts(vendorId, entries);

  /* Anything that went UP is a restock, and the customers waiting on it should
     hear once about the batch rather than once per item. */
  if (result.changed.some((c) => c.to > c.from)) {
    notifyVendorRestock(vendorId).catch(() => {});
  }

  return NextResponse.json({ ...result, summary: countSummary(result) });
}

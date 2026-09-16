import { NextRequest, NextResponse } from "next/server";

import { runRoute } from "@/lib/handler";
import { viewsFor } from "@/lib/viewlog";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

/**
 * Full open history for one agreement's invoice.
 *
 * Only the vendor's own opens appear here — admin previews are never recorded,
 * so looking at this page can't pollute the list it is showing you.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return runRoute("admin/contracts/[id]/views GET", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const views = await viewsFor("INVOICE", params.id, 100);
    return NextResponse.json({ views });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { viewsFor } from "@/lib/viewlog";

export const dynamic = "force-dynamic";

/**
 * Full open history for one agreement's invoice.
 *
 * Only the vendor's own opens appear here — admin previews are never recorded,
 * so looking at this page can't pollute the list it is showing you.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return runRoute("admin/contracts/[id]/views GET", async () => {
    if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const views = await viewsFor("INVOICE", params.id, 100);
    return NextResponse.json({ views });
  });
}

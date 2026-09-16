import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

// admin moderation: delete any post
export async function DELETE(req: NextRequest) {
  { const denied = await denyUnless("market"); if (denied) return denied; }
  const { id } = await req.json();
  await db.post.delete({ where: { id: String(id || "") } });
  return NextResponse.json({ ok: true });
}

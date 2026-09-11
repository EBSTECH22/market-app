import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BYTES = 5 * 1024 * 1024;

// POST { employeeId, kind, filename, mime, dataB64 }
export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { employeeId, kind, filename, mime, dataB64 } = await req.json();
  if (!employeeId || !dataB64 || !filename) return NextResponse.json({ error: "Missing file." }, { status: 400 });
  const bytes = Math.floor((dataB64.length * 3) / 4);
  if (bytes > MAX_BYTES) return NextResponse.json({ error: "File too big — 5 MB max. Scan at a lower resolution." }, { status: 400 });
  if (!/^(image\/|application\/pdf)/.test(mime || "")) {
    return NextResponse.json({ error: "Images or PDFs only." }, { status: 400 });
  }
  const doc = await db.employeeDoc.create({
    data: { employeeId, kind: kind || "OTHER", filename: filename.slice(0, 120), mime, dataB64 },
    select: { id: true, kind: true, filename: true, createdAt: true },
  });
  return NextResponse.json({ doc });
}

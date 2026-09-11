import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET — download/view the document
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return new NextResponse("Unauthorized", { status: 401 });
  const doc = await db.employeeDoc.findUnique({ where: { id: params.id } });
  if (!doc) return new NextResponse("Not found", { status: 404 });
  const buf = Buffer.from(doc.dataB64, "base64");
  return new NextResponse(buf, {
    headers: {
      "Content-Type": doc.mime,
      "Content-Disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await db.employeeDoc.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}

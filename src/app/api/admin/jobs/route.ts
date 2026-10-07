import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute, HttpError } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

const STATUSES = ["NEW", "CONTACTED", "INTERVIEW", "HIRED", "DECLINED"];

/** Job applicants — owners and office managers. */
export async function GET() {
  return runRoute("admin/jobs GET", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const apps = await db.jobApplication.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
    return NextResponse.json({ applications: apps });
  });
}

/** PATCH { id, status?, adminNotes? } */
export async function PATCH(req: NextRequest) {
  return runRoute("admin/jobs PATCH", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const b = await req.json().catch(() => ({}));
    const id = String(b.id || "");
    const data: { status?: string; adminNotes?: string } = {};
    if (b.status !== undefined) {
      const s = String(b.status).toUpperCase();
      if (!STATUSES.includes(s)) throw new HttpError(400, "Unknown status.");
      data.status = s;
    }
    if (b.adminNotes !== undefined) data.adminNotes = String(b.adminNotes).slice(0, 4000);
    if (!Object.keys(data).length) throw new HttpError(400, "Nothing to change.");
    await db.jobApplication.update({ where: { id }, data });
    return NextResponse.json({ ok: true });
  });
}

/** DELETE ?id= */
export async function DELETE(req: NextRequest) {
  return runRoute("admin/jobs DELETE", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const id = req.nextUrl.searchParams.get("id") || "";
    await db.jobApplication.deleteMany({ where: { id } });
    return NextResponse.json({ ok: true });
  });
}

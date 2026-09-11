import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { sendApplicationDecisionEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

// PATCH { action: "accept" } | { action: "decline", reason? }
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { action, reason } = await req.json();
  const app = await db.vendorApplication.findUnique({ where: { id: params.id } });
  if (!app) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!["accept", "decline"].includes(action)) return NextResponse.json({ error: "Unknown action." }, { status: 400 });

  const accepted = action === "accept";
  const updated = await db.vendorApplication.update({
    where: { id: app.id },
    data: { status: accepted ? "ACCEPTED" : "DECLINED", decidedAt: new Date() },
  });
  try {
    await sendApplicationDecisionEmail(app.email, app.contactName, app.businessName, accepted, (reason || "").trim().slice(0, 500));
  } catch (err) { console.error("decision email failed", err); }
  return NextResponse.json({ application: updated });
}

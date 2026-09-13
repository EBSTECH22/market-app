import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const applications = await db.vendorApplication.findMany({ where: { vendorId: "" }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200 });
  return NextResponse.json({ applications });
}

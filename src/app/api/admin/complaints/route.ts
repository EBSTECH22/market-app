import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Market oversight: every complaint across all vendors, newest first
export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const threads = await db.thread.findMany({
    where: { type: "COMPLAINT" },
    include: { messages: { orderBy: { createdAt: "asc" } } },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  const vendors = await db.vendor.findMany({ select: { id: true, code: true, businessName: true } });
  const vmap = new Map(vendors.map((v) => [v.id, v]));
  return NextResponse.json({
    complaints: threads.map((t) => ({
      id: t.id, status: t.status, customerName: t.customerName, email: t.email, phone: t.phone,
      vendor: vmap.get(t.vendorId) || null, updatedAt: t.updatedAt,
      messages: t.messages.map((m) => ({ sender: m.sender, body: m.body, createdAt: m.createdAt })),
    })),
  });
}

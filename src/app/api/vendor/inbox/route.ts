import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { reconcileVendorPreorders } from "@/lib/preorder";

export const dynamic = "force-dynamic";

export async function GET() {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  await reconcileVendorPreorders(vendorId).catch(() => {});
  const threads = await db.thread.findMany({
    where: { vendorId },
    include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return NextResponse.json({
    threads: threads.map((t) => ({
      id: t.id, type: t.type, status: t.status, customerName: t.customerName,
      email: t.email, phone: t.phone, updatedAt: t.updatedAt,
      last: t.messages[0] ? { sender: t.messages[0].sender, body: t.messages[0].body.slice(0, 120) } : null,
    })),
  });
}

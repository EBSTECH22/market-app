import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const thread = await db.thread.findUnique({
    where: { token: params.token },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!thread) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  const vendor = await db.vendor.findUnique({ where: { id: thread.vendorId }, select: { businessName: true, code: true } });
  return NextResponse.json({
    thread: {
      type: thread.type, status: thread.status, customerName: thread.customerName,
      vendorName: vendor?.businessName || "", createdAt: thread.createdAt,
      messages: thread.messages.map((m) => ({ id: m.id, sender: m.sender, body: m.body, createdAt: m.createdAt })),
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const review = await db.review.update({ where: { id: params.id }, data: { likes: { increment: 1 } } });
    return NextResponse.json({ likes: review.likes });
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
}

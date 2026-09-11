import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { name, body, website } = await req.json();
  if (website) return NextResponse.json({ ok: true });
  const review = await db.review.findUnique({ where: { id: params.id } });
  if (!review) return NextResponse.json({ error: "Review not found." }, { status: 404 });
  if (!name?.trim() || !body?.trim()) return NextResponse.json({ error: "Name and comment are both needed." }, { status: 400 });
  const comment = await db.reviewComment.create({
    data: { reviewId: review.id, name: name.trim().slice(0, 60), body: body.trim().slice(0, 1000) },
  });
  return NextResponse.json({ comment });
}

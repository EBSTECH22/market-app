import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Reviews across every vendor, and the ability to take one down.
 *
 * Deliberately NOT given to vendors. A vendor who can delete their own bad
 * reviews turns the whole rating into decoration, and a shopper who works that
 * out stops believing any of it — including the honest five stars. So this is
 * gated on "market": the owner and the office manager, nobody else.
 *
 * Every removal is written to the activity log with the text that was removed,
 * because "who deleted that review and what did it say" is a question that gets
 * asked weeks later, usually by the vendor it was about.
 */
export async function GET(req: NextRequest) {
  return runRoute("admin/reviews GET", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }

    const vendorId = req.nextUrl.searchParams.get("vendorId") || "";
    const reviews = await db.review.findMany({
      where: vendorId ? { vendorId } : {},
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    const comments = await db.reviewComment.findMany({
      where: { reviewId: { in: reviews.map((r) => r.id) } },
      orderBy: { createdAt: "asc" },
    });

    const vendors = await db.vendor.findMany({ select: { id: true, code: true, businessName: true } });
    /* Explicit generics: without them TypeScript infers `Map<{}, {}>` from a
       mapped tuple and every later property access fails the build. */
    const vmap = new Map<string, { id: string; code: string; businessName: string }>(
      vendors.map((v) => [v.id, v] as [string, { id: string; code: string; businessName: string }])
    );

    return NextResponse.json({
      reviews: reviews.map((r) => ({
        id: r.id,
        vendor: vmap.get(r.vendorId) || null,
        name: r.name,
        rating: r.rating,
        body: r.body,
        likes: r.likes,
        createdAt: r.createdAt,
        comments: comments
          .filter((c) => c.reviewId === r.id)
          .map((c) => ({ id: c.id, name: c.name, body: c.body, createdAt: c.createdAt })),
      })),
    });
  });
}

/** DELETE { reviewId } or { commentId } — one or the other, never both. */
export async function DELETE(req: NextRequest) {
  return runRoute("admin/reviews DELETE", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));

    const reviewId = String(body.reviewId || "");
    const commentId = String(body.commentId || "");

    if (commentId) {
      const comment = await db.reviewComment.findUnique({ where: { id: commentId } });
      if (!comment) return NextResponse.json({ error: "That reply is already gone." }, { status: 404 });

      await db.reviewComment.delete({ where: { id: commentId } });
      await recordAudit(
        {
          action: "REVIEW_DELETE",
          targetType: "REVIEW",
          targetId: commentId,
          targetLabel: `Reply by ${comment.name || "anonymous"}`,
          detail: `Removed a reply: "${comment.body.slice(0, 300)}"`,
        },
        req
      );
      return NextResponse.json({ ok: true });
    }

    if (!reviewId) return NextResponse.json({ error: "Nothing to delete." }, { status: 400 });

    const review = await db.review.findUnique({ where: { id: reviewId } });
    if (!review) return NextResponse.json({ error: "That review is already gone." }, { status: 404 });

    const vendor = await db.vendor.findUnique({
      where: { id: review.vendorId },
      select: { code: true, businessName: true },
    });

    /* The replies go with it. There's no foreign key between them — this app
       joins by id in application code — so without this the replies survive
       as orphans that nothing will ever render or clean up. */
    const replies = await db.reviewComment.deleteMany({ where: { reviewId } });
    await db.review.delete({ where: { id: reviewId } });

    await recordAudit(
      {
        action: "REVIEW_DELETE",
        targetType: "REVIEW",
        targetId: reviewId,
        targetLabel: vendor ? `${vendor.code} · ${vendor.businessName}` : "Unknown vendor",
        detail:
          `Removed a ${review.rating}-star review by ${review.name || "anonymous"}: "${review.body.slice(0, 300)}"` +
          (replies.count ? ` (and ${replies.count} ${replies.count === 1 ? "reply" : "replies"})` : ""),
      },
      req
    );

    return NextResponse.json({ ok: true, repliesRemoved: replies.count });
  });
}

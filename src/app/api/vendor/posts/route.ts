import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { sendVendorNewsEmail } from "@/lib/email";
import { runRoute } from "@/lib/handler";

export const dynamic = "force-dynamic";

/**
 * Posting, and optionally telling the people who follow this vendor.
 *
 * The research on market vendors is consistent: the ones who sell most are the
 * ones marketing themselves. Most won't — not because they don't want to, but
 * because "post on Instagram" is a job. They already have followers here, so
 * one checkbox does the job for them.
 *
 * Guard rails, because this is the only direct line a vendor has to customers:
 *  - followers of THIS vendor only, never the market's whole customer list
 *  - never anyone unsubscribed
 *  - rate limited to one blast a day, so following somebody can't become a
 *    reason to stop reading your email
 */

/** A vendor can notify followers this often. */
const NOTIFY_COOLDOWN_HOURS = 20;

export async function GET() {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const posts = await db.post.findMany({ where: { vendorId }, orderBy: { createdAt: "desc" }, take: 30 });
  return NextResponse.json({ posts });
}

export async function POST(req: NextRequest) {
  return runRoute("vendor/posts POST", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
    const { body, photoId, notifyFollowers } = await req.json();
    const text = String(body || "").trim().slice(0, 1200);
    if (!text) return NextResponse.json({ error: "Write something first." }, { status: 400 });

    const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: { businessName: true, code: true } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });

    const post = await db.post.create({ data: { vendorId, body: text, photoId: String(photoId || "") } });
    if (!notifyFollowers) return NextResponse.json({ post });

    /* One a day. Checked against the SETTING row rather than post history,
       because a vendor posting five times and notifying once shouldn't be
       blocked by their own quiet posts. */
    const key = `vendorNotifyAt:${vendorId}`;
    const last = await db.setting.findUnique({ where: { key } });
    const lastAt = last ? new Date(last.value) : null;
    if (lastAt && !Number.isNaN(lastAt.getTime())) {
      const hours = (Date.now() - lastAt.getTime()) / 3_600_000;
      if (hours < NOTIFY_COOLDOWN_HOURS) {
        const wait = Math.ceil(NOTIFY_COOLDOWN_HOURS - hours);
        return NextResponse.json({
          post,
          notified: 0,
          error: `Your post is up, but you already told your followers today. You can send another in about ${wait} hour${wait === 1 ? "" : "s"} — it keeps people from muting you.`,
        });
      }
    }

    const follows = await db.vendorFollow.findMany({
      where: { vendorId },
      select: { customer: { select: { email: true, token: true, unsubscribed: true } } },
    });
    const recipients = follows
      .map((f) => f.customer)
      .filter((c): c is { email: string; token: string; unsubscribed: boolean } =>
        !!c && !!c.email && !c.unsubscribed);

    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    let notified = 0;
    for (const c of recipients) {
      try {
        await sendVendorNewsEmail(c.email, vendor.businessName, text, `${base}/v/${vendor.code}`, `${base}/u/${c.token}`);
        notified++;
      } catch { /* one bad address shouldn't stop the rest of the list */ }
    }

    await db.setting.upsert({
      where: { key },
      create: { key, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    });

    return NextResponse.json({ post, notified, followerCount: follows.length });
  });
}

export async function DELETE(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const { id } = await req.json();
  await db.post.deleteMany({ where: { id: String(id || ""), vendorId } });
  return NextResponse.json({ ok: true });
}

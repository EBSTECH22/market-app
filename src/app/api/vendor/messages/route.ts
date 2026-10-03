import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";
import { runRoute, HttpError } from "@/lib/handler";
import { pushToAdmin } from "@/lib/push";
import { syncAllGroups, OFFICE_NAME } from "@/lib/messages";

export const dynamic = "force-dynamic";

const EPOCH = new Date(0);
const latest = (...ds: (Date | null | undefined)[]) => new Date(Math.max(...ds.map((d) => (d ? d.getTime() : 0))));

/** What a vendor sees a conversation called. A private chat with another
    vendor is called by that vendor's name (passed in as `other`). */
const titleFor = (c: { kind: string; title: string }, other = "") =>
  c.kind === "ALL" ? "Everyone at the market"
    : c.kind === "DIRECT" ? `${OFFICE_NAME} office`
      : c.kind === "VENDOR" ? other || "Vendor"
        : c.title || "Group message";

/** The other vendor in a private vendor-to-vendor chat. */
async function otherVendorName(conversationId: string, me: string): Promise<string> {
  const m = await db.conversationMember.findFirst({ where: { conversationId, vendorId: { not: me } }, select: { vendorId: true } });
  if (!m) return "";
  return (await db.vendor.findUnique({ where: { id: m.vendorId }, select: { businessName: true } }))?.businessName || "";
}

/**
 * GET        — this vendor's conversations with the office, unread counts, and
 *              the Home banner (unread office messages not yet dismissed).
 * GET ?id=   — one conversation's messages. Opening it marks it read.
 */
export async function GET(req: NextRequest) {
  return runRoute("vendor/messages GET", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
    const id = req.nextUrl.searchParams.get("id");

    /* ?vendors=1 — who this vendor can start a private chat with. */
    if (req.nextUrl.searchParams.get("vendors") === "1") {
      const vs = await db.vendor.findMany({
        where: { active: true, id: { not: vendorId } },
        select: { id: true, businessName: true, code: true },
        orderBy: { businessName: "asc" },
      });
      return NextResponse.json({ vendors: vs });
    }

    if (id) {
      const member = await db.conversationMember.findUnique({ where: { conversationId_vendorId: { conversationId: id, vendorId } } });
      const conv = member ? await db.conversation.findUnique({ where: { id } }) : null;
      if (!member || !conv) return NextResponse.json({ error: "That conversation isn't yours." }, { status: 404 });
      const messages = (await db.conversationMessage.findMany({ where: { conversationId: id }, orderBy: { createdAt: "desc" }, take: 300 })).reverse();
      const senderIds = [...new Set(messages.filter((m) => !m.fromOffice).map((m) => m.vendorId))];
      const vendors = await db.vendor.findMany({ where: { id: { in: senderIds } }, select: { id: true, businessName: true } });
      const vname = new Map<string, string>(vendors.map((v) => [v.id, v.businessName] as [string, string]));
      /* Only when there's something new — see the office side for why. */
      if (!member.lastReadAt || conv.lastAt > member.lastReadAt) {
        const now = new Date();
        await db.conversationMember.update({ where: { id: member.id }, data: { lastReadAt: now, dismissedAt: now } });
      }
      return NextResponse.json({
        me: vendorId,
        conversation: { id: conv.id, kind: conv.kind, title: titleFor(conv, conv.kind === "VENDOR" ? await otherVendorName(conv.id, vendorId) : "") },
        messages: messages.map((m) => ({
          id: m.id,
          fromOffice: m.fromOffice,
          mine: !m.fromOffice && m.vendorId === vendorId,
          name: m.fromOffice ? OFFICE_NAME : vname.get(m.vendorId) || "Vendor",
          body: m.body,
          createdAt: m.createdAt,
        })),
      });
    }

    await syncAllGroups();
    const memberships = await db.conversationMember.findMany({ where: { vendorId } });
    const convs = await db.conversation.findMany({ where: { id: { in: memberships.map((m) => m.conversationId) } }, orderBy: { lastAt: "desc" } });
    const conversations = [];
    const banner = [];
    for (const c of convs) {
      const m = memberships.find((x) => x.conversationId === c.id)!;
      const readFrom = latest(m.lastReadAt, m.joinedAt);
      const [last, unread, lastOffice] = await Promise.all([
        db.conversationMessage.findFirst({ where: { conversationId: c.id }, orderBy: { createdAt: "desc" } }),
        db.conversationMessage.count({ where: { conversationId: c.id, createdAt: { gt: readFrom }, NOT: { vendorId, fromOffice: false } } }),
        db.conversationMessage.findFirst({ where: { conversationId: c.id, fromOffice: true }, orderBy: { createdAt: "desc" } }),
      ]);
      /* A private conversation with the office is always listed, even before
         anyone has written in it. Empty group ones stay hidden. */
      if (!last && c.kind !== "DIRECT" && c.kind !== "VENDOR") continue;
      conversations.push({
        id: c.id, kind: c.kind, title: titleFor(c, c.kind === "VENDOR" ? await otherVendorName(c.id, vendorId) : ""), lastAt: c.lastAt,
        lastBody: last ? last.body.slice(0, 120) : "No messages yet", lastFromOffice: last?.fromOffice ?? false, unread,
      });
      /* Only the OFFICE's messages make a banner, and only until seen or dismissed. */
      if (lastOffice && lastOffice.createdAt > latest(m.lastReadAt, m.dismissedAt, m.joinedAt || EPOCH)) {
        banner.push({ conversationId: c.id, title: titleFor(c), body: lastOffice.body, createdAt: lastOffice.createdAt });
      }
    }
    return NextResponse.json({ conversations, banner, unreadTotal: conversations.reduce((n, c) => n + c.unread, 0) });
  });
}

/**
 * POST { action: "reply", conversationId, body }
 * POST { action: "dismiss", conversationId }   — "Got it" on the Home banner
 */
export async function POST(req: NextRequest) {
  return runRoute("vendor/messages POST", async () => {
    const vendorId = currentVendorId();
    if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
    const b = await req.json().catch(() => ({}));

    /* A private chat with another vendor, made if needed. The office can't see these. */
    if (b.action === "dm") {
      const otherId = String(b.vendorId || "");
      const other = await db.vendor.findFirst({ where: { id: otherId, active: true }, select: { id: true } });
      if (!other || otherId === vendorId) throw new HttpError(400, "Pick another vendor.");
      const mine = (await db.conversationMember.findMany({ where: { vendorId }, select: { conversationId: true } })).map((m) => m.conversationId);
      const theirs = (await db.conversationMember.findMany({ where: { vendorId: otherId, conversationId: { in: mine } }, select: { conversationId: true } })).map((m) => m.conversationId);
      let dm = await db.conversation.findFirst({ where: { kind: "VENDOR", id: { in: theirs } } });
      if (!dm) {
        dm = await db.conversation.create({ data: { kind: "VENDOR", title: "" } });
        await db.conversationMember.createMany({ data: [{ conversationId: dm.id, vendorId }, { conversationId: dm.id, vendorId: otherId }] });
      }
      return NextResponse.json({ ok: true, conversationId: dm.id });
    }

    /* "Message the office": the vendor's private conversation, made if needed. */
    if (b.action === "start") {
      const mine = await db.conversationMember.findMany({ where: { vendorId }, select: { conversationId: true } });
      let direct = await db.conversation.findFirst({ where: { kind: "DIRECT", id: { in: mine.map((m) => m.conversationId) } } });
      if (!direct) {
        const v = await db.vendor.findUnique({ where: { id: vendorId }, select: { businessName: true } });
        direct = await db.conversation.create({ data: { kind: "DIRECT", title: v?.businessName || "Vendor" } });
        await db.conversationMember.create({ data: { conversationId: direct.id, vendorId } });
      }
      return NextResponse.json({ ok: true, conversationId: direct.id });
    }

    const conversationId = String(b.conversationId || "");
    const member = await db.conversationMember.findUnique({ where: { conversationId_vendorId: { conversationId, vendorId } } });
    if (!member) throw new HttpError(404, "That conversation isn't yours.");
    const now = new Date();

    if (b.action === "dismiss") {
      await db.conversationMember.update({ where: { id: member.id }, data: { dismissedAt: now, lastReadAt: now } });
      return NextResponse.json({ ok: true });
    }

    if (b.action === "reply") {
      const body = String(b.body || "").trim().slice(0, 2000);
      if (!body) throw new HttpError(400, "Write something first.");
      await db.conversationMessage.create({ data: { conversationId, vendorId, fromOffice: false, body, createdAt: now } });
      await db.conversation.update({ where: { id: conversationId }, data: { lastAt: now } });
      await db.conversationMember.update({ where: { id: member.id }, data: { lastReadAt: now } });
      /* Replies tell the office, nobody else — only the office notifies vendors.
         A private vendor-to-vendor chat doesn't involve the office at all. */
      const conv = await db.conversation.findUnique({ where: { id: conversationId }, select: { kind: true } });
      if (conv?.kind !== "VENDOR") {
        const v = await db.vendor.findUnique({ where: { id: vendorId }, select: { businessName: true } });
        await pushToAdmin(`${v?.businessName || "A vendor"} replied`, body.slice(0, 160)).catch(() => 0);
      }
      return NextResponse.json({ ok: true });
    }

    throw new HttpError(400, "Don't know how to do that.");
  });
}

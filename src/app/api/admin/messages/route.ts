import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute, HttpError } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { currentAuditActor } from "@/lib/audit";
import { syncAllGroups, syncMembers, sendOfficeMessage, ensureStandardConversations, toE164 } from "@/lib/messages";

export const dynamic = "force-dynamic";
/* Emails go out one at a time, so a send to the whole market takes a while. */
export const maxDuration = 60;

const EPOCH = new Date(0);

/**
 * GET            — every conversation, the groups, and the vendor list.
 * GET ?id=       — one conversation: members (with read times) and messages.
 *                  Opening it marks it read for the office.
 */
export async function GET(req: NextRequest) {
  return runRoute("admin/messages GET", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const id = req.nextUrl.searchParams.get("id");

    /* ?board=1 — the vendors' own chat board, which the office can read and
       post in. Posts there never notify anyone. */
    if (req.nextUrl.searchParams.get("board") === "1") {
      const msgs = (await db.vendorChatMsg.findMany({ orderBy: { createdAt: "desc" }, take: 200 })).reverse();
      const vs = await db.vendor.findMany({ where: { id: { in: [...new Set(msgs.map((m) => m.vendorId))] } }, select: { id: true, businessName: true } });
      const vn = new Map<string, string>(vs.map((v) => [v.id, v.businessName] as [string, string]));
      return NextResponse.json({
        messages: msgs.map((m) => ({
          id: m.id,
          fromOffice: m.vendorId === "MARKET",
          name: m.vendorId === "MARKET" ? "Community Harvest" : vn.get(m.vendorId) || "Vendor",
          body: m.body,
          createdAt: m.createdAt,
        })),
      });
    }

    if (id) {
      const conv = await db.conversation.findUnique({ where: { id } });
      /* Private chats between two vendors are theirs, not the office's. */
      if (!conv || conv.kind === "VENDOR") return NextResponse.json({ error: "That conversation is gone." }, { status: 404 });
      await syncMembers(conv);
      const members = await db.conversationMember.findMany({ where: { conversationId: id } });
      const vendors = await db.vendor.findMany({
        where: { id: { in: members.map((m) => m.vendorId) } },
        select: { id: true, businessName: true, phone: true },
      });
      const vname = new Map<string, string>(vendors.map((v) => [v.id, v.businessName] as [string, string]));
      const messages = (await db.conversationMessage.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "desc" },
        take: 300,
      })).reverse();
      /* Only when there's something new. Every write tells all open screens to
         reload, so writing on every look would make them reload forever. */
      if (!conv.officeReadAt || conv.lastAt > conv.officeReadAt) {
        await db.conversation.update({ where: { id }, data: { officeReadAt: new Date() } });
      }

      /* Senders who have since left the group still get their name shown. */
      const others = [...new Set(messages.filter((m) => !m.fromOffice && !vname.has(m.vendorId)).map((m) => m.vendorId))];
      if (others.length) {
        for (const v of await db.vendor.findMany({ where: { id: { in: others } }, select: { id: true, businessName: true } })) {
          vname.set(v.id, v.businessName);
        }
      }

      return NextResponse.json({
        conversation: { id: conv.id, kind: conv.kind, title: conv.title, tagId: conv.tagId },
        members: members
          .map((m) => ({ vendorId: m.vendorId, name: vname.get(m.vendorId) || "Vendor", joinedAt: m.joinedAt, lastReadAt: m.lastReadAt }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        messages: messages.map((m) => ({
          id: m.id,
          fromOffice: m.fromOffice,
          vendorId: m.vendorId,
          name: m.fromOffice ? m.senderName || "Office" : vname.get(m.vendorId) || "Vendor",
          body: m.body,
          createdAt: m.createdAt,
        })),
        phones: vendors.map((v) => toE164(v.phone)).filter(Boolean),
      });
    }

    await syncAllGroups();
    const convs = await db.conversation.findMany({ where: { kind: { not: "VENDOR" } }, orderBy: { lastAt: "desc" } });
    const out = [];
    for (const c of convs) {
      const [last, unread, memberCount] = await Promise.all([
        db.conversationMessage.findFirst({ where: { conversationId: c.id }, orderBy: { createdAt: "desc" } }),
        db.conversationMessage.count({ where: { conversationId: c.id, fromOffice: false, createdAt: { gt: c.officeReadAt || EPOCH } } }),
        db.conversationMember.count({ where: { conversationId: c.id } }),
      ]);
      out.push({
        id: c.id, kind: c.kind, title: c.title, tagId: c.tagId, lastAt: c.lastAt,
        lastBody: last ? last.body.slice(0, 120) : "", lastFromOffice: last?.fromOffice ?? false,
        unread, memberCount, hasMessages: !!last,
      });
    }

    const tags = await db.vendorTag.findMany({ orderBy: { name: "asc" } });
    const tagMembers = await db.vendorTagMember.findMany();
    const vendors = await db.vendor.findMany({
      where: { active: true },
      select: { id: true, businessName: true, code: true, email: true, phone: true },
      orderBy: { businessName: "asc" },
    });
    const subs = await db.pushSub.findMany({ where: { vendorId: { in: vendors.map((v) => v.id) } }, select: { vendorId: true } });
    const withPush = new Set(subs.map((s) => s.vendorId));

    return NextResponse.json({
      conversations: out,
      tags: tags.map((t) => ({ id: t.id, name: t.name, count: tagMembers.filter((m) => m.tagId === t.id && vendors.some((v) => v.id === m.vendorId)).length })),
      vendors: vendors.map((v) => ({
        id: v.id, businessName: v.businessName, code: v.code,
        email: !!v.email, phone: toE164(v.phone), push: withPush.has(v.id),
        tagIds: tagMembers.filter((m) => m.vendorId === v.id).map((m) => m.tagId),
      })),
    });
  });
}

/**
 * POST { action: "send", conversationId? | to: { kind: "ALL" | "TAG" | "VENDORS", tagId?, vendorIds? }, subject?, body, push, email }
 * POST { action: "tag-create", name } | { action: "tag-rename", tagId, name } | { action: "tag-delete", tagId }
 * POST { action: "tag-toggle", tagId, vendorId, on }
 */
export async function POST(req: NextRequest) {
  return runRoute("admin/messages POST", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const b = await req.json().catch(() => ({}));
    const action = String(b.action || "");

    if (action === "send") {
      const body = String(b.body || "").trim().slice(0, 2000);
      const subject = String(b.subject || "").trim().slice(0, 120);
      if (!body) throw new HttpError(400, "Write the message first.");

      let conversationId = String(b.conversationId || "");
      if (conversationId) {
        const c = await db.conversation.findUnique({ where: { id: conversationId }, select: { kind: true } });
        if (!c || c.kind === "VENDOR") throw new HttpError(404, "That conversation is gone.");
      }
      if (!conversationId) {
        const to = b.to || {};
        await ensureStandardConversations();
        if (to.kind === "ALL") {
          conversationId = (await db.conversation.findFirst({ where: { kind: "ALL" } }))!.id;
        } else if (to.kind === "TAG") {
          const c = await db.conversation.findFirst({ where: { kind: "TAG", tagId: String(to.tagId || "") } });
          if (!c) throw new HttpError(400, "That group doesn't exist any more.");
          conversationId = c.id;
        } else if (to.kind === "VENDORS") {
          const ids = [...new Set<string>((Array.isArray(to.vendorIds) ? to.vendorIds : []).map(String))];
          const vendors = await db.vendor.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, businessName: true } });
          if (!vendors.length) throw new HttpError(400, "Pick at least one vendor.");
          if (vendors.length === 1) {
            /* One vendor: their private conversation with the office, reused. */
            const mine = await db.conversationMember.findMany({ where: { vendorId: vendors[0].id }, select: { conversationId: true } });
            const direct = await db.conversation.findFirst({ where: { kind: "DIRECT", id: { in: mine.map((m) => m.conversationId) } } });
            if (direct) conversationId = direct.id;
            else {
              const c = await db.conversation.create({ data: { kind: "DIRECT", title: vendors[0].businessName } });
              await db.conversationMember.create({ data: { conversationId: c.id, vendorId: vendors[0].id } });
              conversationId = c.id;
            }
          } else {
            const names = vendors.map((v) => v.businessName);
            const title = names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} + ${names.length - 2} more`;
            const c = await db.conversation.create({ data: { kind: "CUSTOM", title: title.slice(0, 80) } });
            await db.conversationMember.createMany({ data: vendors.map((v) => ({ conversationId: c.id, vendorId: v.id })), skipDuplicates: true });
            conversationId = c.id;
          }
        } else {
          throw new HttpError(400, "Choose who it goes to.");
        }
      }

      const actor = await currentAuditActor();
      const result = await sendOfficeMessage({
        conversationId, body, subject,
        senderName: actor.actorName || "Office",
        push: b.push !== false,
        email: b.email !== false,
      });
      return NextResponse.json({ ok: true, conversationId, ...result });
    }

    /* The office posting in the vendors' own chat board. No notifications —
       that board stays a board. */
    if (action === "board-post") {
      const body = String(b.body || "").trim().slice(0, 1000);
      if (!body) throw new HttpError(400, "Write something first.");
      await db.vendorChatMsg.create({ data: { vendorId: "MARKET", body } });
      return NextResponse.json({ ok: true });
    }

    if (action === "tag-create" || action === "tag-rename") {
      const name = String(b.name || "").trim().replace(/\s+/g, " ").slice(0, 30);
      if (!name) throw new HttpError(400, "Give the group a name.");
      const clash = await db.vendorTag.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
      if (clash && clash.id !== b.tagId) throw new HttpError(400, `There's already a group called ${clash.name}.`);
      if (action === "tag-create") await db.vendorTag.create({ data: { name } });
      else await db.vendorTag.update({ where: { id: String(b.tagId || "") }, data: { name } });
      await ensureStandardConversations();
      return NextResponse.json({ ok: true });
    }

    if (action === "tag-delete") {
      const tagId = String(b.tagId || "");
      /* The group's conversation is kept, frozen as a plain group, so its
         history isn't lost. */
      await db.conversation.updateMany({ where: { kind: "TAG", tagId }, data: { kind: "CUSTOM", tagId: "" } });
      await db.vendorTagMember.deleteMany({ where: { tagId } });
      await db.vendorTag.deleteMany({ where: { id: tagId } });
      return NextResponse.json({ ok: true });
    }

    if (action === "tag-toggle") {
      const tagId = String(b.tagId || "");
      const vendorId = String(b.vendorId || "");
      if (b.on) {
        await db.vendorTagMember.createMany({ data: [{ tagId, vendorId }], skipDuplicates: true });
      } else {
        await db.vendorTagMember.deleteMany({ where: { tagId, vendorId } });
      }
      const conv = await db.conversation.findFirst({ where: { kind: "TAG", tagId } });
      if (conv) await syncMembers(conv);
      return NextResponse.json({ ok: true });
    }

    throw new HttpError(400, "Don't know how to do that.");
  });
}

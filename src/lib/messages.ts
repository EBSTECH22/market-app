import { db } from "@/lib/db";
import { pushToVendor } from "@/lib/push";
import { sendVendorMessageEmail } from "@/lib/email";

/**
 * The office <-> vendor conversations.
 *
 *   ALL     every active vendor, kept in step as vendors come and go
 *   TAG     a group ("Bakers"), kept in step with who has the tag
 *   DIRECT  one vendor
 *   CUSTOM  a fixed set the office picked by hand
 *
 * Read receipts come from each member's lastReadAt: a message is read by every
 * member who joined before it and has looked since. Only the OFFICE's messages
 * notify, email or show a banner; a vendor's reply just sits in the thread.
 */

export const OFFICE_NAME = "Community Harvest";

/** A US number as +1XXXXXXXXXX, or "" if it isn't one. */
export function toE164(raw: string): string {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return "";
}

/** The Everyone conversation and one per tag, created if missing. */
export async function ensureStandardConversations(): Promise<void> {
  const all = await db.conversation.findFirst({ where: { kind: "ALL" }, select: { id: true } });
  if (!all) await db.conversation.create({ data: { kind: "ALL", title: "Everyone" } });
  const tags = await db.vendorTag.findMany({ select: { id: true, name: true } });
  const convs = await db.conversation.findMany({ where: { kind: "TAG" }, select: { id: true, tagId: true, title: true } });
  for (const t of tags) {
    const c = convs.find((x) => x.tagId === t.id);
    if (!c) await db.conversation.create({ data: { kind: "TAG", tagId: t.id, title: t.name } });
    else if (c.title !== t.name) await db.conversation.update({ where: { id: c.id }, data: { title: t.name } });
  }
}

/** Who should be in an ALL or TAG conversation right now. Null for fixed ones. */
async function wantedMembers(conv: { kind: string; tagId: string }): Promise<string[] | null> {
  if (conv.kind === "ALL") {
    return (await db.vendor.findMany({ where: { active: true }, select: { id: true } })).map((v) => v.id);
  }
  if (conv.kind === "TAG") {
    const ids = (await db.vendorTagMember.findMany({ where: { tagId: conv.tagId }, select: { vendorId: true } })).map((m) => m.vendorId);
    return (await db.vendor.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } })).map((v) => v.id);
  }
  return null;
}

/** Bring an ALL/TAG conversation's members in line with who belongs. */
export async function syncMembers(conv: { id: string; kind: string; tagId: string }): Promise<void> {
  const want = await wantedMembers(conv);
  if (!want) return;
  const have = (await db.conversationMember.findMany({ where: { conversationId: conv.id }, select: { vendorId: true } })).map((m) => m.vendorId);
  const add = want.filter((v) => !have.includes(v));
  const drop = have.filter((v) => !want.includes(v));
  if (add.length) {
    await db.conversationMember.createMany({
      data: add.map((vendorId) => ({ conversationId: conv.id, vendorId })),
      skipDuplicates: true,
    });
  }
  if (drop.length) {
    await db.conversationMember.deleteMany({ where: { conversationId: conv.id, vendorId: { in: drop } } });
  }
}

/** Every ALL/TAG conversation in step — cheap at a market's size. */
export async function syncAllGroups(): Promise<void> {
  await ensureStandardConversations();
  const convs = await db.conversation.findMany({ where: { kind: { in: ["ALL", "TAG"] } }, select: { id: true, kind: true, tagId: true } });
  for (const c of convs) await syncMembers(c);
}

/**
 * The office sends a message into a conversation and it goes out on the chosen
 * channels. Emails go one after another — the mail provider allows about two a
 * second.
 */
export async function sendOfficeMessage(opts: {
  conversationId: string;
  body: string;
  subject?: string;
  senderName: string;
  push: boolean;
  email: boolean;
}): Promise<{ messageId: string; pushed: number; emailed: number; emailFailed: string[]; phones: string[]; members: number }> {
  const conv = await db.conversation.findUnique({ where: { id: opts.conversationId } });
  if (!conv) throw new Error("No such conversation.");
  await syncMembers(conv);

  const text = opts.subject ? `${opts.subject}\n${opts.body}` : opts.body;
  const now = new Date();
  const msg = await db.conversationMessage.create({
    data: { conversationId: conv.id, fromOffice: true, senderName: opts.senderName.slice(0, 60), body: text, createdAt: now },
  });
  await db.conversation.update({ where: { id: conv.id }, data: { lastAt: now, officeReadAt: now } });

  const memberIds = (await db.conversationMember.findMany({ where: { conversationId: conv.id }, select: { vendorId: true } })).map((m) => m.vendorId);
  const vendors = await db.vendor.findMany({
    where: { id: { in: memberIds }, active: true },
    select: { id: true, businessName: true, contactName: true, email: true, phone: true },
  });

  const title = opts.subject || (conv.kind === "DIRECT" ? OFFICE_NAME : `${OFFICE_NAME} · ${conv.title}`);

  let pushed = 0;
  if (opts.push) {
    const results = await Promise.allSettled(vendors.map((v) => pushToVendor(v.id, title, opts.body.slice(0, 180))));
    pushed = results.filter((r) => r.status === "fulfilled" && (r.value as number) > 0).length;
  }

  let emailed = 0;
  const emailFailed: string[] = [];
  if (opts.email) {
    for (const v of vendors.filter((x) => x.email)) {
      const ok = await sendVendorMessageEmail(v.email, v.contactName, title, opts.body).catch(() => false);
      if (ok) emailed++;
      else emailFailed.push(v.businessName);
      await new Promise((r) => setTimeout(r, 550));
    }
  }

  return {
    messageId: msg.id,
    pushed,
    emailed,
    emailFailed,
    phones: vendors.map((v) => toE164(v.phone)).filter(Boolean),
    members: vendors.length,
  };
}

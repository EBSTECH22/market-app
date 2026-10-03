import webpush from "web-push";
import { db } from "@/lib/db";

let configured = false;
function setup(): boolean {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails("mailto:orders@dailybreadbaked.com", pub, priv);
  configured = true;
  return true;
}

// Sends to every device the vendor enabled. Returns how many pushes went out.
export type PushExtra = { url?: string; tag?: string };

export async function pushToVendor(vendorId: string, title: string, body: string, extra: PushExtra = {}): Promise<number> {
  if (!setup()) return 0;
  const subs = await db.pushSub.findMany({ where: { vendorId } });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, ...extra })
      );
      sent++;
    } catch (err: unknown) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await db.pushSub.delete({ where: { id: s.id } }).catch(() => {});
      } else {
        console.error("push failed", code);
      }
    }
  }
  return sent;
}

// Admin/staff devices subscribe under the "ADMIN" channel
export async function pushToAdmin(title: string, body: string, extra: PushExtra = {}): Promise<number> {
  return pushToVendor("ADMIN", title, body, extra);
}

/** The same notification to many vendors at once, in parallel. Returns how
    many vendors got it on at least one device. */
export async function pushToVendors(vendorIds: string[], title: string, body: string, extra: PushExtra = {}): Promise<number> {
  const ids = [...new Set(vendorIds)].filter((v) => v && v !== "ADMIN");
  if (!ids.length || !setup()) return 0;
  const results = await Promise.allSettled(ids.map((id) => pushToVendor(id, title, body, extra)));
  return results.filter((r) => r.status === "fulfilled" && r.value > 0).length;
}

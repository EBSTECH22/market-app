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
export async function pushToVendor(vendorId: string, title: string, body: string): Promise<number> {
  if (!setup()) return 0;
  const subs = await db.pushSub.findMany({ where: { vendorId } });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body })
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

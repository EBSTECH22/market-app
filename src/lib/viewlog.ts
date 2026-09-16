import { createHash } from "crypto";
import { db } from "@/lib/db";

/**
 * Records that a vendor opened one of their documents, and tells the office.
 *
 * Deliberately NOT called when an admin is the one looking. The point of the
 * log is "has the vendor seen this yet" — the office opening an invoice to
 * check it would otherwise fire a push at itself and pollute the history.
 */

/** One real view can produce more than one request: the invoice page fetches on
 *  mount and again after the Stripe redirect. Collapsing a repeat from the same
 *  viewer inside this window keeps the count honest. */
const DEDUPE_SECONDS = 60;

/** A coarse, non-identifying fingerprint — enough to spot a repeat from the same
 *  person minutes apart, not enough to identify anybody. */
export function viewerHash(ip: string, userAgent: string): string {
  return createHash("sha256").update(`${ip}|${userAgent}`).digest("hex").slice(0, 32);
}

export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    ""
  );
}

export type LogViewResult = {
  /** false when it was folded into a view we just recorded. */
  recorded: boolean;
  /** How many times this document has now been opened. */
  totalViews: number;
  /** True the very first time anyone opens it. */
  firstEver: boolean;
};

export async function logView(opts: {
  kind: "INVOICE" | "AGREEMENT";
  targetId: string;
  vendorId: string;
  headers: Headers;
}): Promise<LogViewResult> {
  const { kind, targetId, vendorId, headers } = opts;
  const ua = (headers.get("user-agent") || "").slice(0, 200);
  const hash = viewerHash(clientIp(headers), ua);

  const since = new Date(Date.now() - DEDUPE_SECONDS * 1000);
  const recent = await db.viewEvent.findFirst({
    where: { kind, targetId, viewerHash: hash, viewedAt: { gte: since } },
    select: { id: true },
  });

  const priorCount = await db.viewEvent.count({ where: { kind, targetId } });

  if (recent) {
    return { recorded: false, totalViews: priorCount, firstEver: false };
  }

  await db.viewEvent.create({
    data: { kind, targetId, vendorId, viewerHash: hash, userAgent: ua },
  });

  return { recorded: true, totalViews: priorCount + 1, firstEver: priorCount === 0 };
}

/**
 * When view tracking started, stamped the first time anything asks.
 *
 * Without this, an invoice paid before the feature existed reads as
 * "not opened" — which is false. We weren't watching. Anything executed
 * before this timestamp simply has no answer, and the UI says so rather
 * than implying the vendor ignored it.
 */
export async function viewTrackingSince(): Promise<Date> {
  const KEY = "viewTrackingStartedAt";
  const row = await db.setting.findUnique({ where: { key: KEY } });
  if (row) {
    const d = new Date(row.value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const now = new Date();
  await db.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: now.toISOString() },
    update: {},
  });
  return now;
}

/** Full history for one document, newest first. */
export async function viewsFor(kind: string, targetId: string, take = 50) {
  return db.viewEvent.findMany({
    where: { kind, targetId },
    orderBy: { viewedAt: "desc" },
    take,
    select: { id: true, viewedAt: true, userAgent: true },
  });
}

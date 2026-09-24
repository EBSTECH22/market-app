import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";
import { DEFAULT_OFFERS, waitlisted, availabilityLabel, termsLabel } from "@/lib/spaces";

export const dynamic = "force-dynamic";

/**
 * What the market lets, and how many are left — the office side.
 *
 * The first load seeds the three the market opened with, so the apply page is
 * never a blank list waiting on somebody to set it up. After that the rows are
 * whatever the office has made them.
 */
export async function GET() {
  return runRoute("admin/spaces GET", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }

    if ((await db.spaceOffer.count()) === 0) {
      for (const o of DEFAULT_OFFERS) {
        await db.spaceOffer.create({ data: { ...o } }).catch(() => {});
      }
    }

    const offers = await db.spaceOffer.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });

    /* How many are waiting on each one, so "full" and "nine people waiting"
       sit side by side — that pair is the whole argument for adding a booth. */
    const waiting = await db.vendorApplication.groupBy({
      by: ["spaceKey"],
      where: { status: "WAITLIST" },
      _count: { _all: true },
    });
    const waitMap = new Map<string, number>(waiting.map((w) => [w.spaceKey, w._count._all] as [string, number]));

    return NextResponse.json({
      offers: offers.map((o) => ({
        ...o,
        waitlist: waitlisted(o),
        availability: availabilityLabel(o),
        terms: termsLabel(o),
        waitingCount: waitMap.get(o.key) || 0,
      })),
    });
  });
}

const int = (v: unknown, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
};

/** PATCH { id, name?, blurb?, priceCents?, priceMaxCents?, commissionPercent?, available?, waitlistOnly?, active?, sortOrder? } */
export async function PATCH(req: NextRequest) {
  return runRoute("admin/spaces PATCH", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "");
    const existing = await db.spaceOffer.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "That space is gone." }, { status: 404 });

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = String(body.name).slice(0, 60);
    if (body.blurb !== undefined) data.blurb = String(body.blurb).slice(0, 300);
    if (body.priceCents !== undefined) data.priceCents = Math.max(0, int(body.priceCents, existing.priceCents));
    if (body.priceMaxCents !== undefined) data.priceMaxCents = Math.max(0, int(body.priceMaxCents, existing.priceMaxCents));
    if (body.commissionPercent !== undefined) {
      const pct = Number(body.commissionPercent);
      data.commissionPercent = Number.isFinite(pct) ? Math.max(0, Math.min(90, pct)) : existing.commissionPercent;
    }
    /* -1 stays -1: it means "no limit", not "minus one booth". */
    if (body.available !== undefined) {
      const n = int(body.available, existing.available);
      data.available = n < 0 ? -1 : n;
    }
    if (body.waitlistOnly !== undefined) data.waitlistOnly = !!body.waitlistOnly;
    if (body.active !== undefined) data.active = !!body.active;
    if (body.sortOrder !== undefined) data.sortOrder = int(body.sortOrder, existing.sortOrder);

    if (!Object.keys(data).length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

    const updated = await db.spaceOffer.update({ where: { id }, data });

    const changes: string[] = [];
    if (data.available !== undefined && data.available !== existing.available) {
      changes.push(`${existing.available < 0 ? "no limit" : existing.available} → ${updated.available < 0 ? "no limit" : updated.available} available`);
    }
    if (data.waitlistOnly !== undefined && data.waitlistOnly !== existing.waitlistOnly) {
      changes.push(updated.waitlistOnly ? "waiting list only" : "open for applications");
    }
    if (data.priceCents !== undefined && data.priceCents !== existing.priceCents) {
      changes.push(`price $${(existing.priceCents / 100).toFixed(2)} → $${(updated.priceCents / 100).toFixed(2)}`);
    }
    if (data.active !== undefined && data.active !== existing.active) changes.push(updated.active ? "shown on the apply page" : "hidden from the apply page");
    if (changes.length) {
      await recordAudit(
        {
          action: "SETTING_CHANGE",
          targetType: "SPACE_OFFER",
          targetId: updated.id,
          targetLabel: updated.name,
          detail: `${updated.name}: ${changes.join(", ")}`,
          before: { available: existing.available, waitlistOnly: existing.waitlistOnly, priceCents: existing.priceCents, active: existing.active },
          after: { available: updated.available, waitlistOnly: updated.waitlistOnly, priceCents: updated.priceCents, active: updated.active },
        },
        req
      );
    }

    return NextResponse.json({ ok: true, offer: updated });
  });
}

/** POST { key, name } — another kind of space to let. */
export async function POST(req: NextRequest) {
  return runRoute("admin/spaces POST", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim().slice(0, 60);
    if (!name) return NextResponse.json({ error: "Give it a name." }, { status: 400 });

    /* The key is what applications store, so it is made once from the name and
       never changes with it — renaming "Small display" must not orphan the
       people who applied for one. */
    const base = (String(body.key || name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "SPACE").slice(0, 32);
    let key = base;
    for (let i = 2; await db.spaceOffer.findUnique({ where: { key } }); i++) key = `${base}_${i}`;

    const last = await db.spaceOffer.findFirst({ orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    const offer = await db.spaceOffer.create({
      data: { key, name, sortOrder: (last?.sortOrder || 0) + 1 },
    });
    return NextResponse.json({ ok: true, offer });
  });
}

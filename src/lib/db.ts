import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const base = globalForPrisma.prisma ?? new PrismaClient();

/* THE CHANGE MARKER ("pulse"). Every screen polls it and reloads the moment
   it moves. Two things were wrong with how it moved:

   1. It moved TOO EARLY. A sale writes its rows inside a transaction, and the
      marker was bumped on the first of those writes — before the sale had
      committed. The admin screen saw the change, reloaded, found nothing new,
      and nothing moved the marker again afterwards. So the sale only appeared
      after a manual refresh.
   2. It could be DROPPED. The bump was fire-and-forget; on Vercel the
      function can be frozen the moment the reply goes out, killing a bump
      mid-flight (and the old "already bumping" flag then stayed stuck on).

   Now: bumps are collapsed into ONE trailing bump shortly after the LAST write
   (by then the transaction has committed), and the function is kept alive
   until it lands. */
const PULSE_DELAY_MS = 300;
let pulseTimer: ReturnType<typeof setTimeout> | null = null;
let pulseWaiters: (() => void)[] = [];

function keepAlive(p: Promise<unknown>): void {
  try {
    const ctx = (globalThis as unknown as Record<symbol, { get?: () => { waitUntil?: (x: Promise<unknown>) => void } } | undefined>)[
      Symbol.for("@vercel/request-context")
    ]?.get?.();
    ctx?.waitUntil?.(p);
  } catch {
    /* not on Vercel — nothing to keep alive */
  }
}

function bumpPulse(): void {
  if (pulseTimer) clearTimeout(pulseTimer);
  keepAlive(new Promise<void>((r) => pulseWaiters.push(r)));
  pulseTimer = setTimeout(() => {
    pulseTimer = null;
    const done = pulseWaiters;
    pulseWaiters = [];
    base.setting
      .upsert({ where: { key: "pulse" }, create: { key: "pulse", value: String(Date.now()) }, update: { value: String(Date.now()) } })
      .catch(() => null)
      .finally(() => done.forEach((r) => r()));
  }, PULSE_DELAY_MS);
}

/** Move the marker now. For routes that have just committed something every screen should see. */
export async function touchPulse(): Promise<void> {
  await base.setting
    .upsert({ where: { key: "pulse" }, create: { key: "pulse", value: String(Date.now()) }, update: { value: String(Date.now()) } })
    .catch(() => null);
}

// every write to any model bumps the pulse — clients poll it and refresh the moment anything changes
export const db = base.$extends({
  query: {
    $allModels: {
      async create({ model, args, query }) { const r = await query(args); if (model !== "Setting") void bumpPulse(); return r; },
      async createMany({ model, args, query }) { const r = await query(args); if (model !== "Setting") void bumpPulse(); return r; },
      async update({ model, args, query }) { const r = await query(args); if (model !== "Setting") void bumpPulse(); return r; },
      async updateMany({ model, args, query }) { const r = await query(args); if (model !== "Setting") void bumpPulse(); return r; },
      async upsert({ model, args, query }) { const r = await query(args); if (model !== "Setting") void bumpPulse(); return r; },
      async delete({ model, args, query }) { const r = await query(args); if (model !== "Setting") void bumpPulse(); return r; },
      async deleteMany({ model, args, query }) { const r = await query(args); if (model !== "Setting") void bumpPulse(); return r; },
    },
  },
}) as unknown as PrismaClient;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = base;

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const base = globalForPrisma.prisma ?? new PrismaClient();

let bumping = false;
async function bumpPulse() {
  if (bumping) return;
  bumping = true;
  try {
    await base.setting.upsert({ where: { key: "pulse" }, create: { key: "pulse", value: String(Date.now()) }, update: { value: String(Date.now()) } });
  } catch {} finally { bumping = false; }
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

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { TZ } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = (req.nextUrl.searchParams.get("q") || "").trim().toLowerCase();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const sales = await db.sale.findMany({
    where: { createdAt: { gte: cutoff } },
    include: { lines: { select: { vendorId: true } } },
    orderBy: { createdAt: "desc" },
    take: 400,
  });
  const vendors = await db.vendor.findMany({ select: { id: true, code: true, businessName: true } });
  const vmap = new Map(vendors.map((v) => [v.id, v]));

  const rows = sales
    .map((s) => {
      const codes = [...new Set(s.lines.map((l) => vmap.get(l.vendorId)?.code || "?"))];
      const names = [...new Set(s.lines.map((l) => vmap.get(l.vendorId)?.businessName || ""))];
      return {
        id: s.id, number: s.number, createdAt: s.createdAt,
        dateStr: s.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ }),
        timeStr: s.createdAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }),
        isoDate: new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(s.createdAt),
        paymentMethod: s.paymentMethod, cardName: s.cardName, employee: s.employee,
        totalCents: s.totalCents, vendorCodes: codes, vendorNames: names,
      };
    })
    .filter((r) => {
      if (!q) return true;
      if (String(r.number).includes(q)) return true;
      if (r.dateStr.toLowerCase().includes(q) || r.isoDate.includes(q)) return true;
      if (r.cardName.toLowerCase().includes(q)) return true;
      if (r.vendorNames.some((n) => n.toLowerCase().includes(q)) || r.vendorCodes.some((c) => c.toLowerCase().includes(q))) return true;
      return false;
    })
    .slice(0, 100);

  return NextResponse.json({ tickets: rows });
}

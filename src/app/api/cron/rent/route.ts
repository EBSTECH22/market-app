import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cronAuthFailure } from "@/lib/cron";
import { runRoute } from "@/lib/handler";
import { sendRentRunEmail } from "@/lib/email";
import {
  planRentRun, monthKey, rentMarker, legacyRentMarker, type RentContract,
} from "@/lib/rentrun";

export const dynamic = "force-dynamic";

/**
 * The monthly rent run. Vercel Cron, 1st of every month (see vercel.json).
 *
 * The arithmetic lives in @/lib/rentrun so the "what's coming" card on the bank
 * page can show exactly what this will post, days before it posts it. This file
 * is now only the parts that touch the world: reading contracts, deciding what
 * has already been charged, writing the entries, and telling the owner.
 *
 * Idempotent per CONTRACT, which is a change. The marker used to be
 * `[auto 2026-11]` and was looked up by vendor, so a vendor renting two booths
 * had the second booth silently skipped every month — billed for one booth
 * while using two. The marker now carries the contract id. The old
 * vendor-scoped marker is still honoured for vendors with a single contract, so
 * deploying this in a month that has already run cannot charge anybody twice.
 */
export async function GET(req: NextRequest) {
  return runRoute("cron/rent GET", async () => {
    const denied = cronAuthFailure(req);
    if (denied) return denied;

    const now = new Date();
    const ym = monthKey(now);

    const contracts = await db.contract.findMany({ where: { status: { in: ["ACTIVE", "TERMINATING"] } } });

    /* One query for the month's rent entries rather than one per contract. */
    const posted = await db.ledgerEntry.findMany({
      where: { type: "RENT", note: { contains: `[auto ${ym}` } },
      select: { vendorId: true, note: true },
    });

    const contractsPerVendor = new Map<string, number>();
    for (const c of contracts) contractsPerVendor.set(c.vendorId, (contractsPerVendor.get(c.vendorId) || 0) + 1);

    const legacy = legacyRentMarker(ym);
    const isCharged = (c: RentContract): boolean => {
      if (posted.some((p) => p.note.includes(rentMarker(ym, c.id)))) return true;
      /* A pre-existing entry from the old scheme covers this contract only when
         the vendor has exactly one — otherwise it's the OTHER booth's charge and
         skipping on it is the bug being fixed. */
      if ((contractsPerVendor.get(c.vendorId) || 1) === 1) {
        return posted.some((p) => p.vendorId === c.vendorId && p.note.includes(legacy));
      }
      return false;
    };

    const rows: RentContract[] = contracts.map((c) => ({
      id: c.id, vendorId: c.vendorId, boothLabel: c.boothLabel,
      monthlyRentCents: c.monthlyRentCents, status: c.status,
      endDate: c.endDate, paidThrough: c.paidThrough,
    }));

    const plan = planRentRun(rows, ym, now, isCharged);

    let charged = 0, ended = 0;
    for (const r of plan.rows) {
      if (r.action === "END") {
        const c = contracts.find((x) => x.id === r.contractId);
        if (c && c.status !== "ENDED") {
          await db.contract.update({ where: { id: c.id }, data: { status: "ENDED" } });
          ended++;
        }
        continue;
      }
      if (r.clearPaidThrough) {
        await db.contract.update({ where: { id: r.contractId }, data: { paidThrough: null } });
      }
      if (r.amountCents > 0) {
        await db.ledgerEntry.create({
          data: { vendorId: r.vendorId, type: "RENT", amountCents: -r.amountCents, note: r.note },
        });
        charged++;
      }
    }

    /* Tell the owner what just happened to everyone's balance. A billing run
       nobody is told about is one that gets discovered through a vendor's
       complaint. */
    if (charged > 0) {
      try {
        const vendors = await db.vendor.findMany({
          where: { id: { in: [...new Set(plan.rows.map((r) => r.vendorId))] } },
          select: { id: true, businessName: true },
        });
        const nameOf = new Map<string, string>(vendors.map((v) => [v.id, v.businessName] as [string, string]));
        await sendRentRunEmail({
          monthLabel: new Date(`${ym}-01T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
          totalCents: plan.totalCents,
          lines: plan.rows
            .filter((r) => r.amountCents > 0)
            .map((r) => ({
              vendorName: nameOf.get(r.vendorId) || "Unknown vendor",
              boothLabel: r.boothLabel,
              amountCents: r.amountCents,
              reason: r.reason,
            })),
        });
      } catch (err) {
        console.error("[cron/rent] summary email failed", err);
      }
    }

    return NextResponse.json({ ok: true, charged, ended, totalCents: plan.totalCents });
  });
}

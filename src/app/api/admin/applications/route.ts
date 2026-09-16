import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { deliveryFor, phaseFor, nextStepFor } from "@/lib/agreement";

export const dynamic = "force-dynamic";

/**
 * Every application, with where it has got to.
 *
 * This used to filter `where: { vendorId: "" }`. Both `add_vendor` and
 * `create_contract` stamp a vendorId on the application, so the moment an
 * agreement was created the applicant disappeared from this screen entirely —
 * losing exactly the people who still need chasing. Now everything comes back,
 * tagged with a `phase` so the UI can split it into sensible lists.
 */
export async function GET() {
  return runRoute("admin/applications GET", async () => {
    if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const applications = await db.vendorApplication.findMany({
      orderBy: [{ createdAt: "desc" }],
      take: 400,
    });
    if (applications.length === 0) return NextResponse.json({ applications: [] });

    // Vendors reachable either by the stamped id or, for older rows, by email.
    const vendorIds = applications.map((a) => a.vendorId).filter(Boolean);
    const emails = applications.map((a) => a.email.toLowerCase()).filter(Boolean);
    const vendors = await db.vendor.findMany({
      where: { OR: [{ id: { in: vendorIds } }, { email: { in: emails } }] },
      select: { id: true, code: true, businessName: true, email: true, phone: true, portalLocked: true, active: true },
    });
    /* Explicit generics: `new Map(arr.map(v => [a, b]))` can infer the inner
       arrays as (A|B)[] rather than a tuple, which then types the values as a
       union. Naming them keeps `.id` and friends resolvable. */
    type VendorRow = (typeof vendors)[number];
    const vById = new Map<string, VendorRow>(vendors.map((v) => [v.id, v] as [string, VendorRow]));
    const vByEmail = new Map<string, VendorRow>(
      vendors.map((v) => [v.email.toLowerCase(), v] as [string, VendorRow])
    );

    const allVendorIds = vendors.map((v) => v.id);
    const contracts = allVendorIds.length
      ? await db.contract.findMany({
          where: { vendorId: { in: allVendorIds }, status: { notIn: ["VOIDED"] } },
          orderBy: { createdAt: "desc" },
        })
      : [];
    const balances = allVendorIds.length
      ? await db.ledgerEntry.groupBy({
          by: ["vendorId"],
          where: { vendorId: { in: allVendorIds } },
          _sum: { amountCents: true },
        })
      : [];
    const balMap = Object.fromEntries(balances.map((b) => [b.vendorId, b._sum.amountCents || 0]));

    const rows = applications.map((a) => {
      const vendor = (a.vendorId ? vById.get(a.vendorId) : null) ?? vByEmail.get(a.email.toLowerCase()) ?? null;
      const contract = vendor ? contracts.find((c) => c.vendorId === vendor.id) ?? null : null;
      const delivery = contract ? deliveryFor(contract) : null;
      const balance = vendor ? balMap[vendor.id] || 0 : 0;
      const owesCents = balance < 0 ? -balance : 0;

      const phase = phaseFor({
        status: a.status,
        vendorId: vendor?.id ?? "",
        hasAgreement: !!contract,
        vendorPortalLocked: vendor ? vendor.portalLocked : null,
      });

      return {
        ...a,
        vendor: vendor ? { id: vendor.id, code: vendor.code, businessName: vendor.businessName, active: vendor.active } : null,
        agreement: contract
          ? {
              id: contract.id,
              boothLabel: contract.boothLabel,
              monthlyRentCents: contract.monthlyRentCents,
              startDate: contract.startDate,
              status: contract.status,
              vendorSignedAt: contract.vendorSignedAt,
              marketSignedAt: contract.marketSignedAt,
              viewedAt: contract.viewedAt,
              delivery,
            }
          : null,
        balanceCents: balance,
        owesCents,
        phase,
        nextStep: nextStepFor(phase, delivery, owesCents),
      };
    });

    const counts = {
      NEW: rows.filter((r) => r.phase === "NEW").length,
      IN_PROGRESS: rows.filter((r) => r.phase === "IN_PROGRESS").length,
      LIVE: rows.filter((r) => r.phase === "LIVE").length,
      DECLINED: rows.filter((r) => r.phase === "DECLINED").length,
    };

    return NextResponse.json({ applications: rows, counts });
  });
}

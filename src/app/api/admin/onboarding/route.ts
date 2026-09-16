import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { sendAgreementReminderEmail } from "@/lib/email";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

/**
 * Vendors who have been accepted but aren't live yet, with exactly what each
 * one is still waiting on.
 *
 * A vendor goes live — public page, self-checkout, portal login — only when
 * `portalLocked` clears, which `unlockIfRentPaid` does once the agreement is
 * fully signed AND their balance is settled. Until then they're invisible to
 * shoppers, so this is the list that tells the office who to chase.
 */

type Step = { key: "agreement" | "countersign" | "firstRent"; label: string; done: boolean; detail?: string };

export async function GET() {
  return runRoute("admin/onboarding GET", async () => {
    if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const vendors = await db.vendor.findMany({
      where: { portalLocked: true, active: true },
      select: {
        id: true, code: true, businessName: true, contactName: true,
        email: true, phone: true, cardLast4: true, createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    if (vendors.length === 0) return NextResponse.json({ vendors: [] });

    const ids = vendors.map((v) => v.id);
    const contracts = await db.contract.findMany({
      where: { vendorId: { in: ids }, status: { notIn: ["VOIDED", "ENDED"] } },
      orderBy: { createdAt: "desc" },
    });
    const balances = await db.ledgerEntry.groupBy({
      by: ["vendorId"],
      where: { vendorId: { in: ids } },
      _sum: { amountCents: true },
    });
    const balMap = Object.fromEntries(balances.map((b) => [b.vendorId, b._sum.amountCents || 0]));

    const rows = vendors.map((v) => {
      const c = contracts.find((x) => x.vendorId === v.id) || null;
      const balance = balMap[v.id] || 0;
      const owes = balance < 0 ? -balance : 0;

      const steps: Step[] = [
        {
          key: "agreement",
          label: "Vendor signs the agreement",
          done: !!c?.vendorSignedAt,
          detail: !c
            ? "No agreement created yet"
            : c.vendorSignedAt
              ? undefined
              : c.signToken
                ? c.viewedAt ? "Sent and opened, not signed" : "Sent, not opened yet"
                : "Created but never sent",
        },
        {
          key: "countersign",
          label: "You countersign",
          done: !!c?.marketSignedAt,
          detail: c?.vendorSignedAt && !c?.marketSignedAt ? "Waiting on you" : undefined,
        },
        {
          key: "firstRent",
          label: "First month paid",
          // Rent only posts on execution, so before that there is nothing to pay yet.
          done: !!c?.marketSignedAt && owes === 0,
          detail: !c?.marketSignedAt
            ? "Posts once the agreement is executed"
            : owes > 0
              ? `${(owes / 100).toFixed(2)} outstanding`
              : undefined,
        },
      ];

      const nextStep = steps.find((s) => !s.done) || null;
      const daysWaiting = Math.max(
        0,
        Math.round((Date.now() - new Date(c?.createdAt ?? v.createdAt).getTime()) / 86_400_000)
      );

      return {
        vendorId: v.id,
        code: v.code,
        businessName: v.businessName,
        contactName: v.contactName,
        email: v.email,
        phone: v.phone,
        cardLast4: v.cardLast4 || "",
        createdAt: v.createdAt,
        contract: c
          ? {
              id: c.id,
              boothLabel: c.boothLabel,
              monthlyRentCents: c.monthlyRentCents,
              startDate: c.startDate,
              createdAt: c.createdAt,
              sent: !!c.signToken,
              viewedAt: c.viewedAt,
              vendorSignedAt: c.vendorSignedAt,
              marketSignedAt: c.marketSignedAt,
            }
          : null,
        balanceCents: balance,
        owesCents: owes,
        steps,
        nextStep: nextStep?.key ?? null,
        nextStepLabel: nextStep?.label ?? "Ready to go live",
        daysWaiting,
        /* Nothing here is visible to shoppers — that's the point of the list. */
        publiclyVisible: false,
      };
    });

    return NextResponse.json({ vendors: rows });
  });
}

/**
 * Bulk nudge: remind every vendor sitting on an unsigned agreement.
 * Body: { action: "remind_all" } — optionally { minDaysWaiting: number }.
 */
export async function POST(req: NextRequest) {
  return runRoute("admin/onboarding POST", async () => {
    if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    if (body.action !== "remind_all") {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    const minDays = Number.isFinite(Number(body.minDaysWaiting)) ? Math.max(0, Number(body.minDaysWaiting)) : 0;

    const pending = await db.contract.findMany({
      where: { vendorSignedAt: null, status: { notIn: ["VOIDED", "ENDED"] } },
      include: { vendor: { select: { id: true, email: true, businessName: true } } },
      orderBy: { createdAt: "asc" },
    });

    /* dryRun lets the confirm dialog state a real number. This sweep covers
       every unsigned agreement — including ones belonging to vendors who are
       already live, e.g. a second booth — so it can be wider than the
       onboarding list the admin screen is showing. */
    const eligible = pending.filter(
      (c) => Math.max(0, Math.round((Date.now() - new Date(c.createdAt).getTime()) / 86_400_000)) >= minDays
    );
    if (body.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        eligibleCount: eligible.length,
        skipped: pending.length - eligible.length,
        names: eligible.slice(0, 40).map((c) => c.vendor?.businessName || "Unknown"),
        missingEmail: eligible.filter((c) => !c.vendor?.email).length,
      });
    }

    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    const sent: string[] = [];
    const failed: { businessName: string; reason: string }[] = [];
    let skipped = 0;

    for (const c of pending) {
      const days = Math.max(0, Math.round((Date.now() - new Date(c.createdAt).getTime()) / 86_400_000));
      if (days < minDays) { skipped++; continue; }
      if (!c.vendor?.email) { failed.push({ businessName: c.vendor?.businessName || "Unknown", reason: "No email on file" }); continue; }

      let token = c.signToken;
      if (!token) {
        token = randomBytes(16).toString("hex");
        await db.contract.update({ where: { id: c.id }, data: { signToken: token } });
      }
      try {
        await sendAgreementReminderEmail(
          c.vendor.email, c.vendor.businessName, `${base}/sign/${token}`,
          c.boothLabel, c.monthlyRentCents, days
        );
        sent.push(c.vendor.businessName);
      } catch {
        failed.push({ businessName: c.vendor.businessName, reason: "Email failed to send" });
      }
    }

    return NextResponse.json({ ok: true, sentCount: sent.length, sent, failed, skipped });
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";
import { sendNonPaymentNoticeEmail, noticeSigner } from "@/lib/email";
import { DEADLINE_RE, deadlineLabel, deadlinePassed, firstName } from "@/lib/nonpayment";

export const dynamic = "force-dynamic";

/**
 * Send non-payment notices.
 *
 *   { channel: "email", contractIds: [...], deadline: "2026-09-23" }
 *     Emails each vendor the written notice and records it against their
 *     agreement. This is the notice that counts under Section 13.
 *
 *   { channel: "text", contractIds: [id], deadline }
 *     Records that the text was opened on the phone. The app can't see whether
 *     it was actually sent — the phone does that — so the record says "opened",
 *     and the email is what gets relied on.
 *
 * The amount is worked out HERE, from the ledger, at the moment of sending, not
 * taken from the browser. A screen left open all afternoon would otherwise
 * tell a vendor who paid at lunch that they still owe.
 */
export async function POST(req: NextRequest) {
  return runRoute("admin/nonpayment-notice POST", async () => {
    { const denied = await denyUnless("collections"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));

    const channel = body.channel === "text" ? "text" : "email";
    const deadline = String(body.deadline || "");
    if (!DEADLINE_RE.test(deadline)) {
      return NextResponse.json({ error: "Pick a deadline date." }, { status: 400 });
    }
    if (deadlinePassed(deadline)) {
      return NextResponse.json({ error: "That deadline has already passed. Pick today or a later date." }, { status: 400 });
    }

    const ids: string[] = Array.isArray(body.contractIds)
      ? [...new Set(body.contractIds.map((v: unknown) => String(v)).filter(Boolean))].slice(0, 200) as string[]
      : [];
    if (ids.length === 0) return NextResponse.json({ error: "Nobody selected." }, { status: 400 });

    const contracts = await db.contract.findMany({
      where: { id: { in: ids }, vendorSignedAt: { not: null }, marketSignedAt: { not: null } },
      include: { vendor: { select: { id: true, businessName: true, contactName: true, email: true, phone: true } } },
    });

    /* Whole-account balance, the same figure the vendor's own invoice page
       shows — so the email and the page they click through to agree. */
    const vendorIds = [...new Set(contracts.map((c) => c.vendorId))];
    const sums = await db.ledgerEntry.groupBy({
      by: ["vendorId"],
      where: { vendorId: { in: vendorIds } },
      _sum: { amountCents: true },
    });
    const balance = new Map<string, number>(
      sums.map((s) => [s.vendorId, s._sum.amountCents || 0] as [string, number])
    );

    const signer = noticeSigner();
    const results: { contractId: string; businessName: string; ok: boolean; reason?: string }[] = [];

    for (const c of contracts) {
      const owed = Math.max(0, -(balance.get(c.vendorId) ?? 0));
      const name = c.vendor.businessName;

      if (owed === 0) {
        results.push({ contractId: c.id, businessName: name, ok: false, reason: "Already paid — nothing sent." });
        continue;
      }

      if (channel === "text") {
        await recordAudit({
          action: "NONPAYMENT_TEXT",
          targetType: "CONTRACT",
          targetId: c.id,
          targetLabel: `${name} · booth ${c.boothLabel}`,
          detail: `Non-payment text opened on the phone for ${name}, ${c.vendor.phone || "no number"} — pay by ${deadlineLabel(deadline)}.`,
          after: { deadline, amountCents: owed, phone: c.vendor.phone },
        }, req);
        results.push({ contractId: c.id, businessName: name, ok: true });
        continue;
      }

      if (!c.vendor.email || !c.signToken) {
        results.push({ contractId: c.id, businessName: name, ok: false, reason: !c.vendor.email ? "No email on file." : "No invoice link on this agreement." });
        continue;
      }

      const sent = await sendNonPaymentNoticeEmail({
        to: c.vendor.email,
        greetName: firstName(c.vendor.contactName, name),
        businessName: name,
        booth: c.boothLabel,
        amountCents: owed,
        deadline,
        token: c.signToken,
        signer,
      });

      if (!sent) {
        results.push({ contractId: c.id, businessName: name, ok: false, reason: "The email service refused it. Nothing was recorded as sent." });
        continue;
      }

      /* Recorded only once the email service has accepted it. A notice that
         failed and was logged as sent is worse than no record at all — it's
         the record someone would point to as proof of notice. */
      await recordAudit({
        action: "NONPAYMENT_NOTICE",
        targetType: "CONTRACT",
        targetId: c.id,
        targetLabel: `${name} · booth ${c.boothLabel}`,
        amountCents: 0,
        detail: `Non-payment notice emailed to ${c.vendor.email}: $${(owed / 100).toFixed(2)} due by ${deadlineLabel(deadline)}.`,
        after: { deadline, amountCents: owed, email: c.vendor.email },
      }, req);
      results.push({ contractId: c.id, businessName: name, ok: true });
    }

    for (const id of ids) {
      if (!contracts.some((c) => c.id === id)) {
        results.push({ contractId: id, businessName: "", ok: false, reason: "Agreement not found or not signed by both sides." });
      }
    }

    return NextResponse.json({
      ok: true,
      sent: results.filter((r) => r.ok).length,
      results,
    });
  });
}

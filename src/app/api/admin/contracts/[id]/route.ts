import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { sendContractSignEmail, sendSetupGuideEmail, sendRentLinkEmail, sendAgreementReminderEmail } from "@/lib/email";
import { randomBytes } from "crypto";
import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";

/**
 * Which set of terms a replacement agreement is written on.
 *
 * Carried over from the agreement being replaced unless the office is
 * deliberately changing it — a vendor who has started selling eggs is exactly
 * the sort of thing that needs a fresh signature, so this is the right place
 * to be able to switch it. Anything unrecognised keeps what was there rather
 * than silently falling back to the standard terms.
 */
function nextTermsVersion(body: unknown, current: string): string {
  const asked = String((body as { termsVersion?: unknown })?.termsVersion || "").toUpperCase();
  if (asked === "EGGS_DAIRY" || asked === "STANDARD") return asked;
  return current || "STANDARD";
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  { const denied = await denyUnless("market"); if (denied) return denied; }
  const body = await req.json();
  const { action, monthlyRentDollars, boothLabel } = body as { action?: string; monthlyRentDollars?: number; boothLabel?: string };

  const contract = await db.contract.findUnique({ where: { id: params.id } });
  if (!contract) return NextResponse.json({ error: "Contract not found." }, { status: 404 });

  if (action === "send_for_signature") {
    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    let token = contract.signToken;
    if (!token) {
      token = randomBytes(16).toString("hex");
      await db.contract.update({ where: { id: contract.id }, data: { signToken: token } });
    }
    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    try {
      await sendContractSignEmail(vendor.email, vendor.businessName, `${base}/sign/${token}`);
    } catch {
      return NextResponse.json({ error: "Email failed to send — check the vendor's email address." }, { status: 500 });
    }
    return NextResponse.json({ ok: true, sentTo: vendor.email });
  }

  if (action === "send_rent_link") {
    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    if (!contract.vendorSignedAt || !contract.marketSignedAt) return NextResponse.json({ error: "Contract must be fully signed first — rent posts on execution." }, { status: 400 });
    let token = contract.signToken;
    if (!token) {
      token = randomBytes(16).toString("hex");
      await db.contract.update({ where: { id: contract.id }, data: { signToken: token } });
    }
    const agg = await db.ledgerEntry.aggregate({ where: { vendorId: vendor.id }, _sum: { amountCents: true } });
    const balance = agg._sum.amountCents || 0;
    const dueCents = balance < 0 ? -balance : 0;
    const feeCents = Math.round((dueCents * 3) / 100);
    try {
      await sendRentLinkEmail(vendor.email, vendor.businessName, contract.boothLabel, dueCents, feeCents, token);
    } catch {
      return NextResponse.json({ error: "Email failed to send." }, { status: 500 });
    }
    return NextResponse.json({ ok: true, sentTo: vendor.email, dueCents });
  }

  if (action === "send_setup_guide") {
    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    const app = await db.vendorApplication.findFirst({ where: { email: { equals: vendor.email, mode: "insensitive" } }, orderBy: { createdAt: "desc" } });
    try {
      await sendSetupGuideEmail(vendor.email, vendor.businessName, app?.phoneType || "");
    } catch {
      return NextResponse.json({ error: "Email failed to send." }, { status: 500 });
    }
    /* Stamped so the automatic send doesn't post it a second time later. */
    await db.vendor.update({ where: { id: vendor.id }, data: { setupGuideSentAt: new Date() } }).catch(() => {});
    return NextResponse.json({ ok: true, sentTo: vendor.email });
  }

  if (action === "give_notice") {
    const nd = typeof (body as { noticeDate?: string }).noticeDate === "string" && (body as { noticeDate: string }).noticeDate
      ? new Date((body as { noticeDate: string }).noticeDate + "T12:00:00")
      : new Date();
    if (isNaN(nd.getTime())) return NextResponse.json({ error: "Bad notice date." }, { status: 400 });
    const endDate = new Date(nd.getTime() + 30 * 24 * 60 * 60 * 1000);
    const dim = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).getDate();
    const finalRentCents = Math.round((contract.monthlyRentCents * endDate.getDate()) / dim);
    const updated = await db.contract.update({
      where: { id: contract.id },
      data: { status: "TERMINATING", noticeGivenAt: nd, endDate },
    });
    return NextResponse.json({ contract: updated, finalRentCents });
  }

  if (action === "end_now") {
    const updated = await db.contract.update({
      where: { id: contract.id },
      data: { status: "ENDED", endDate: new Date() },
    });
    return NextResponse.json({ contract: updated });
  }

  /* ---- the vendor pulled out ------------------------------------------------
     Distinct from VOIDED (we reissued a corrected agreement) and from ENDED
     (a lease that ran its course). Nothing here bills again: cron/rent only
     touches ACTIVE and TERMINATING. */
  if (action === "mark_withdrawn") {
    if (contract.status === "WITHDRAWN") {
      return NextResponse.json({ error: "This one is already marked as backed out." }, { status: 400 });
    }
    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });

    const agg = await db.ledgerEntry.aggregate({
      where: { vendorId: contract.vendorId },
      _sum: { amountCents: true },
    });
    const balance = agg._sum.amountCents || 0;
    const owes = balance < 0 ? -balance : 0;

    /* Rent only posts once BOTH signatures land, so someone who backs out
       before signing owes nothing and we don't interrupt to ask. We only stop
       for a decision in the rarer case where money really is outstanding. */
    const decided = typeof (body as { writeOff?: boolean }).writeOff === "boolean";
    if (owes > 0 && !decided) {
      return NextResponse.json({
        needsDecision: true,
        owesCents: owes,
        businessName: vendor?.businessName || "",
      });
    }

    const writeOff = (body as { writeOff?: boolean }).writeOff === true;
    const reason = String((body as { reason?: string }).reason || "").trim().slice(0, 500);

    await db.$transaction(async (tx) => {
      await tx.contract.update({
        where: { id: contract.id },
        data: { status: "WITHDRAWN", endDate: new Date() },
      });

      // They never started, so the account shouldn't sit in the active lists
      // or be reachable publicly. Reinstating turns this back on.
      await tx.vendor.update({
        where: { id: contract.vendorId },
        data: { active: false, portalLocked: true },
      });

      if (owes > 0 && writeOff) {
        await tx.ledgerEntry.create({
          data: {
            vendorId: contract.vendorId,
            type: "ADJUST",
            amountCents: owes,
            note: `Written off — vendor backed out before starting, booth ${contract.boothLabel}`,
          },
        });
      }
    });

    /* No notes column on Contract and we're not adding one, so the reason goes
       on their application, which is where the rest of the history lives. If
       they never applied (added by hand) the reason isn't kept anywhere. */
    if (reason && vendor) {
      const app = await db.vendorApplication.findFirst({
        where: { email: { equals: vendor.email, mode: "insensitive" } },
        orderBy: { createdAt: "desc" },
        select: { id: true, adminNotes: true },
      });
      if (app) {
        const stamp = new Date().toLocaleDateString("en-US");
        const line = `[${stamp}] Backed out: ${reason}`;
        await db.vendorApplication.update({
          where: { id: app.id },
          data: { adminNotes: app.adminNotes ? `${app.adminNotes}\n${line}` : line },
        }).catch(() => {});
      }
    }

    return NextResponse.json({
      ok: true,
      wroteOff: owes > 0 && writeOff ? owes : 0,
      leftOwing: owes > 0 && !writeOff ? owes : 0,
    });
  }

  /* ---- they changed their mind again ---------------------------------------- */
  if (action === "reinstate") {
    if (contract.status !== "WITHDRAWN") {
      return NextResponse.json({ error: "That agreement isn't marked as backed out." }, { status: 400 });
    }
    await db.$transaction(async (tx) => {
      await tx.contract.update({
        where: { id: contract.id },
        // Back to where it was: signed agreements resume, unsigned ones wait.
        data: { status: "ACTIVE", endDate: null },
      });
      await tx.vendor.update({
        where: { id: contract.vendorId },
        data: { active: true },
      });
    });
    return NextResponse.json({ ok: true });
  }

  // ---- nudge an agreement that's been sent but not signed -------------------
  if (action === "send_reminder") {
    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    if (contract.vendorSignedAt) {
      return NextResponse.json({ error: "They've already signed — nothing to remind them about." }, { status: 400 });
    }
    let token = contract.signToken;
    if (!token) {
      token = randomBytes(16).toString("hex");
      await db.contract.update({ where: { id: contract.id }, data: { signToken: token } });
    }
    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    const days = Math.max(
      0,
      Math.round((Date.now() - new Date(contract.createdAt).getTime()) / 86_400_000)
    );
    try {
      await sendAgreementReminderEmail(
        vendor.email, vendor.businessName, `${base}/sign/${token}`,
        contract.boothLabel, contract.monthlyRentCents, days
      );
    } catch {
      return NextResponse.json({ error: "Email failed to send — check their email address." }, { status: 500 });
    }
    return NextResponse.json({ ok: true, sentTo: vendor.email });
  }

  // ---- edit the terms of an agreement nobody has signed yet -----------------
  if (action === "update_terms") {
    if (contract.vendorSignedAt) {
      return NextResponse.json(
        { error: "They've already signed this one. Void it and send a fresh agreement instead of changing signed terms." },
        { status: 400 }
      );
    }
    if (contract.status === "ENDED" || contract.status === "VOIDED") {
      return NextResponse.json({ error: "This agreement is closed — create a new one." }, { status: 400 });
    }

    const data: { boothLabel?: string; monthlyRentCents?: number; startDate?: Date } = {};

    if (typeof boothLabel === "string") {
      const b = boothLabel.trim().slice(0, 40);
      if (!b) return NextResponse.json({ error: "Booth label can't be blank." }, { status: 400 });
      data.boothLabel = b;
    }
    if (monthlyRentDollars !== undefined) {
      const rent = Math.round(Number(monthlyRentDollars) * 100);
      if (!Number.isFinite(rent) || rent < 0) return NextResponse.json({ error: "Rent has to be a number, zero or more." }, { status: 400 });
      if (rent > 100_000_00) return NextResponse.json({ error: "That rent looks wrong — check the amount." }, { status: 400 });
      data.monthlyRentCents = rent;
    }
    const sd = (body as { startDate?: string }).startDate;
    if (typeof sd === "string" && sd.trim()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sd.trim())) return NextResponse.json({ error: "Start date must be YYYY-MM-DD." }, { status: 400 });
      const d = new Date(`${sd.trim()}T12:00:00`);
      if (isNaN(d.getTime())) return NextResponse.json({ error: "That start date isn't valid." }, { status: 400 });
      data.startDate = d;
    }

    if (!Object.keys(data).length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

    const updated = await db.contract.update({ where: { id: contract.id }, data });

    const parts: string[] = [];
    if (data.boothLabel && data.boothLabel !== contract.boothLabel) parts.push(`booth ${contract.boothLabel} → ${data.boothLabel}`);
    if (data.monthlyRentCents !== undefined && data.monthlyRentCents !== contract.monthlyRentCents) {
      parts.push(`rent $${(contract.monthlyRentCents / 100).toFixed(2)} → $${(data.monthlyRentCents / 100).toFixed(2)}`);
    }
    if (data.startDate) parts.push(`start date changed`);
    if (parts.length) {
      await recordAudit(
        {
          action: "CONTRACT_EDIT",
          targetType: "CONTRACT",
          targetId: contract.id,
          targetLabel: `Booth ${contract.boothLabel}`,
          detail: `Terms changed before signing: ${parts.join(", ")}`,
          before: { boothLabel: contract.boothLabel, monthlyRentCents: contract.monthlyRentCents },
          after: { boothLabel: updated.boothLabel, monthlyRentCents: updated.monthlyRentCents },
        },
        req
      );
    }

    return NextResponse.json({ contract: updated });
  }

  // ---- they signed, terms were wrong: void it and issue a corrected one -----
  if (action === "void_and_reissue") {
    if (contract.marketSignedAt) {
      return NextResponse.json({ error: "This agreement is fully executed. Use 30-day notice to end it." }, { status: 400 });
    }
    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });

    const b = typeof boothLabel === "string" && boothLabel.trim()
      ? boothLabel.trim().slice(0, 40)
      : contract.boothLabel;
    const rent = monthlyRentDollars !== undefined
      ? Math.round(Number(monthlyRentDollars) * 100)
      : contract.monthlyRentCents;
    if (!Number.isFinite(rent) || rent < 0) return NextResponse.json({ error: "Rent has to be a number, zero or more." }, { status: 400 });

    const sd2 = (body as { startDate?: string }).startDate;
    let start = contract.startDate;
    if (typeof sd2 === "string" && sd2.trim()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sd2.trim())) return NextResponse.json({ error: "Start date must be YYYY-MM-DD." }, { status: 400 });
      const d = new Date(`${sd2.trim()}T12:00:00`);
      if (isNaN(d.getTime())) return NextResponse.json({ error: "That start date isn't valid." }, { status: 400 });
      start = d;
    }

    // The old one is kept, marked VOIDED, with its signature intact as a record
    // of what they agreed to. The replacement starts clean and unsigned.
    //
    // WHAT HAS TO COME ACROSS: the kind of space and which set of terms. These
    // were dropped, so an eggs-and-dairy vendor whose agreement was corrected
    // quietly got sent the standard one to sign instead — the eggs sections
    // simply gone, and nothing on screen to say so.
    const [, replacement] = await db.$transaction([
      db.contract.update({
        where: { id: contract.id },
        data: { status: "VOIDED", endDate: new Date() },
      }),
      db.contract.create({
        data: {
          vendorId: contract.vendorId,
          boothLabel: b,
          monthlyRentCents: rent,
          startDate: start,
          spaceKey: contract.spaceKey,
          termsVersion: nextTermsVersion(body, contract.termsVersion),
          supersedesId: contract.id,
          signToken: randomBytes(16).toString("hex"),
        },
      }),
    ]);

    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    let emailed = false;
    try {
      await sendContractSignEmail(vendor.email, vendor.businessName, `${base}/sign/${replacement.signToken}`);
      emailed = true;
    } catch { /* the replacement exists either way — surface it below */ }

    return NextResponse.json({
      contract: replacement,
      emailed,
      sentTo: vendor.email,
      signUrl: `${base}/sign/${replacement.signToken}`,
    });
  }

  /* ---- AMEND A SIGNED AGREEMENT AND SEND IT BACK FOR SIGNATURE ------------

     Terms change. A vendor moves to a bigger booth, rent is renegotiated, or
     they start selling eggs and need the sections that cover them. Until now
     the only route for a fully executed agreement was thirty days' notice and
     a brand new one, which is a sledgehammer for "the rent is going up $25".

     A SIGNED AGREEMENT IS NEVER REWRITTEN. The signature is evidence of what
     was on the screen when they put their name to it, so changing the words
     underneath it would quietly destroy the only record of what was actually
     agreed. Instead the old row is left exactly as it stands — both
     signatures, both dates — and marked SUPERSEDED, and the new terms go out
     as a fresh agreement that points back at it. Nobody loses the history and
     nothing is in force until they sign.

     paidThrough comes across. Amending the rent must not re-bill a month they
     have already paid for; that figure is about money received, not about
     which document was in force when it arrived. */
  if (action === "amend_and_resend") {
    if (!contract.vendorSignedAt) {
      return NextResponse.json(
        { error: "Nobody has signed this one yet — just edit the terms instead." },
        { status: 400 }
      );
    }
    if (["ENDED", "WITHDRAWN", "VOIDED", "SUPERSEDED"].includes(contract.status)) {
      return NextResponse.json(
        { error: "This agreement is closed, so there is nothing to amend. Write a new one." },
        { status: 400 }
      );
    }

    const vendor = await db.vendor.findUnique({ where: { id: contract.vendorId } });
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    if (!vendor.email?.trim()) {
      return NextResponse.json({ error: "This vendor has no email address on file to send it to." }, { status: 400 });
    }

    const b = typeof boothLabel === "string" && boothLabel.trim()
      ? boothLabel.trim().slice(0, 40)
      : contract.boothLabel;

    const rent = monthlyRentDollars !== undefined
      ? Math.round(Number(monthlyRentDollars) * 100)
      : contract.monthlyRentCents;
    if (!Number.isFinite(rent) || rent < 0) {
      return NextResponse.json({ error: "Rent has to be a number, zero or more." }, { status: 400 });
    }
    if (rent > 100_000_00) {
      return NextResponse.json({ error: "That rent looks wrong — check the amount." }, { status: 400 });
    }

    const sdA = (body as { startDate?: string }).startDate;
    let start = contract.startDate;
    if (typeof sdA === "string" && sdA.trim()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sdA.trim())) {
        return NextResponse.json({ error: "Start date must be YYYY-MM-DD." }, { status: 400 });
      }
      const d = new Date(`${sdA.trim()}T12:00:00`);
      if (isNaN(d.getTime())) return NextResponse.json({ error: "That start date isn't valid." }, { status: 400 });
      start = d;
    }

    const terms = nextTermsVersion(body, contract.termsVersion);

    /* Something has to actually be different, or this is a re-signature
       request dressed up as an amendment — and the vendor gets an email
       asking them to sign a document identical to the one they signed. */
    const changes: string[] = [];
    if (b !== contract.boothLabel) changes.push(`booth ${contract.boothLabel} → ${b}`);
    if (rent !== contract.monthlyRentCents) {
      changes.push(`rent $${(contract.monthlyRentCents / 100).toFixed(2)} → $${(rent / 100).toFixed(2)}`);
    }
    if (start.getTime() !== contract.startDate.getTime()) changes.push("start date changed");
    if (terms !== contract.termsVersion) changes.push(`terms ${contract.termsVersion} → ${terms}`);
    if (changes.length === 0) {
      return NextResponse.json(
        { error: "Nothing is different, so there's nothing for them to re-sign." },
        { status: 400 }
      );
    }

    const [, replacement] = await db.$transaction([
      db.contract.update({
        where: { id: contract.id },
        data: { status: "SUPERSEDED", endDate: new Date() },
      }),
      db.contract.create({
        data: {
          vendorId: contract.vendorId,
          boothLabel: b,
          monthlyRentCents: rent,
          startDate: start,
          spaceKey: contract.spaceKey,
          termsVersion: terms,
          supersedesId: contract.id,
          paidThrough: contract.paidThrough,
          signToken: randomBytes(16).toString("hex"),
        },
      }),
    ]);

    await recordAudit(
      {
        action: "CONTRACT_EDIT",
        targetType: "CONTRACT",
        targetId: replacement.id,
        targetLabel: `Booth ${b} · ${vendor.businessName}`,
        detail: `Amended after signing and sent back for signature: ${changes.join(", ")}`,
        before: {
          id: contract.id,
          boothLabel: contract.boothLabel,
          monthlyRentCents: contract.monthlyRentCents,
          termsVersion: contract.termsVersion,
          vendorSignedAt: contract.vendorSignedAt,
        },
        after: { id: replacement.id, boothLabel: b, monthlyRentCents: rent, termsVersion: terms },
      },
      req
    );

    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    const signUrl = `${base}/sign/${replacement.signToken}`;
    let emailed = false;
    let emailError = "";
    try {
      await sendContractSignEmail(vendor.email, vendor.businessName, signUrl);
      emailed = true;
    } catch (err) {
      /* The amendment exists either way. Say so plainly and hand back the
         link, rather than losing the work to a mail failure. */
      emailError = err instanceof Error ? err.message : "The email didn't go.";
    }

    return NextResponse.json({
      contract: replacement,
      supersededId: contract.id,
      changes,
      emailed,
      emailError,
      sentTo: vendor.email,
      signUrl,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

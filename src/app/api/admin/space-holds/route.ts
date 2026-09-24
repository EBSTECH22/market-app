import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit, currentAuditActor } from "@/lib/audit";
import { activeHolds, releaseHold, takeOne, expireHolds } from "@/lib/spaceholds";
import { sendSpaceHeldEmail, noticeSigner } from "@/lib/email";
import { firstName } from "@/lib/nonpayment";

export const dynamic = "force-dynamic";

/** GET — every space promised to somebody and not yet settled. */
export async function GET() {
  return runRoute("admin/space-holds GET", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    return NextResponse.json({ holds: await activeHolds() });
  });
}

/**
 * POST { spaceKey, heldFor, email?, phone?, holdUntil?, note?, applicationId? }
 *
 * Promising somebody a space takes it off the apply page straight away — a
 * held space that still shows as available is how two people get told yes.
 */
export async function POST(req: NextRequest) {
  return runRoute("admin/space-holds POST", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    await expireHolds();
    const body = await req.json().catch(() => ({}));

    const spaceKey = String(body.spaceKey || "").trim().toUpperCase();
    const heldFor = String(body.heldFor || "").trim().slice(0, 120);
    if (!spaceKey || !heldFor) {
      return NextResponse.json({ error: "Say which space, and who it's for." }, { status: 400 });
    }
    const offer = await db.spaceOffer.findUnique({ where: { key: spaceKey } });
    if (!offer) return NextResponse.json({ error: "That kind of space isn't set up." }, { status: 404 });
    if (offer.available === 0) {
      return NextResponse.json(
        { error: `There are no ${offer.name.toLowerCase()} spaces left to hold. Free one up first, or add to the count.` },
        { status: 409 }
      );
    }

    /* A date, or nothing at all. "Until I say otherwise" is a real answer, and
       forcing a made-up date would put a promise in the app nobody made. */
    const rawUntil = String(body.holdUntil || "").trim();
    let holdUntil: Date | null = null;
    if (rawUntil) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rawUntil)) {
        return NextResponse.json({ error: "Use a date like 2026-10-03, or leave it empty." }, { status: 400 });
      }
      /* End of that day, Central — a hold "until Friday" includes Friday. */
      holdUntil = new Date(`${rawUntil}T23:59:59-05:00`);
      if (holdUntil.getTime() < Date.now()) {
        return NextResponse.json({ error: "That date has already passed." }, { status: 400 });
      }
    }

    const actor = await currentAuditActor();
    const hold = await db.spaceHold.create({
      data: {
        spaceKey,
        heldFor,
        email: String(body.email || "").trim().toLowerCase().slice(0, 120),
        phone: String(body.phone || "").trim().slice(0, 25),
        applicationId: String(body.applicationId || "").trim().slice(0, 40),
        note: String(body.note || "").trim().slice(0, 300),
        holdUntil,
        createdBy: actor.actorName || "",
      },
    });
    const left = await takeOne(spaceKey);

    let emailed = false;
    if (hold.email) {
      emailed = await sendSpaceHeldEmail({
        to: hold.email,
        greetName: firstName(heldFor, heldFor),
        spaceName: offer.name,
        holdUntil,
        signer: noticeSigner(),
      });
    }

    await recordAudit(
      {
        action: "SETTING_CHANGE",
        targetType: "SPACE_HOLD",
        targetId: hold.id,
        targetLabel: heldFor,
        detail:
          `${offer.name} held for ${heldFor}` +
          `${holdUntil ? ` until ${holdUntil.toLocaleDateString("en-US", { timeZone: "America/Chicago" })}` : " with no end date"}` +
          `${typeof left === "number" ? ` — ${left} left on the apply page` : ""}` +
          `${emailed ? ", confirmation emailed" : ""}.`,
        after: { spaceKey, heldFor, holdUntil, left },
      },
      req
    );

    return NextResponse.json({ ok: true, hold, left, emailed, offerName: offer.name });
  });
}

/** DELETE ?id=&why=  — the hold ends. "Taken up" keeps the space off the count. */
export async function DELETE(req: NextRequest) {
  return runRoute("admin/space-holds DELETE", async () => {
    { const denied = await denyUnless("market"); if (denied) return denied; }
    const id = req.nextUrl.searchParams.get("id") || "";
    const why = req.nextUrl.searchParams.get("why") || "Let go";
    const hold = await db.spaceHold.findUnique({ where: { id } });
    if (!hold) return NextResponse.json({ error: "That hold is gone." }, { status: 404 });

    const ok = await releaseHold(id, why);
    if (!ok) return NextResponse.json({ error: "That hold has already ended." }, { status: 400 });

    await recordAudit(
      {
        action: "SETTING_CHANGE",
        targetType: "SPACE_HOLD",
        targetId: id,
        targetLabel: hold.heldFor,
        detail: `Hold for ${hold.heldFor} ended: ${why}.`,
        after: { why },
      },
      req
    );
    return NextResponse.json({ ok: true });
  });
}

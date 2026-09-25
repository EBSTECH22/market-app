import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { drawerForRequest } from "@/lib/drawer";
import { priceTicket, packTicket, TicketError } from "@/lib/ticket";
import { findOrCreateCustomer, REDEEM_POINTS, REDEEM_CENTS } from "@/lib/customers";
import { getTerminalReaderId } from "@/lib/settings";
import {
  createCardPresentIntent,
  sendToReader,
  readerState,
  intentState,
  cancelReader,
  cancelIntent,
  TerminalError,
} from "@/lib/terminal";

export const dynamic = "force-dynamic";

/**
 * Take a card on the reader.
 *
 * THE ORDER MATTERS AND IT IS THIS: price the ticket, keep the priced ticket,
 * take the money, then book the sale. Booking first and charging after would
 * put a ticket in the books for a card that declined; pricing again at booking
 * time would let the receipt and the card slip disagree. So the priced ticket
 * is written down here, and api/admin/sale builds the sale from it.
 *
 * Nothing about the card comes back through this app. Stripe talks to the
 * reader directly; the till only ever learns "yes", "no", or "still waiting".
 */

/** Put an existing payment back on the reader. Returns a problem to show, or "". */
async function putOnReader(readerId: string, paymentIntentId: string): Promise<string> {
  try {
    await sendToReader(readerId, paymentIntentId);
    return "";
  } catch (err) {
    /* Already showing a payment — this one, since the till only ever has one
       out. Nothing to do. */
    if (String((err as { code?: string })?.code || "") === "terminal_reader_busy") return "";
    const msg = String((err as { message?: string })?.message || "");
    return /offline|not.*online|unreachable/i.test(msg)
      ? "The card reader isn't answering. Check it's on and on the market's wifi."
      : msg || "Couldn't put that on the reader.";
  }
}

/** POST { lines, idemKey } — put it on the reader's screen. */
export async function POST(req: NextRequest) {
  return runRoute("admin/terminal/charge POST", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const lines = Array.isArray(body.lines) ? body.lines : [];
    const idemKey = String(body.idemKey || "").trim().slice(0, 64);

    const readerId = await getTerminalReaderId();
    if (!readerId) {
      return NextResponse.json(
        { error: "No card reader is set up yet. Pair one in Settings, or take the card on the standalone terminal and book it by hand." },
        { status: 400 }
      );
    }

    /* Same rule as ringing a sale: your own drawer has to be open. Checked
       BEFORE the money, because a card taken against nobody's drawer is a
       payment that reconciles to nothing. */
    const { drawer, who, ambiguous } = await drawerForRequest();
    if (!drawer) {
      return NextResponse.json(
        { error: ambiguous ? "More than one drawer is open. Sign in as yourself first." : "Open your drawer before taking cards." },
        { status: 400 }
      );
    }

    /* Already asked for, and the till is asking again — a tablet that lost its
       answer, or "Try the card again" after a decline. Same ticket, same
       payment: hand back the charge that exists.

       A declined (FAILED) or never-delivered (PENDING) payment is put back on
       the reader. Before, a retry after a decline asked Stripe for the same
       payment again, Stripe handed back the one that already existed, and
       saving it a second time crashed — the retry button could never work.
       And a payment whose first trip to the reader failed stayed PENDING with
       nothing on the reader's screen. */
    if (idemKey) {
      const already = await db.terminalCharge.findFirst({
        where: { snapshot: { contains: `"idemKey":"${idemKey}"` }, status: { in: ["PENDING", "SUCCEEDED", "FAILED"] } },
        orderBy: { createdAt: "desc" },
      });
      if (already) {
        let live = already.status === "SUCCEEDED";
        if (!live) {
          const pi = await intentState(already.paymentIntentId).catch(() => null);
          if (pi?.status === "succeeded") {
            await db.terminalCharge.update({ where: { id: already.id }, data: { status: "SUCCEEDED" } });
            live = true;
          } else if (pi && pi.status !== "canceled") {
            const problem = await putOnReader(already.readerId || readerId, already.paymentIntentId);
            if (problem) return NextResponse.json({ error: problem }, { status: 400 });
            if (already.status !== "PENDING") {
              await db.terminalCharge.update({ where: { id: already.id }, data: { status: "PENDING", failureMessage: "" } });
            }
            live = true;
          } else if (pi) {
            /* Cancelled at Stripe — that payment can't be used again. Start a
               fresh one below. */
            await db.terminalCharge.update({ where: { id: already.id }, data: { status: "CANCELED" } });
          } else {
            /* Couldn't reach Stripe to check. Hand back what exists; the
               till's polling sorts out where it stands. */
            live = true;
          }
        }
        if (live) {
          return NextResponse.json({
            ok: true,
            resumed: true,
            paymentIntentId: already.paymentIntentId,
            amountCents: already.amountCents,
          });
        }
      }
    }

    /* A reward has to come off BEFORE the card is charged, not after. Taking
       the full amount and discounting the ticket afterwards would charge the
       customer for a reward they just spent. The points themselves are still
       decremented when the sale is booked, inside the same transaction as
       everything else. */
    let discountCents = 0;
    if (body.redeem) {
      const customer = body.customerContact ? await findOrCreateCustomer(String(body.customerContact)) : null;
      if (!customer) {
        return NextResponse.json({ error: "Enter the customer's email or phone to redeem." }, { status: 400 });
      }
      if (customer.points < REDEEM_POINTS) {
        return NextResponse.json(
          { error: `Only ${customer.points} points — ${REDEEM_POINTS} needed for $5 off.` },
          { status: 400 }
        );
      }
      discountCents = REDEEM_CENTS;
    }

    let priced;
    try {
      priced = await priceTicket(lines, { card: true, discountCents });
    } catch (err) {
      if (err instanceof TicketError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }

    /* Stock, checked before the money and not after. This is not the claim —
       that happens inside the sale's transaction, where it belongs — it is the
       cheap look that catches "the last one sold at the other till" while
       refusing still costs nothing. Once the card is charged, a short count is
       something to fix in the morning rather than a reason to refuse a ticket. */
    const wanted = new Map<string, number>();
    for (const l of priced.lines) wanted.set(l.itemId, (wanted.get(l.itemId) || 0) + l.quantity);
    const onHand = await db.item.findMany({
      where: { id: { in: [...wanted.keys()] } },
      select: { id: true, name: true, quantity: true },
    });
    for (const row of onHand) {
      const need = wanted.get(row.id) || 0;
      if (row.quantity < need) {
        return NextResponse.json(
          {
            error:
              row.quantity <= 0
                ? `${row.name} is sold out — take it off the ticket.`
                : `Only ${row.quantity} of ${row.name} left (ticket has ${need}).`,
          },
          { status: 400 }
        );
      }
    }

    try {
      /* Stripe remembers an idempotency key for a day and hands back the
         original payment for it. If an earlier payment on this ticket was
         cancelled, a fresh one needs a fresh key or Stripe returns the dead one. */
      const earlier = idemKey
        ? await db.terminalCharge.count({ where: { snapshot: { contains: `"idemKey":"${idemKey}"` } } })
        : 0;
      const pi = await createCardPresentIntent(priced.totalCents, earlier ? `${idemKey}_${earlier}` : idemKey, {
        source: "register",
        employee: who?.name || drawer.employee || "",
        drawerId: drawer.id,
      });

      await db.terminalCharge.create({
        data: {
          paymentIntentId: pi.id,
          readerId,
          amountCents: priced.totalCents,
          /* The idempotency key rides inside the snapshot rather than in a
             column of its own: it is only ever needed to answer "have I asked
             for this already", and a column would mean a migration for a
             lookup that happens once a day. */
          snapshot: packTicket({ ...priced, ...({ idemKey } as object) } as typeof priced),
          employee: who?.name || drawer.employee || "",
          drawerId: drawer.id,
        },
      });

      await sendToReader(readerId, pi.id);

      return NextResponse.json({
        ok: true,
        paymentIntentId: pi.id,
        amountCents: priced.totalCents,
        subtotalCents: priced.subtotalCents,
        cardAdjustCents: priced.cardAdjustCents,
        taxCents: priced.taxCents,
      });
    } catch (err) {
      if (err instanceof TerminalError) return NextResponse.json({ error: err.message }, { status: 400 });
      const msg = String((err as { message?: string })?.message || "");
      /* An offline reader is the common one, and it is a plug, not a bug. */
      if (/offline|not.*online|unreachable/i.test(msg)) {
        return NextResponse.json(
          { error: "The card reader isn't answering. Check it's on and on the market's wifi." },
          { status: 400 }
        );
      }
      return NextResponse.json({ error: msg || "Stripe wouldn't start that payment." }, { status: 400 });
    }
  });
}

/** GET ?pi= — has it gone through yet? */
export async function GET(req: NextRequest) {
  return runRoute("admin/terminal/charge GET", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    /* ?unbooked=1 — cards that were charged but never got a ticket.
       The tablet was closed, the wifi dropped, or the page was refreshed
       between "Approved" and the ticket saving. The money is taken either way,
       and nothing used to bring it back to anybody's attention. The till asks
       for these and offers a one-tap "Save the ticket". */
    if (req.nextUrl.searchParams.get("unbooked") === "1") {
      const rows = await db.terminalCharge.findMany({
        where: {
          status: { in: ["SUCCEEDED", "PENDING"] },
          saleId: "",
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        orderBy: { createdAt: "asc" },
        take: 10,
      });
      const out: { paymentIntentId: string; amountCents: number; employee: string; createdAt: Date; cardLabel: string }[] = [];
      for (const r of rows) {
        const age = Date.now() - r.createdAt.getTime();
        /* Still on the reader, most likely — the till that sent it owns it. */
        if (r.status === "PENDING" && age < 3 * 60 * 1000) continue;
        const pi = await intentState(r.paymentIntentId).catch(() => null);
        if (!pi) continue;
        if (pi.status === "succeeded") {
          if (r.status !== "SUCCEEDED") {
            await db.terminalCharge.update({ where: { id: r.id }, data: { status: "SUCCEEDED" } });
          }
          out.push({ paymentIntentId: r.paymentIntentId, amountCents: r.amountCents, employee: r.employee, createdAt: r.createdAt, cardLabel: pi.cardLabel });
        } else if (pi.status === "canceled") {
          await db.terminalCharge.update({ where: { id: r.id }, data: { status: "CANCELED" } });
        } else if (age > 10 * 60 * 1000) {
          /* Sent, never paid, and long abandoned. Cancel it so it can't be
             paid by surprise later and stops being checked. */
          await cancelIntent(r.paymentIntentId);
          await db.terminalCharge.update({ where: { id: r.id }, data: { status: "CANCELED" } });
        }
      }
      return NextResponse.json({ unbooked: out });
    }

    const piId = req.nextUrl.searchParams.get("pi") || "";
    if (!piId) return NextResponse.json({ error: "Which payment?" }, { status: 400 });

    const row = await db.terminalCharge.findUnique({ where: { paymentIntentId: piId } });
    if (!row) return NextResponse.json({ error: "That payment isn't one of ours." }, { status: 404 });

    /* Already booked. Answering from the row rather than asking Stripe again
       keeps a till that is still polling from being told "succeeded" a second
       time and ringing the sale twice. */
    if (row.status === "BOOKED") {
      return NextResponse.json({ state: "booked", saleId: row.saleId, amountCents: row.amountCents });
    }

    try {
      const pi = await intentState(piId);
      const reader = row.readerId ? await readerState(row.readerId).catch(() => null) : null;

      if (pi.status === "succeeded") {
        if (row.status !== "SUCCEEDED") {
          await db.terminalCharge.update({ where: { id: row.id }, data: { status: "SUCCEEDED" } });
        }
        return NextResponse.json({
          state: "succeeded",
          amountCents: pi.amount,
          cardLabel: pi.cardLabel,
          paymentIntentId: piId,
        });
      }

      if (pi.status === "canceled") {
        if (row.status !== "CANCELED") {
          await db.terminalCharge.update({ where: { id: row.id }, data: { status: "CANCELED" } });
        }
        return NextResponse.json({ state: "canceled", message: "The payment was cancelled." });
      }

      /* The reader finished and it didn't work: a decline, a card pulled out
         early, a customer who pressed cancel. The payment intent is still
         alive and could be presented again, but the cashier needs telling
         now. */
      if (reader && reader.actionStatus === "failed") {
        const message = reader.actionFailure || pi.failure || "The card was declined.";
        await db.terminalCharge.update({
          where: { id: row.id },
          data: { status: "FAILED", failureMessage: message.slice(0, 300) },
        });
        return NextResponse.json({ state: "failed", message });
      }

      return NextResponse.json({
        state: "waiting",
        readerStatus: reader?.status || "",
        message: reader?.actionStatus === "in_progress" ? "Waiting for the customer to tap or insert." : "Sending it to the reader…",
      });
    } catch (err) {
      if (err instanceof TerminalError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
  });
}

/** DELETE ?pi= — the cashier pressed cancel. */
export async function DELETE(req: NextRequest) {
  return runRoute("admin/terminal/charge DELETE", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const piId = req.nextUrl.searchParams.get("pi") || "";
    const row = await db.terminalCharge.findUnique({ where: { paymentIntentId: piId } });
    if (!row) return NextResponse.json({ error: "That payment isn't one of ours." }, { status: 404 });

    /* Never cancel a payment that went through — that is a refund, and a
       refund is a different button with a different conversation attached. */
    if (row.status === "BOOKED") {
      return NextResponse.json({ error: "That payment already went through — refund it instead." }, { status: 400 });
    }
    /* Paid but not booked yet: the till must save the ticket, not cancel. */
    if (row.status === "SUCCEEDED") {
      const pi = await intentState(piId).catch(() => null);
      return NextResponse.json(
        { error: "That card already went through. Save the ticket.", state: "succeeded", paymentIntentId: piId, cardLabel: pi?.cardLabel || "" },
        { status: 409 }
      );
    }

    if (row.readerId) await cancelReader(row.readerId);
    await cancelIntent(piId);

    /* THE CUSTOMER MAY HAVE TAPPED AT THE SAME MOMENT. Cancelling a payment
       that is already approved silently does nothing, and this used to mark
       it cancelled anyway — the card was charged, the till cleared, and no
       ticket was ever written. So Stripe is asked where it actually ended up. */
    const after = await intentState(piId).catch(() => null);
    if (after?.status === "succeeded") {
      await db.terminalCharge.update({ where: { id: row.id }, data: { status: "SUCCEEDED" } });
      return NextResponse.json(
        {
          error: "The card went through before the cancel reached the reader. Save the ticket.",
          state: "succeeded",
          paymentIntentId: piId,
          cardLabel: after.cardLabel,
        },
        { status: 409 }
      );
    }
    await db.terminalCharge.update({ where: { id: row.id }, data: { status: "CANCELED" } });
    return NextResponse.json({ ok: true });
  });
}

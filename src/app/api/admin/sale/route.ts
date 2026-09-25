import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { findOrCreateCustomer, pointsFor, REDEEM_POINTS, REDEEM_CENTS } from "@/lib/customers";
import { sendCustomerReceiptEmail } from "@/lib/email";
import { getTaxRates, getCardAdjustPercent, getAutoPrint, getReceiptHeader, getReceiptFooter } from "@/lib/settings";
import { unpackTicket } from "@/lib/ticket";
import { enqueue } from "@/lib/printqueue";
import { receiptXml, receiptWithDrawerXml } from "@/lib/epos";
import { taxFor, normalizeTaxClass } from "@/lib/tax";
import { effectivePriceCents } from "@/lib/pricing";
import { runRoute, HttpError } from "@/lib/handler";

import { pushToVendor } from "@/lib/push";
import { denyUnless } from "@/lib/perm";
import { drawerForRequest } from "@/lib/drawer";

export async function POST(req: NextRequest) {
  return runRoute("admin/sale POST", async () => {
  { const denied = await denyUnless("ops"); if (denied) return denied; }

  const { lines, paymentMethod, cardName, customerContact, redeem, cashTenderedCents, idemKey: rawIdemKey, offline: rawOffline, soldAtIso, employeeName, terminalPaymentIntentId } = (await req.json()) as {
    lines: { itemId: string; quantity: number; priceCents?: number }[];
    paymentMethod: string;
    cardName?: string;
    /** Set when the card was taken on the reader — see the block below. */
    terminalPaymentIntentId?: string;
    customerContact?: string;
    redeem?: boolean;
    /** What the customer physically handed over. Cash sales only. */
    cashTenderedCents?: number;
    /** Idempotency key minted by the till before sending — see below. */
    idemKey?: string;
    /** True only for a sale that was rung with no connection and is being posted late. */
    offline?: boolean;
    soldAtIso?: string;
    employeeName?: string;
  };

  /* ------------------------------------------- idempotency and offline --
     TWO SEPARATE THINGS, deliberately:

     `idemKey` is on EVERY sale the till sends, online or not. It makes sending
     the same sale twice harmless. That matters most in the case that looks like
     a failure and isn't: the request reaches the server, the sale commits, and
     the response is lost on the way back. The till sees an error, queues the
     sale, and posts it again later — with the same key, so it lands on the
     ticket that already exists instead of ringing a second one.

     `offline` says the sale was rung with no connection and is being recorded
     after the fact. It relaxes three rules below, and it relaxes them because
     the sale HAS ALREADY HAPPENED: the customer paid and left with the goods.
     This endpoint is writing history at that point, not deciding whether to
     allow a sale. */
  const idemKey = typeof rawIdemKey === "string" ? rawIdemKey.trim().slice(0, 64) : "";
  const offline = rawOffline === true;
  if (idemKey) {
    const already = await db.sale.findFirst({ where: { idemKey }, select: { id: true, number: true, employee: true, totalCents: true, createdAt: true } });
    if (already) {
      return NextResponse.json({ sale: already, duplicate: true });
    }
  }

  /* WHICH drawer, and WHO rang it. Both used to be "the" open drawer for the
     whole market — so every sale was filed under whoever opened up first, and
     two cashiers could never work at once. Now: the person signed in rings on
     their OWN drawer, and the sale carries that drawer's id, which is what makes
     each till's count its own.

     An offline sale keeps the name it was rung under, because by the time it
     syncs someone else may be signed in. It lands on that person's drawer if
     it's still open, and on no drawer if it has since been counted out — adding
     it to a closed till would change a count that's already been signed off. */
  const { drawer: myDrawer, who: signedIn, ambiguous } = await drawerForRequest();
  const offlineName = offline ? String(employeeName || "").trim().slice(0, 60) : "";

  let drawer = myDrawer;
  if (offline && offlineName) {
    drawer = await db.drawerSession.findFirst({
      where: { status: "OPEN", employee: offlineName },
      orderBy: { openedAt: "desc" },
    });
  }

  if (!drawer && !offline) {
    return NextResponse.json(
      {
        error: ambiguous
          ? "More than one drawer is open. Sign in as yourself to ring sales."
          : "Open your drawer before ringing sales.",
      },
      { status: 400 }
    );
  }
  const clerk =
    offlineName ||
    signedIn?.name ||
    drawer?.employee ||
    String(employeeName || "").trim().slice(0, 60) ||
    "Offline sale";
  if (!["CASH", "CARD"].includes(paymentMethod)) return NextResponse.json({ error: "Pick a payment method." }, { status: 400 });

  /* ------------------------------------------------- paid on the reader --
     The card was already taken. The money is gone from the customer's account
     and the reader has printed nothing — this request is what turns that
     payment into a ticket.

     Two things are true here that aren't true of any other sale. First, the
     prices are NOT worked out again: they were worked out when the reader was
     told what to charge, and re-pricing now could book a ticket for a figure
     different from the one on the card slip. They come out of the snapshot
     instead. Second, this must never run twice for the same payment — the
     BOOKED stamp below is what makes a double-tap harmless. */
  const terminalPi = String(terminalPaymentIntentId || "").trim();
  const charge = terminalPi
    ? await db.terminalCharge.findUnique({ where: { paymentIntentId: terminalPi } })
    : null;

  if (terminalPi) {
    if (!charge) return NextResponse.json({ error: "That card payment isn't one of ours." }, { status: 400 });
    if (charge.saleId) {
      const won = await db.sale.findUnique({
        where: { id: charge.saleId },
        select: { id: true, number: true, employee: true, totalCents: true, createdAt: true },
      });
      if (won) return NextResponse.json({ sale: won, duplicate: true });
    }
    if (charge.status !== "SUCCEEDED") {
      return NextResponse.json({ error: "That card payment hasn't gone through — don't book it yet." }, { status: 400 });
    }
  }

  const snap = charge ? unpackTicket(charge.snapshot) : null;
  if (terminalPi && !snap) {
    return NextResponse.json({ error: "The card went through but the ticket behind it is unreadable. Ring it by hand and refund one of them." }, { status: 500 });
  }

  /* What is actually being sold: the snapshot when there is one, because that
     is what was charged for, and whatever the till sent otherwise. */
  const effLines = snap ? snap.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })) : lines;
  if (!Array.isArray(effLines) || !effLines.length) return NextResponse.json({ error: "Nothing on the ticket." }, { status: 400 });

  const items = await db.item.findMany({
    where: { id: { in: effLines.map((l) => l.itemId) } },
    include: { vendor: true },
  });

  const rates = await getTaxRates();
  let subtotal = 0;
  const saleLines: {
    itemId: string; vendorId: string; name: string; basePriceCents: number; priceCents: number; quantity: number;
    commissionCents: number; vendorNetCents: number; taxClass: string;
  }[] = [];

  let saleSavingsCents = 0;
  for (const l of snap ? [] : lines) {
    const item = items.find((i) => i.id === l.itemId);
    if (!item) return NextResponse.json({ error: "An item on the ticket no longer exists." }, { status: 400 });
    const q = Math.max(1, Math.round(l.quantity));

    /* Normally the server prices the ticket — the till can't be trusted to send
       its own prices, and today's price is the right one.

       An offline sale is the exception, and has to be: the customer paid the
       price that was on the shelf when they bought it, possibly days before
       this reaches the server. Re-pricing it at sync time would book a ticket
       for an amount nobody ever handed over, and the drawer would never
       reconcile. The sent price is used, sanity-bounded — a garbled figure gets
       today's price rather than being taken on faith. */
    const sentPrice = Math.round(Number(l.priceCents));
    const useSent =
      offline && Number.isFinite(sentPrice) && sentPrice >= 0 && sentPrice <= Math.max(100_00, item.priceCents * 3);
    const unit = useSent ? sentPrice : effectivePriceCents(item);

    // Never negative: an item whose price DROPPED after an offline sale would
    // otherwise book as "savings" of minus something.
    saleSavingsCents += Math.max(0, item.priceCents - unit) * q;
    const gross = unit * q;
    const commission = Math.round((gross * item.vendor.commissionPercent) / 100);
    subtotal += gross;
    saleLines.push({
      itemId: item.id,
      vendorId: item.vendorId,
      name: item.name,
      basePriceCents: item.priceCents,
      priceCents: unit,
      quantity: q,
      commissionCents: commission,
      vendorNetCents: gross - commission,
      // Snapshotted here, not looked up at report time: reclassifying an item
      // next month must not change the tax on a ticket already filed.
      taxClass: normalizeTaxClass(item.taxClass),
    });
  }

  /* The snapshot is the ticket, already priced, already taxed, already paid
     for. Copying it across rather than recomputing is the whole point of it. */
  if (snap) {
    saleLines.push(...snap.lines);
    subtotal = snap.subtotalCents;
    saleSavingsCents = snap.saleSavingsCents;
  }

  // dual pricing: posted prices are card prices; cash skips the non-cash adjustment
  const adjustPercent = await getCardAdjustPercent();
  const cardAdjustCents = snap
    ? snap.cardAdjustCents
    : paymentMethod === "CARD" && adjustPercent > 0
      ? Math.round((subtotal * adjustPercent) / 100)
      : 0;

  /* Food and standard are taxed at different rates, so the card adjustment has
     to be spread across both rather than dumped on one — see lib/tax.ts. */
  const taxSplit = snap
    ? { taxCents: snap.taxCents, foodTaxCents: snap.foodTaxCents, standardTaxCents: snap.standardTaxCents }
    : taxFor(
        saleLines.map((sl) => ({ amountCents: sl.priceCents * sl.quantity, taxClass: normalizeTaxClass(sl.taxClass) })),
        rates,
        cardAdjustCents
      );
  const taxCents = taxSplit.taxCents;

  // rewards: find the customer up front so redemption can discount this sale.
  // This is only a friendly pre-check — the authoritative balance check and the
  // decrement both happen inside the transaction below.
  const customer = customerContact ? await findOrCreateCustomer(customerContact) : null;
  let discountCents = 0;
  if (snap) {
    /* Already decided, already charged. Checking the points again here could
       only produce a ticket that disagrees with the card slip. */
    discountCents = snap.discountCents;
  } else if (redeem) {
    if (!customer) return NextResponse.json({ error: "Enter the customer's email or phone to redeem." }, { status: 400 });
    if (customer.points < REDEEM_POINTS) return NextResponse.json({ error: `Only ${customer.points} points — ${REDEEM_POINTS} needed for $5 off.` }, { status: 400 });
    discountCents = Math.min(REDEEM_CENTS, subtotal + taxCents);
  }
  const totalCents = snap ? snap.totalCents : subtotal + cardAdjustCents + taxCents - discountCents;

  /* Cash tendered, if the register sent it.
     Zero means "not recorded" rather than "they paid nothing" — sales booked
     before this field existed, and the one-tap exact-change path, both land
     there legitimately. But a POSITIVE amount that doesn't cover the sale is a
     real mistake, and booking it would leave a drawer that can never balance,
     so that one is refused rather than clamped. */
  const tenderedRaw = Number(cashTenderedCents);
  const tendered =
    paymentMethod === "CASH" && Number.isFinite(tenderedRaw) && tenderedRaw > 0
      ? Math.round(tenderedRaw)
      : 0;
  if (tendered > 0 && tendered < totalCents) {
    return NextResponse.json(
      { error: `Cash given (${(tendered / 100).toFixed(2)}) doesn't cover the ${(totalCents / 100).toFixed(2)} total.` },
      { status: 400 }
    );
  }

  /* When an offline sale was actually rung, so the ticket lands in the right
     day, the right drawer's window and the right month's tax return.

     Guarded at both ends. A device whose clock is wrong — and tills do sit
     unplugged for months — could otherwise book a sale into next year, where no
     report would ever show it, or backdate one into a month already filed.
     Outside the window the server's own clock is used instead, which is at
     worst a few hours late and always visible. */
  const soldAt = (() => {
    if (!offline || typeof soldAtIso !== "string") return null;
    const d = new Date(soldAtIso);
    if (Number.isNaN(d.getTime())) return null;
    const now = Date.now();
    if (d.getTime() > now + 5 * 60 * 1000) return null;
    if (d.getTime() < now - 7 * 24 * 60 * 60 * 1000) return null;
    return d;
  })();

  /* Retry the whole transaction if the ticket number collides. Two concurrent
     sales can compute the same next number; the unique index rejects the second
     with Prisma error P2002, and a retry recomputes against the committed max.
     Anything else rethrows immediately. */
  const runSale = async () => db.$transaction(async (tx) => {
    /* ---- stock: claim it atomically, don't check-then-take.
       A SELECT followed by a decrement lets two registers both read "1 left"
       and both sell it, because Postgres reads a snapshot. Instead each item
       is claimed with a conditional UPDATE whose WHERE carries the quantity
       test — the row is locked and re-checked by the database, so exactly one
       of two concurrent tickets can match. 0 rows matched means we lost the
       race. The names are read first only to write a useful error. */
    const needed = new Map<string, number>();
    for (const sl of saleLines) needed.set(sl.itemId, (needed.get(sl.itemId) || 0) + sl.quantity);
    const known = await tx.item.findMany({
      where: { id: { in: [...needed.keys()] } },
      select: { id: true, name: true },
    });
    const nameOf = (id: string) => known.find((i) => i.id === id)?.name || "That item";

    // Claim in a stable order so two tickets sharing items can't deadlock by
    // grabbing the same rows in opposite orders.
    for (const itemId of [...needed.keys()].sort()) {
      const qty = needed.get(itemId)!;
      if (!known.some((i) => i.id === itemId)) {
        throw new HttpError(400, "An item on the ticket no longer exists.");
      }

      /* Offline sales never fail on stock. The goods left the building hours
         ago; refusing the ticket now would lose the money to keep a count
         tidy. The count is floored at zero instead, and the shortfall shows up
         as a stock figure to correct rather than a sale that doesn't exist.

         A card already taken on the reader is the same situation for the same
         reason. If the last jar sold at the other till while the customer was
         tapping, refusing here would leave a charge with no ticket behind it —
         a stock count off by one is the smaller problem by a mile. */
      if (offline || snap) {
        const row = await tx.item.findUnique({ where: { id: itemId }, select: { quantity: true } });
        const left = Math.max(0, (row?.quantity ?? 0) - qty);
        await tx.item.update({ where: { id: itemId }, data: { quantity: left } });
        continue;
      }

      const claimed = await tx.item.updateMany({
        where: { id: itemId, quantity: { gte: qty } },
        data: { quantity: { decrement: qty } },
      });
      if (claimed.count === 0) {
        const row = await tx.item.findUnique({ where: { id: itemId }, select: { quantity: true } });
        const left = row?.quantity ?? 0;
        throw new HttpError(
          400,
          left <= 0
            ? `${nameOf(itemId)} is sold out — take it off the ticket.`
            : `Only ${left} of ${nameOf(itemId)} left (ticket has ${qty}) — adjust the quantity.`
        );
      }
    }

    // ---- redemption: conditional decrement, so the same 100 points can't be
    // spent twice by two concurrent sales. 0 rows matched = someone beat us.
    if (redeem && customer) {
      const spent = await tx.customer.updateMany({
        where: { id: customer.id, points: { gte: REDEEM_POINTS } },
        data: { points: { decrement: REDEEM_POINTS } },
      });
      if (spent.count === 0 && !snap) {
        throw new HttpError(400, `Those points were just used — ${REDEEM_POINTS} points aren't available anymore. Ring it up without the reward.`);
      }
      /* When the card has already been charged the discounted amount, points
         that vanished in the last few seconds are not a reason to refuse the
         ticket. The customer paid less; the points went somewhere; the sale
         stands and the balance is the customer's to query. */
    }

    /* Ticket number. Reading the max and adding one is racy — two registers
       ringing at the same moment both read the same max. A unique index on
       Sale.number is what actually prevents a duplicate; this transaction is
       retried by the caller when that index rejects the insert. */
    const last = await tx.sale.aggregate({ _max: { number: true } });
    const number = Math.max(1000, (last._max.number || 999) + 1);
    const created = await tx.sale.create({
      data: {
        customerId: customer ? customer.id : "",
        discountCents,
        cardAdjustCents,
        saleSavingsCents,
        number,
        cardName: paymentMethod === "CARD" ? (cardName || "").trim().slice(0, 60) : "",
        employee: clerk,
        drawerId: drawer?.id || "",
        idemKey,
        ...(soldAt ? { createdAt: soldAt } : {}),
        subtotalCents: subtotal, taxCents, totalCents, paymentMethod,
        /* Change is derived here, never taken from the client. The register
           shows the cashier a figure, but the number that goes on the ticket
           and the receipt is computed from the authoritative total — otherwise
           a stale or edited client value could book a sale whose own arithmetic
           doesn't add up, and the drawer would never reconcile. */
        cashTenderedCents: tendered,
        changeCents: tendered > 0 ? Math.max(0, tendered - totalCents) : 0,
        foodTaxCents: taxSplit.foodTaxCents,
        standardTaxCents: taxSplit.standardTaxCents,
        lines: { create: saleLines },
      },
    });
    for (const sl of saleLines) {
      // Stock was already claimed at the top of this transaction — decrementing
      // again here would double-count it.
      await tx.ledgerEntry.create({
        data: {
          vendorId: sl.vendorId,
          type: "SALE",
          amountCents: sl.vendorNetCents,
          note: `${sl.quantity}× ${sl.name}`,
        },
      });
    }
    /* The old code clamped negative quantities here, which quietly hid an
       oversell after the fact. The conditional claim above makes a negative
       count unreachable, so there is nothing left to paper over. */

    // ---- points earned + the audit trail, committed with the sale
    if (customer) {
      const earned = pointsFor(totalCents);
      if (earned > 0) {
        await tx.customer.update({ where: { id: customer.id }, data: { points: { increment: earned } } });
        await tx.loyaltyEvent.create({ data: { customerId: customer.id, saleId: created.id, delta: earned, note: `Sale #${created.number}` } });
      }
      if (redeem) {
        await tx.loyaltyEvent.create({ data: { customerId: customer.id, saleId: created.id, delta: -REDEEM_POINTS, note: `$5 reward redeemed on #${created.number}` } });
      }
    }
    return created;
  });

  let sale;
  try {
    sale = await runSale();
  } catch (err) {
    const code = (err as { code?: string }).code;
    const target = String((err as { meta?: { target?: unknown } }).meta?.target || "");

    /* Two syncs posting the same queued sale at the same moment: the first one
       committed while the second was still inside its transaction, so the
       duplicate check at the top of this route couldn't have seen it. The
       unique index caught it, which is exactly its job — hand back the sale
       that won rather than ringing a second one. */
    if (code === "P2002" && idemKey && target.includes("idemKey")) {
      const won = await db.sale.findFirst({
        where: { idemKey },
        select: { id: true, number: true, employee: true, totalCents: true, createdAt: true },
      });
      if (won) return NextResponse.json({ sale: won, duplicate: true });
      throw err;
    }

    // Index is named Sale_number_unique, so either fragment identifies it.
    if (code === "P2002" && (target.includes("number") || target.includes("Sale"))) {
      sale = await runSale(); // one retry is enough for a two-register collision
    } else {
      throw err;
    }
  }

  /* The payment and the ticket are now one thing. Stamped after the sale
     commits, so a crash mid-transaction leaves a charge that can still be
     booked rather than one marked done with nothing to show for it. */
  if (charge) {
    await db.terminalCharge
      .update({ where: { id: charge.id }, data: { status: "BOOKED", saleId: sale.id } })
      .catch(() => null);
  }

  /* ------------------------------------------------------------- paper --
     Queued, not printed. Nothing here waits for the printer: the printer
     collects its own work a moment later (see api/print), which is what lets
     a receipt survive the tablet locking, the browser closing, or the till
     being carried across the room between the sale and the paper.

     A cash sale carries the drawer kick in the same job as the receipt, so
     the drawer opens as the paper starts rather than a beat before or after.
     Card sales don't open the drawer at all — there is no change to give, and
     a drawer that opens on every sale is a drawer that stops being counted. */
  try {
    if (await getAutoPrint()) {
      const [header, footer] = await Promise.all([getReceiptHeader(), getReceiptFooter()]);
      const forPrint = {
        number: sale.number,
        createdAt: sale.createdAt,
        employee: sale.employee,
        lines: saleLines.map((l) => ({
          name: l.name,
          quantity: l.quantity,
          priceCents: l.priceCents,
          basePriceCents: l.basePriceCents,
        })),
        subtotalCents: subtotal,
        saleSavingsCents,
        cardAdjustCents,
        taxCents,
        foodTaxCents: taxSplit.foodTaxCents,
        standardTaxCents: taxSplit.standardTaxCents,
        discountCents,
        totalCents,
        cashTenderedCents: sale.cashTenderedCents,
        changeCents: sale.changeCents,
        paymentMethod,
        cardName: sale.cardName,
      };
      const opts = { header, footer };
      await enqueue({
        kind: "RECEIPT",
        label: `Receipt #${sale.number}`,
        saleId: sale.id,
        createdBy: clerk,
        body: paymentMethod === "CASH" ? receiptWithDrawerXml(forPrint, opts) : receiptXml(forPrint, opts),
      });
    }
  } catch (err) {
    /* A receipt that couldn't be queued must never lose the sale. The money is
       in the drawer and the ticket is in the books; the paper is the least
       important thing that just happened. */
    console.error("receipt queue failed", err);
  }

  // one email per vendor involved, after commit
  const byVendor = new Map<string, typeof saleLines>();
  for (const sl of saleLines) {
    byVendor.set(sl.vendorId, [...(byVendor.get(sl.vendorId) || []), sl]);
  }
  for (const [vendorId, vLines] of byVendor) {
    const vendor = items.find((i) => i.vendorId === vendorId)?.vendor;
    if (vendor?.email) {
      try {
        const net = vLines.reduce((n, l) => n + l.vendorNetCents, 0);
        const itemsTxt = vLines.map((l) => `${l.quantity}x ${l.name}`).join(", ");
        // push-enabled vendors get pinged per sale; everyone else gets one daily summary email (cron)
        await pushToVendor(
          vendor.id,
          "You made a sale! 🎉",
          `${itemsTxt} — your net $${(net / 100).toFixed(2)}`
        );
      } catch (err) {
        console.error("sale email failed", err);
      }
    }
  }

  let customerPoints: number | null = null;
  if (customer) {
    const fresh = await db.customer.findUnique({ where: { id: customer.id } });
    customerPoints = fresh?.points ?? null;
    if (customer.email) {
      try {
        await sendCustomerReceiptEmail(customer.email, sale.number,
          saleLines.map((l) => ({ name: l.name, quantity: l.quantity, priceCents: l.basePriceCents || l.priceCents })),
          subtotal, taxCents, discountCents, totalCents, customerPoints ?? 0, saleSavingsCents);
      } catch {}
    }
  }

  return NextResponse.json({ sale: { id: sale.id, number: sale.number, employee: sale.employee, cardName: sale.cardName, createdAt: sale.createdAt, subtotalCents: subtotal, taxCents, discountCents, cardAdjustCents, saleSavingsCents, totalCents, taxRate: rates.standardPercent, foodTaxCents: taxSplit.foodTaxCents, standardTaxCents: taxSplit.standardTaxCents, cashTenderedCents: sale.cashTenderedCents, changeCents: sale.changeCents, customerPoints, customerContact: customer ? (customer.email || customer.phone) : "" } });
  });
}

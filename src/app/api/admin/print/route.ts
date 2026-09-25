import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit, currentAuditActor } from "@/lib/audit";
import { enqueue, lastSeen, requeueStale } from "@/lib/printqueue";
import { drawerXml, testXml, plainTestXml, receiptXml } from "@/lib/epos";
import { drawerForRequest } from "@/lib/drawer";
import {
  getPrinterKey,
  setPrinterKey,
  getReceiptHeader,
  setReceiptHeader,
  getReceiptFooter,
  setReceiptFooter,
  getAutoPrint,
  setAutoPrint,
  getSdpVersion,
  setSdpVersion,
  getPrinterEvent,
  getPrinterResponse,
  getPrinterDeviceId,
  setPrinterDeviceId,
  getPrinterLog,
} from "@/lib/settings";

export const dynamic = "force-dynamic";

/** GET — is the printer alive, and what's waiting on it. */
export async function GET() {
  return runRoute("admin/print GET", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    await requeueStale().catch(() => {});

    const [seen, queued, failed, recent, autoPrint, sdpVersion, lastEvent] = await Promise.all([
      lastSeen(),
      db.printJob.count({ where: { status: { in: ["QUEUED", "SENT"] } } }),
      db.printJob.count({ where: { status: "FAILED" } }),
      db.printJob.findMany({
        orderBy: { createdAt: "desc" },
        take: 12,
        select: { id: true, kind: true, label: true, status: true, error: true, createdAt: true, doneAt: true, attempts: true },
      }),
      getAutoPrint(),
      getSdpVersion(),
      getPrinterEvent(),
    ]);
    const lastResponse = await getPrinterResponse();
    const deviceId = await getPrinterDeviceId();
    const log = await getPrinterLog();

    /* "Online" is the printer having asked for work recently, which is the
       only thing this app can actually know about it. Two minutes is generous
       against any polling interval somebody is likely to set. */
    const online = !!seen && Date.now() - seen.getTime() < 120_000;

    return NextResponse.json({
      online,
      lastSeen: seen ? seen.toISOString() : null,
      queued,
      failed,
      recent,
      autoPrint,
      sdpVersion,
      /* The last thing the printer actually did, in words. When nothing
         prints, the difference between "was handed Receipt #12" over and over
         and "reported a job refused" is the whole diagnosis. */
      lastEvent,
      lastResponse,
      deviceId,
      log,
      configured: !!(await getPrinterKey()),
    });
  });
}

/**
 * POST { action }
 *
 * "drawer"  — no sale, just open it. The one the cashier presses.
 * "test"    — prints a page and pops the drawer, for setting the thing up.
 * "reprint" — the same paper as the original, marked as a copy.
 */
export async function POST(req: NextRequest) {
  return runRoute("admin/print POST", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "").toLowerCase();
    const actor = await currentAuditActor();
    const who = actor.actorName || "";

    if (!(await getPrinterKey())) {
      return NextResponse.json(
        { error: "The printer hasn't been set up yet — do that in Settings first." },
        { status: 400 }
      );
    }

    if (action === "drawer") {
      /* Opening the till without a sale is the classic way money leaves a
         drawer, so it is always written down, with a name against it. It is
         not blocked — making change and fixing a miskey are real — but nobody
         gets to do it anonymously. */
      const { drawer } = await drawerForRequest();
      const id = await enqueue({ kind: "DRAWER", label: "No sale — drawer opened", body: drawerXml(), createdBy: who });
      await recordAudit(
        {
          action: "NO_SALE",
          targetType: "DRAWER",
          targetId: drawer?.id || "",
          targetLabel: who || "the till",
          detail: `${who || "Someone"} opened the drawer with no sale${body.reason ? `: ${String(body.reason).slice(0, 120)}` : ""}.`,
        },
        req
      );
      return NextResponse.json({ ok: true, jobId: id });
    }

    if (action === "test") {
      const id = await enqueue({ kind: "TEST", label: "Test print", body: testXml(who), createdBy: who });
      return NextResponse.json({ ok: true, jobId: id });
    }

    /* The bisect. Nothing but text and a cut — if this prints and a receipt
       doesn't, the fault is one element in the receipt, not the link. */
    if (action === "plain") {
      const id = await enqueue({ kind: "TEST", label: "Plain test", body: plainTestXml(), createdBy: who });
      return NextResponse.json({ ok: true, jobId: id });
    }

    if (action === "reprint") {
      const saleId = String(body.saleId || "");
      const sale = await db.sale.findUnique({
        where: { id: saleId },
        include: { lines: { select: { name: true, quantity: true, priceCents: true, basePriceCents: true } } },
      });
      if (!sale) return NextResponse.json({ error: "That ticket is gone." }, { status: 404 });

      const [header, footer] = await Promise.all([getReceiptHeader(), getReceiptFooter()]);
      const id = await enqueue({
        kind: "REPRINT",
        label: `Reprint #${sale.number}`,
        saleId: sale.id,
        createdBy: who,
        body: receiptXml(
          {
            number: sale.number,
            createdAt: sale.createdAt,
            employee: sale.employee,
            lines: sale.lines,
            subtotalCents: sale.subtotalCents,
            saleSavingsCents: sale.saleSavingsCents,
            cardAdjustCents: sale.cardAdjustCents,
            taxCents: sale.taxCents,
            foodTaxCents: sale.foodTaxCents,
            standardTaxCents: sale.standardTaxCents,
            discountCents: sale.discountCents,
            totalCents: sale.totalCents,
            cashTenderedCents: sale.cashTenderedCents,
            changeCents: sale.changeCents,
            paymentMethod: sale.paymentMethod,
            cardName: sale.cardName,
          },
          /* Marked, always. An unmarked second copy of a receipt is the thing
             a returned-goods scam is built on. */
          { header, footer, reprint: true }
        ),
      });
      return NextResponse.json({ ok: true, jobId: id });
    }

    return NextResponse.json({ error: "Don't know how to do that." }, { status: 400 });
  });
}

/**
 * PATCH { header?, footer?, autoPrint? } — what the paper says, and whether
 * it comes out by itself. Owner only; also hands back the address the printer
 * needs to be given, which is the one thing setup actually requires.
 */
export async function PATCH(req: NextRequest) {
  return runRoute("admin/print PATCH", async () => {
    { const denied = await denyUnless("config"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));

    if (typeof body.header === "string") {
      await setReceiptHeader(String(body.header).split("\n"));
    }
    if (typeof body.footer === "string") {
      await setReceiptFooter(String(body.footer).split("\n"));
    }
    if (body.autoPrint !== undefined) await setAutoPrint(!!body.autoPrint);
    if (body.sdpVersion !== undefined) await setSdpVersion(String(body.sdpVersion));
    if (body.deviceId !== undefined) await setPrinterDeviceId(String(body.deviceId));

    const key = await getPrinterKey();
    return NextResponse.json({
      ok: true,
      key,
      header: (await getReceiptHeader()).join("\n"),
      footer: (await getReceiptFooter()).join("\n"),
      autoPrint: await getAutoPrint(),
      sdpVersion: await getSdpVersion(),
      deviceId: await getPrinterDeviceId(),
    });
  });
}

/** PUT — make a new address for the printer to poll. Owner only. */
export async function PUT(req: NextRequest) {
  return runRoute("admin/print PUT", async () => {
    { const denied = await denyUnless("config"); if (denied) return denied; }

    /* Long enough that nobody guesses it, and made of characters that survive
       being typed into a printer's own settings screen with a stylus. */
    const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const key = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");

    await setPrinterKey(key);
    await recordAudit(
      {
        action: "SETTING_CHANGE",
        targetType: "PRINTER",
        targetId: "printer",
        targetLabel: "Receipt printer",
        detail: "A new printer address was generated — the old one stopped working straight away.",
      },
      req
    );
    return NextResponse.json({ ok: true, key });
  });
}

/** DELETE ?id= — clear a job that failed, or the whole failed pile. */
export async function DELETE(req: NextRequest) {
  return runRoute("admin/print DELETE", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const id = req.nextUrl.searchParams.get("id") || "";
    if (id === "failed") {
      const { count } = await db.printJob.deleteMany({ where: { status: "FAILED" } });
      return NextResponse.json({ ok: true, cleared: count });
    }
    /* Everything not yet printed, whatever state it got stuck in. A job that
       is handed over and never confirmed sits at SENT indefinitely, which is
       right — it might still print — but it left no way to call a halt. This
       is that way. */
    if (id === "waiting") {
      const { count } = await db.printJob.deleteMany({ where: { status: { in: ["QUEUED", "SENT", "FAILED"] } } });
      return NextResponse.json({ ok: true, cleared: count });
    }
    if (!id) return NextResponse.json({ error: "Which job?" }, { status: 400 });
    await db.printJob.deleteMany({ where: { id } });
    return NextResponse.json({ ok: true, cleared: 1 });
  });
}

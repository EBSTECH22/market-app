import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";
import { unlockIfRentPaid } from "@/lib/unlock";

export const dynamic = "force-dynamic";

/**
 * Rent that Stripe took and the books never heard about.
 *
 * A payment reaches the ledger by one of two routes: the vendor's browser
 * returning to the success page, or the Stripe webhook. The first fails
 * silently whenever somebody pays and closes the tab; the second only exists if
 * the endpoint is registered in Stripe AND STRIPE_WEBHOOK_SECRET is set in the
 * environment. If neither happened, Stripe holds the money and the invoice sits
 * there saying unpaid — which looks exactly like a badge bug and isn't one.
 *
 * So this asks Stripe directly: every succeeded rent payment, matched against
 * the ledger, with the gaps listed. Nothing is written by the GET — it reports,
 * and a person decides what to post.
 *
 * MATCHING, and why it's belt-and-braces: a payment recorded through the normal
 * path stamps the PaymentIntent id into the ledger note (`[ck abcdefghij]`), so
 * that marker is the primary match. But rent charged to a card on file from the
 * settlement screen posts its own entry, and older entries predate the marker
 * entirely. Those are matched on vendor + amount + a same-day window instead,
 * and reported as "looks already recorded" rather than offered for posting.
 * Posting a duplicate payment is worse than leaving one for a human to look at.
 */

const DAY_MS = 86_400_000;
/** How close in time an unmarked ledger entry has to be to count as the same payment. */
const MATCH_WINDOW_MS = 2 * DAY_MS;
/** Stripe pages to walk. A market's rent volume never approaches this. */
const MAX_PAGES = 5;

type RentIntent = {
  id: string;
  createdMs: number;
  vendorId: string;
  dueCents: number;
  feeCents: number;
  amountCents: number;
  last4: string;
  description: string;
};

/** Every succeeded payment intent that carries a vendorId — rent, by construction. */
async function rentIntentsSince(sinceMs: number): Promise<RentIntent[]> {
  const out: RentIntent[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await stripe!.paymentIntents.list({
      created: { gte: Math.floor(sinceMs / 1000) },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const pi of res.data) {
      const vendorId = pi.metadata?.vendorId || "";
      if (!vendorId || pi.status !== "succeeded") continue;
      out.push({
        id: pi.id,
        createdMs: pi.created * 1000,
        vendorId,
        dueCents: Number(pi.metadata?.dueCents || 0),
        feeCents: Number(pi.metadata?.feeCents || 0),
        amountCents: pi.amount ?? 0,
        last4: (pi as { charges?: { data?: { payment_method_details?: { card?: { last4?: string } } }[] } })
          .charges?.data?.[0]?.payment_method_details?.card?.last4 || "",
        description: pi.description || "",
      });
    }

    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }

  return out;
}

type Verdict = "MISSING" | "RECORDED" | "PROBABLY_RECORDED" | "NO_VENDOR" | "NO_AMOUNT";

async function classify(intents: RentIntent[]) {
  const vendorIds = [...new Set(intents.map((i) => i.vendorId))];
  const vendors = vendorIds.length
    ? await db.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, code: true, businessName: true } })
    : [];
  const vendorById = new Map<string, { id: string; code: string; businessName: string }>(
    vendors.map((v) => [v.id, v] as [string, { id: string; code: string; businessName: string }])
  );

  const entries = vendorIds.length
    ? await db.ledgerEntry.findMany({
        where: { vendorId: { in: vendorIds }, type: "RENT_PAYMENT" },
        select: { id: true, vendorId: true, amountCents: true, note: true, createdAt: true },
      })
    : [];

  return intents.map((pi) => {
    const vendor = vendorById.get(pi.vendorId);
    const marker = `[ck ${pi.id.slice(-10)}]`;
    const byMarker = entries.find((e) => e.note.includes(marker));

    /* Unmarked but the same money on the same day — almost certainly the
       settlement screen's own entry, or one posted before markers existed. */
    const byAmount = entries.find(
      (e) =>
        e.vendorId === pi.vendorId &&
        e.amountCents === pi.dueCents &&
        Math.abs(e.createdAt.getTime() - pi.createdMs) <= MATCH_WINDOW_MS
    );

    const verdict: Verdict =
      !vendor ? "NO_VENDOR"
      : byMarker ? "RECORDED"
      : byAmount ? "PROBABLY_RECORDED"
      : pi.dueCents <= 0 ? "NO_AMOUNT"
      : "MISSING";

    return {
      paymentIntentId: pi.id,
      paidAt: new Date(pi.createdMs).toISOString(),
      vendorId: pi.vendorId,
      code: vendor?.code || "",
      businessName: vendor?.businessName || "(vendor no longer in the system)",
      dueCents: pi.dueCents,
      feeCents: pi.feeCents,
      chargedCents: pi.amountCents,
      last4: pi.last4,
      description: pi.description,
      verdict,
      matchedEntryId: byMarker?.id || byAmount?.id || "",
    };
  });
}

// GET ?days=180 — report only, writes nothing
export async function GET(req: NextRequest) {
  return runRoute("admin/stripe-reconcile GET", async () => {
    { const denied = await denyUnless("financials"); if (denied) return denied; }
    if (!stripe) return NextResponse.json({ error: "Stripe isn't configured." }, { status: 500 });

    const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get("days") || 180)));
    const intents = await rentIntentsSince(Date.now() - days * DAY_MS);
    const rows = await classify(intents);
    const missing = rows.filter((r) => r.verdict === "MISSING");

    return NextResponse.json({
      days,
      rows: rows.sort((a, b) => (a.paidAt < b.paidAt ? 1 : -1)),
      missingCount: missing.length,
      missingCents: missing.reduce((n, r) => n + r.dueCents, 0),
      /* Whether the safety net is even switched on. If this is false, every
         payment where the vendor closed the tab was always going to be lost,
         and reconciling today fixes the past but not next month. */
      webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET,
      checkedCount: rows.length,
    });
  });
}

// POST { paymentIntentIds: string[] } — post the named ones to the ledger
export async function POST(req: NextRequest) {
  return runRoute("admin/stripe-reconcile POST", async () => {
    // Writing money into the books.
    { const denied = await denyUnless("money"); if (denied) return denied; }
    if (!stripe) return NextResponse.json({ error: "Stripe isn't configured." }, { status: 500 });

    const body = await req.json();
    const ids = (Array.isArray(body.paymentIntentIds) ? body.paymentIntentIds : [])
      .map((x: unknown) => String(x || "").trim())
      .filter(Boolean)
      .slice(0, 50);
    if (!ids.length) return NextResponse.json({ error: "Nothing selected." }, { status: 400 });

    const posted: { paymentIntentId: string; vendorId: string; amountCents: number }[] = [];
    const skipped: { paymentIntentId: string; reason: string }[] = [];

    for (const id of ids) {
      let pi;
      try {
        pi = await stripe.paymentIntents.retrieve(id);
      } catch {
        skipped.push({ paymentIntentId: id, reason: "Stripe doesn't recognise that payment." });
        continue;
      }
      if (pi.status !== "succeeded") { skipped.push({ paymentIntentId: id, reason: `Payment is ${pi.status}.` }); continue; }

      const vendorId = pi.metadata?.vendorId || "";
      const dueCents = Number(pi.metadata?.dueCents || 0);
      const feeCents = Number(pi.metadata?.feeCents || 0);
      if (!vendorId || dueCents <= 0) { skipped.push({ paymentIntentId: id, reason: "Not a rent payment." }); continue; }

      const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: { id: true, code: true, businessName: true } });
      if (!vendor) { skipped.push({ paymentIntentId: id, reason: "That vendor no longer exists." }); continue; }

      /* The same marker the normal path writes. Checked again here rather than
         trusted from the GET: the report could be minutes old, and the webhook
         may have landed in between. */
      const marker = `[ck ${pi.id.slice(-10)}]`;
      const already = await db.ledgerEntry.findFirst({
        where: { vendorId, type: "RENT_PAYMENT", note: { contains: marker } },
      });
      if (already) { skipped.push({ paymentIntentId: id, reason: "Already on the ledger." }); continue; }

      await db.ledgerEntry.create({
        data: {
          vendorId,
          type: "RENT_PAYMENT",
          amountCents: dueCents,
          note: `Rent paid by card: $${((dueCents + feeCents) / 100).toFixed(2)} charged${feeCents ? ` (includes $${(feeCents / 100).toFixed(2)} card-processing adjustment)` : ""} — matched from Stripe ${marker}`,
        },
      });
      try { await unlockIfRentPaid(vendorId); } catch {}

      await recordAudit(
        {
          action: "VENDOR_LEDGER",
          targetType: "VENDOR",
          targetId: vendorId,
          targetLabel: `${vendor.code} — ${vendor.businessName}`,
          amountCents: -dueCents,
          detail: `Stripe payment matched into the ledger: $${(dueCents / 100).toFixed(2)} taken ${new Date(pi.created * 1000).toISOString().slice(0, 10)} that had never posted`,
          after: { paymentIntentId: pi.id, dueCents, feeCents },
        },
        req
      );

      posted.push({ paymentIntentId: id, vendorId, amountCents: dueCents });
    }

    return NextResponse.json({ ok: true, posted, skipped });
  });
}

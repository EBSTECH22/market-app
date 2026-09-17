import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { finalizeRentAndNotify } from "@/lib/rentfinalize";
import { finalizeSelfCartIfPaid } from "@/lib/selfcheckout";
import { finalizeIfPaid as finalizePreorderIfPaid } from "@/lib/preorder";
import { finalizeTentIfPaid } from "@/lib/tents";
import { refreshAccountStatus } from "@/lib/payouts";
import { finalizeOrder, expireOrder } from "@/lib/orderfinalize";

/**
 * Stripe's server-to-server notification that money actually moved.
 *
 * Why this exists: every payment in this app used to be recorded only when the
 * customer's browser came back to the success page. Pay and close the tab, or
 * lose signal on the redirect, and Stripe had the money while the app knew
 * nothing — no ledger entry, no vendor credit, no inventory decrement, no
 * portal unlock. This endpoint is the backstop, and it doesn't care what the
 * browser did.
 *
 * Everything it calls is idempotent (ledger markers and status checks), which
 * matters because Stripe delivers at least once and can retry.
 *
 * SETUP: add this URL in the Stripe dashboard under Developers → Webhooks,
 * listening for `checkout.session.completed`, `checkout.session.expired` and
 * `account.updated`, then put
 * the signing secret in STRIPE_WEBHOOK_SECRET. Without that variable this
 * endpoint refuses everything — it will not process unverified events.
 *
 * `account.updated` has to be enabled for CONNECTED ACCOUNTS (the "listen to
 * events on connected accounts" checkbox), because it is about a vendor's own
 * Stripe account rather than the market's. It is what keeps "can this vendor be
 * paid" honest: onboarding can stall days later when Stripe asks for another
 * document, and without this event the app would keep believing the answer it
 * got the day they signed up.
 */

// Node runtime: signature verification needs the raw body, and the Stripe SDK
// needs Node crypto. The App Router does not pre-parse the body, so req.text()
// returns exactly the bytes Stripe signed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!stripe) {
    console.error("[stripe webhook] Stripe isn't configured");
    return NextResponse.json({ error: "Not configured." }, { status: 500 });
  }

  /* One secret, or several separated by commas.
     Stripe's dashboard sometimes wants events from the market's own account and
     events from vendors' connected accounts registered as TWO endpoints, and
     each endpoint has its own signing secret. Accepting a list means both can
     point at this URL without one of them silently failing verification for
     the rest of time. */
  const secrets = String(process.env.STRIPE_WEBHOOK_SECRET || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!secrets.length) {
    // Fail closed. An unverified body is just a stranger claiming someone paid.
    console.error("[stripe webhook] STRIPE_WEBHOOK_SECRET is not set — refusing the event");
    return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature." }, { status: 400 });

  // Read the raw body BEFORE any parsing — the signature is an HMAC of these
  // exact bytes, so re-serialising JSON would break it.
  const raw = await req.text();

  type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };
  let event: StripeEvent | null = null;
  let lastError: unknown = null;
  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(raw, signature, secret) as unknown as StripeEvent;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!event) {
    console.error("[stripe webhook] signature verification failed:", lastError instanceof Error ? lastError.message : lastError);
    return NextResponse.json({ error: "Bad signature." }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCompletedSession(event.data.object);
    } else if (event.type === "account.updated") {
      await handleAccountUpdated(event.data.object);
    } else if (event.type === "checkout.session.expired") {
      /* An online order that was started and abandoned. The stock it was
         holding has to go back, or one unfinished basket removes a vendor's
         last item from sale for good. */
      const meta = (event.data.object.metadata as Record<string, string> | null) || {};
      if (meta.orderId) await expireOrder(meta.orderId);
    }
    // Other event types are acknowledged and ignored — returning non-200 would
    // make Stripe retry something we were never going to act on.
  } catch (err) {
    console.error(`[stripe webhook] handling ${event.type} (${event.id}) failed:`, err);
    // 500 asks Stripe to retry. Every handler is idempotent, so a retry is safe
    // and is what recovers from a transient database blip.
    return NextResponse.json({ error: "Handler failed." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

/**
 * A vendor's connected account changed — verified, or newly blocked.
 *
 * The account id is looked up rather than trusted: the event carries whatever
 * Stripe sends, and the vendor row is only touched when the id actually matches
 * one of ours.
 */
async function handleAccountUpdated(account: Record<string, unknown>): Promise<void> {
  const accountId = String(account.id || "");
  if (!accountId) return;
  const vendor = await db.vendor.findFirst({ where: { stripeAccountId: accountId }, select: { id: true } });
  if (!vendor) return;
  await refreshAccountStatus(vendor.id);
}

/**
 * Route one completed checkout to the same finalizer the browser-return path
 * uses, so both produce identical results.
 *
 * Each flow is identified differently because of how its session was created:
 *  - self-checkout, pre-orders and tents put an id in the SESSION metadata
 *  - rent puts the vendor on the PAYMENT INTENT metadata, so it is recognised
 *    by the absence of the others plus a vendorId on the intent
 */
async function handleCompletedSession(session: Record<string, unknown>): Promise<void> {
  const id = String(session.id || "");
  const metadata = (session.metadata as Record<string, string> | null) || {};

  if (metadata.selfCartId) {
    await finalizeSelfCartIfPaid(metadata.selfCartId);
    return;
  }
  if (metadata.preorderId) {
    await finalizePreorderIfPaid(metadata.preorderId);
    return;
  }
  if (metadata.tentBookingId) {
    await finalizeTentIfPaid(metadata.tentBookingId);
    return;
  }
  if (metadata.orderId) {
    const res = await finalizeOrder(metadata.orderId);
    if (!res.ok) console.warn(`[stripe webhook] order finalize for ${id}: ${res.error}`);
    return;
  }

  /* Rent. The vendor id lives on the payment intent rather than the session,
     so confirm that before treating it as rent — an unrecognised session is
     more likely a flow added later than something to force through here. */
  const piField = session.payment_intent;
  const piId = typeof piField === "string" ? piField : (piField as { id?: string } | null)?.id;
  if (!piId) {
    console.warn(`[stripe webhook] session ${id} has no payment intent — ignoring`);
    return;
  }

  const pi = await stripe!.paymentIntents.retrieve(piId);
  if (pi.metadata?.vendorId) {
    const res = await finalizeRentAndNotify(id, "webhook");
    if (!res.ok) console.warn(`[stripe webhook] rent finalize for ${id}: ${res.error}`);
    return;
  }

  // Fall through: a session we don't recognise. Logged rather than swallowed,
  // so a payment flow added later without a webhook branch is visible.
  const fallbackCart = await db.selfCart.findFirst({
    where: { stripeSessionId: id },
    select: { id: true },
  });
  if (fallbackCart) {
    await finalizeSelfCartIfPaid(fallbackCart.id);
    return;
  }
  console.warn(`[stripe webhook] unrecognised completed session ${id} — no handler matched`);
}

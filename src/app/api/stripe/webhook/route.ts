import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { finalizeRentAndNotify } from "@/lib/rentfinalize";
import { finalizeSelfCartIfPaid } from "@/lib/selfcheckout";
import { finalizeIfPaid as finalizePreorderIfPaid } from "@/lib/preorder";
import { finalizeTentIfPaid } from "@/lib/tents";

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
 * listening for `checkout.session.completed`, then put the signing secret in
 * STRIPE_WEBHOOK_SECRET. Without that variable this endpoint refuses
 * everything — it will not process unverified events.
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

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed. An unverified body is just a stranger claiming someone paid.
    console.error("[stripe webhook] STRIPE_WEBHOOK_SECRET is not set — refusing the event");
    return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature." }, { status: 400 });

  // Read the raw body BEFORE any parsing — the signature is an HMAC of these
  // exact bytes, so re-serialising JSON would break it.
  const raw = await req.text();

  let event: { id: string; type: string; data: { object: Record<string, unknown> } };
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret) as unknown as typeof event;
  } catch (err) {
    console.error("[stripe webhook] signature verification failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Bad signature." }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCompletedSession(event.data.object);
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

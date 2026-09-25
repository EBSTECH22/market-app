import { stripe } from "@/lib/stripe";

/**
 * The card reader, driven from here rather than from the tablet.
 *
 * Stripe call this a server-driven integration, and for a till like this one
 * it is the only sensible shape. The WisePOS E is on the market's wifi with
 * its own connection to Stripe; this app tells Stripe "collect $14.62 on that
 * reader", Stripe tells the reader, and the reader does the rest. The tablet
 * holds no card SDK, needs no pairing, and can be swapped for a different one
 * mid-morning without anybody touching a setting.
 *
 * It also means the card never touches this app, this database, or the tablet.
 * The only thing that comes back is a payment intent id and the last four.
 */

export class TerminalError extends Error {}

const need = () => {
  if (!stripe) throw new TerminalError("Stripe isn't connected — add the secret key first.");
  return stripe;
};

export type ReaderInfo = {
  id: string;
  label: string;
  status: string;
  deviceType: string;
  serial: string;
  location: string;
  lastSeen: string | null;
  /** What it's doing right now, if anything. */
  action: string;
  actionStatus: string;
  /** Why the last thing it was asked to do didn't happen. */
  actionFailure: string;
};

const shape = (r: {
  id: string;
  label?: string | null;
  status?: string | null;
  device_type?: string | null;
  serial_number?: string | null;
  location?: unknown;
  last_seen_at?: number | null;
  action?: { type?: string | null; status?: string | null; failure_message?: string | null } | null;
}): ReaderInfo => ({
  id: r.id,
  label: r.label || "",
  status: String(r.status || "offline"),
  deviceType: String(r.device_type || ""),
  serial: String(r.serial_number || ""),
  location: typeof r.location === "string" ? r.location : ((r.location as { id?: string } | null)?.id || ""),
  lastSeen: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
  action: String(r.action?.type || ""),
  actionStatus: String(r.action?.status || ""),
  actionFailure: String(r.action?.failure_message || ""),
});

export async function listReaders(): Promise<ReaderInfo[]> {
  const s = need();
  const res = await s.terminal.readers.list({ limit: 20 });
  return res.data.map(shape);
}

export async function listLocations(): Promise<{ id: string; name: string }[]> {
  const s = need();
  const res = await s.terminal.locations.list({ limit: 20 });
  return res.data.map((l) => ({ id: l.id, name: l.display_name || l.id }));
}

/** The market's address, so a reader has somewhere to belong. */
export async function ensureLocation(name: string, address: {
  line1: string; city: string; state: string; postal_code: string; country: string;
}): Promise<string> {
  const s = need();
  const existing = await s.terminal.locations.list({ limit: 20 });
  const match = existing.data.find((l) => (l.display_name || "").toLowerCase() === name.toLowerCase());
  if (match) return match.id;
  const made = await s.terminal.locations.create({ display_name: name, address });
  return made.id;
}

/**
 * Pair a reader to this account.
 *
 * The code comes off the reader's own screen — swipe in from the left, tap
 * Settings. It is three words and it expires, which is why this is a button in
 * the office rather than a value in a settings file.
 */
export async function registerReader(registrationCode: string, label: string, location: string): Promise<ReaderInfo> {
  const s = need();
  const r = await s.terminal.readers.create({
    registration_code: registrationCode.trim(),
    label: label.trim().slice(0, 60) || "Front till",
    location,
  });
  return shape(r);
}

export async function forgetReader(id: string): Promise<void> {
  const s = need();
  await s.terminal.readers.del(id);
}

/** What the reader is doing now — polled by the till while it waits. */
export async function readerState(id: string): Promise<ReaderInfo> {
  const s = need();
  const r = await s.terminal.readers.retrieve(id);
  if ((r as { deleted?: boolean }).deleted) throw new TerminalError("That reader has been removed from Stripe.");
  return shape(r as Parameters<typeof shape>[0]);
}

/**
 * A payment for the reader to collect.
 *
 * `card_present` only, on purpose: this intent must never be payable by any
 * other means. The idempotency key is the till's own ticket key, so a tablet
 * that loses its connection mid-tap and retries asks the reader for the same
 * payment rather than a second one.
 */
export async function createCardPresentIntent(amountCents: number, idemKey: string, meta: Record<string, string>) {
  const s = need();
  if (!Number.isFinite(amountCents) || amountCents < 50) {
    throw new TerminalError("A card payment has to be at least 50 cents.");
  }
  return s.paymentIntents.create(
    {
      amount: Math.round(amountCents),
      currency: "usd",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      metadata: meta,
    },
    idemKey ? { idempotencyKey: `pi_${idemKey}` } : undefined
  );
}

/** Put it on the reader's screen. */
export async function sendToReader(readerId: string, paymentIntentId: string): Promise<ReaderInfo> {
  const s = need();
  const r = await s.terminal.readers.processPaymentIntent(readerId, { payment_intent: paymentIntentId });
  return shape(r);
}

/** Take it off the reader's screen — the cashier pressed cancel. */
export async function cancelReader(readerId: string): Promise<void> {
  const s = need();
  await s.terminal.readers.cancelAction(readerId).catch(() => null);
}

export async function intentState(paymentIntentId: string): Promise<{
  status: string;
  amount: number;
  cardLabel: string;
  failure: string;
}> {
  const s = need();
  const pi = await s.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
  const charge = pi.latest_charge as unknown as {
    payment_method_details?: { card_present?: { brand?: string; last4?: string } };
    failure_message?: string | null;
  } | null;
  const cp = charge?.payment_method_details?.card_present;
  return {
    status: String(pi.status),
    amount: pi.amount,
    /* What goes on the receipt line: "VISA 4242". Enough to match a slip to a
       ticket, and nothing a thief could use. */
    cardLabel: cp?.brand ? `${String(cp.brand).toUpperCase()} ${cp.last4 || ""}`.trim() : "",
    failure: String(pi.last_payment_error?.message || charge?.failure_message || ""),
  };
}

export async function cancelIntent(paymentIntentId: string): Promise<void> {
  const s = need();
  await s.paymentIntents.cancel(paymentIntentId).catch(() => null);
}

/**
 * Money back, on the card it came from.
 *
 * Card-present refunds go to the card through Stripe rather than out of the
 * drawer — a cash refund on a card sale is how a till ends the day over and
 * the card statement ends it under.
 */
export async function refundIntent(paymentIntentId: string, amountCents?: number): Promise<string> {
  const s = need();
  const r = await s.refunds.create({
    payment_intent: paymentIntentId,
    ...(typeof amountCents === "number" ? { amount: Math.round(amountCents) } : {}),
  });
  return r.id;
}

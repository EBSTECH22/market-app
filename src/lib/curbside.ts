/**
 * Kerbside ordering: order from the car park, press a button on arrival,
 * somebody brings it out.
 *
 * Built for one stand inside the building that makes everything to order. That
 * shapes three decisions the rest of the app would otherwise push the other
 * way:
 *
 *   NO STOCK IS RESERVED. Online orders draw down `onlineQuantity`, a pool a
 *   vendor sets aside deliberately, because a shopper on a sofa must not take
 *   the last jar from somebody holding it at the booth. A drink made when it is
 *   ordered has no such pool, and making the stand set one aside every morning
 *   is how the feature would quietly stop being used by the second week.
 *
 *   AN ORDER CAN BE UNPAID AND STILL REAL. Paying inside means the order lives
 *   before the money does. Everything else in the app treats an unpaid order as
 *   an abandoned checkout, which is why kerbside never uses the PENDING state
 *   that says exactly that.
 *
 *   THREE THINGS MOVE INDEPENDENTLY — preparation, payment and arrival. A
 *   customer can turn up before the drink is ready or twenty minutes after,
 *   and can pay at either end. One status column would make some of those
 *   combinations unrepresentable, and the one it lost would be the one that
 *   happened on a Saturday.
 */

/** Preparation, in order. Payment and arrival are their own fields. */
export const CURBSIDE_FLOW = ["PLACED", "ACCEPTED", "READY", "COLLECTED"] as const;
export type CurbsideState = (typeof CURBSIDE_FLOW)[number] | "CANCELLED" | "NO_SHOW";

/** Still the vendor's problem: on the screen, waiting to be made or handed over. */
export function isLive(status: string): boolean {
  return status === "PLACED" || status === "ACCEPTED" || status === "READY";
}

/** What the vendor may do next, so the screen and the server agree. */
export function canAdvance(from: string, to: string): boolean {
  if (to === "CANCELLED" || to === "NO_SHOW") return isLive(from);
  const i = (CURBSIDE_FLOW as readonly string[]).indexOf(from);
  const j = (CURBSIDE_FLOW as readonly string[]).indexOf(to);
  if (i < 0 || j < 0) return false;
  /* Forwards only, and one step at a time. Letting a tap skip from PLACED to
     COLLECTED would record a handover for a drink nobody made. */
  return j === i + 1;
}

export type Hours = {
  openMinute: number;
  closeMinute: number;
  cutoffMinutes: number;
};

export type OpenState =
  | { open: true; lastOrderMinute: number }
  | { open: false; reason: string; opensAtMinute?: number };

/** Minutes past midnight for a Date, in market time. */
export function minuteOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  return get("hour") * 60 + get("minute");
}

/** "8:00am", for telling somebody when to come back. */
export function clockLabel(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, "0")}${h24 < 12 ? "am" : "pm"}`;
}

/**
 * Can an order be placed right now?
 *
 * Answered on the server every time, never trusted from the page: a browser
 * left open overnight would otherwise cheerfully order a lemonade at 3am.
 */
export function openState(
  nowMinute: number,
  hours: Hours,
  opts: { enabled: boolean; pausedUntil?: Date | null; now?: Date } = { enabled: true }
): OpenState {
  if (!opts.enabled) return { open: false, reason: "This stand isn't taking kerbside orders." };

  const pausedUntil = opts.pausedUntil ? new Date(opts.pausedUntil) : null;
  const now = opts.now || new Date();
  if (pausedUntil && pausedUntil.getTime() > now.getTime()) {
    const mins = Math.max(1, Math.round((pausedUntil.getTime() - now.getTime()) / 60000));
    return { open: false, reason: `Paused for about ${mins} more ${mins === 1 ? "minute" : "minutes"} — try again shortly.` };
  }

  const lastOrderMinute = hours.closeMinute - Math.max(0, hours.cutoffMinutes);

  if (nowMinute < hours.openMinute) {
    return { open: false, reason: `Ordering opens at ${clockLabel(hours.openMinute)}.`, opensAtMinute: hours.openMinute };
  }
  if (nowMinute >= lastOrderMinute) {
    /* Named separately from "closed", because somebody standing outside at
       5:40 with the lights on deserves to be told why the button won't work
       rather than left thinking it's broken. */
    return nowMinute < hours.closeMinute
      ? { open: false, reason: `Last orders were ${clockLabel(lastOrderMinute)} — the stand is open until ${clockLabel(hours.closeMinute)} if you'd like to come in.` }
      : { open: false, reason: `Closed for the day. Ordering opens again at ${clockLabel(hours.openMinute)}.`, opensAtMinute: hours.openMinute };
  }
  return { open: true, lastOrderMinute };
}

/**
 * How many orders are ahead of this one.
 *
 * Counted among those still to be made, oldest first, and a drink that is
 * already READY is not ahead of anybody — it is sitting on the counter. Shown
 * to the customer so they stop ringing to ask.
 */
export function queuePosition(
  order: { id: string; createdAt: Date | string; status: string },
  live: { id: string; createdAt: Date | string; status: string }[]
): number {
  if (!isLive(order.status) || order.status === "READY") return 0;
  const at = new Date(order.createdAt).getTime();
  return live.filter(
    (o) =>
      o.id !== order.id &&
      (o.status === "PLACED" || o.status === "ACCEPTED") &&
      new Date(o.createdAt).getTime() < at
  ).length;
}

/** What the customer's page says, from the three fields. */
export function customerLine(o: {
  status: string;
  paidAt?: Date | string | null;
  arrivedAt?: Date | string | null;
  ahead: number;
}): string {
  if (o.status === "CANCELLED") return "This order was cancelled.";
  if (o.status === "NO_SHOW") return "Nobody collected this one — come in and ask at the counter.";
  if (o.status === "COLLECTED") return "Handed over. Enjoy.";
  if (o.arrivedAt && o.status === "READY") return "They know you're here — it's on its way out.";
  if (o.status === "READY") return o.arrivedAt ? "On its way out." : "Ready. Press the button when you pull up.";
  if (o.arrivedAt) return "They know you're here — still making it.";
  if (o.ahead > 0) return `${o.ahead} ${o.ahead === 1 ? "order" : "orders"} ahead of you.`;
  return o.status === "ACCEPTED" ? "Being made now." : "Order received.";
}

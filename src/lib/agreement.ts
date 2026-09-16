/**
 * Where a booth agreement has got to, derived once so the agreements table,
 * the applications pipeline and the onboarding list all say the same thing.
 */

export type DeliveryState = "DRAFT" | "SENT" | "OPENED" | "SIGNED" | "EXECUTED";

export type Delivery = {
  state: DeliveryState;
  /** Human label, so the UI never has to switch on the state itself. */
  label: string;
  sentAt: Date | null;
  viewedAt: Date | null;
  daysSinceSent: number | null;
  daysSinceOpened: number | null;
  /** Sent or opened, and sitting unsigned for a week or more. */
  stale: boolean;
};

const DAY_MS = 86_400_000;
export const STALE_DAYS = 7;

const wholeDaysSince = (d: Date | null): number | null =>
  d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY_MS)) : null;

const LABEL: Record<DeliveryState, string> = {
  DRAFT: "Not sent",
  SENT: "Sent, not opened",
  OPENED: "Opened, not signed",
  SIGNED: "Awaiting your signature",
  EXECUTED: "Fully signed",
};

/**
 * EXECUTED needs BOTH signatures. The market can countersign first, so keying
 * off marketSignedAt alone would label an agreement the vendor hasn't touched
 * as "fully signed". These states describe where the VENDOR is.
 *
 * CAVEAT: `sentAt` is `createdAt` — there is no sent-at column and we are not
 * adding one. Today the signing email goes out in the same request that creates
 * the agreement, so they are seconds apart; an agreement created now and sent
 * later would report as older than the vendor's reality. Read sentAt as "age of
 * the agreement", not "age of the email".
 */
export function deliveryFor(c: {
  signToken: string;
  viewedAt: Date | null;
  vendorSignedAt: Date | null;
  marketSignedAt: Date | null;
  createdAt: Date;
}): Delivery {
  const sent = c.signToken ? c.createdAt : null;
  const state: DeliveryState =
    c.marketSignedAt && c.vendorSignedAt ? "EXECUTED"
    : c.vendorSignedAt ? "SIGNED"
    : c.viewedAt ? "OPENED"
    : sent ? "SENT"
    : "DRAFT";

  const daysSinceSent = wholeDaysSince(sent);

  return {
    state,
    label: LABEL[state],
    sentAt: sent,
    viewedAt: c.viewedAt ?? null,
    daysSinceSent,
    daysSinceOpened: wholeDaysSince(c.viewedAt ?? null),
    stale:
      (state === "SENT" || state === "OPENED") &&
      daysSinceSent !== null &&
      daysSinceSent >= STALE_DAYS,
  };
}

/* ------------------------------------------------------- pipeline phase --- */

export type Phase = "NEW" | "IN_PROGRESS" | "LIVE" | "WITHDRAWN" | "DECLINED";

export const PHASE_LABEL: Record<Phase, string> = {
  NEW: "New applications",
  IN_PROGRESS: "Agreement in progress",
  LIVE: "Selling at the market",
  WITHDRAWN: "Backed out",
  DECLINED: "Declined",
};

/**
 * Which list an applicant belongs in.
 *
 * The old applications screen filtered these out the moment an agreement was
 * created (`where: { vendorId: "" }`), so anyone mid-process vanished — exactly
 * the people who need chasing.
 */
export function phaseFor(a: {
  status: string;
  vendorId: string;
  hasAgreement: boolean;
  vendorPortalLocked: boolean | null;
  /** Status of their most recent agreement, if any. */
  agreementStatus?: string | null;
}): Phase {
  /* Checked before DECLINED: someone who pulled out is a different thing from
     someone we turned down, and it's the one the office wants to see
     separately.

     TWO ways to back out, and both land here. An applicant can decide the
     market isn't for them before there is any agreement — that's the
     application's own status. Or a vendor with an agreement can withdraw after
     signing up — that's the agreement's status. Only the second existed
     before, so an applicant who changed their mind had nowhere to go but
     "Declined", which said we rejected them. */
  if (a.status === "WITHDRAWN" || a.agreementStatus === "WITHDRAWN") return "WITHDRAWN";
  if (a.status === "DECLINED") return "DECLINED";
  if (a.vendorId && a.vendorPortalLocked === false) return "LIVE";
  if (a.vendorId || a.hasAgreement) return "IN_PROGRESS";
  return "NEW";
}

/** The single next thing standing between them and selling. */
export function nextStepFor(
  phase: Phase,
  delivery: Delivery | null,
  owesCents: number
): string {
  if (phase === "WITHDRAWN") return "Backed out before starting";
  if (phase === "DECLINED") return "Declined";
  if (phase === "LIVE") return "Live at the market";
  if (!delivery) return "Create their agreement";
  switch (delivery.state) {
    case "DRAFT": return "Send the agreement for signature";
    case "SENT": return "Waiting on them to open it";
    case "OPENED": return "Waiting on their signature";
    case "SIGNED": return "Countersign it";
    case "EXECUTED": return owesCents > 0 ? "Waiting on first month's rent" : "Ready to go live";
  }
}

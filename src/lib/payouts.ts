import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";

/**
 * Paying vendors by bank transfer instead of by check.
 *
 * HOW THE MONEY ACTUALLY MOVES. Every sale in this market is charged on the
 * market's own Stripe account — the market is the merchant, the vendor's goods
 * are stock on its floor. So a payout is a `transfer` out of the market's
 * Stripe balance into the vendor's connected account, and Stripe's own payout
 * schedule then deposits that into their bank a day or two later. Stripe calls
 * this shape "separate charges and transfers", and it is the only one that fits
 * a market that rings everything through one till.
 *
 * WHAT THIS MEANS IN PRACTICE, and it is the thing to understand before
 * turning it on: transfers come out of the STRIPE BALANCE, not the bank
 * account. Card sales and card rent payments land there. CASH TAKEN AT THE
 * REGISTER DOES NOT. A market whose sales are mostly cash can therefore owe
 * vendors more than its Stripe balance holds, and the transfer simply fails
 * with "insufficient funds". That is not a bug to work around — it is the money
 * genuinely not being in that account yet, and the fix is either topping the
 * balance up from the bank or paying those vendors from the till. The admin
 * screen shows the balance next to the run total so this is visible BEFORE
 * anyone clicks pay.
 *
 * WHAT IS DELIBERATELY NOT STORED: the vendor's bank account. Stripe holds it.
 * This database keeps an account id and a yes/no. A copy of this database is
 * not a pile of bank details, and that is worth more than the convenience of
 * having them.
 */

/** Stripe's own charge, which is what the default fee mirrors. */
export const DEFAULT_FEE_PERCENT = 0.25;
export const DEFAULT_FEE_FIXED_CENTS = 25;

export type PayoutFee = { percent: number; fixedCents: number };

export async function getPayoutFee(): Promise<PayoutFee> {
  try {
    const rows = await db.setting.findMany({
      where: { key: { in: ["payoutFeePercent", "payoutFeeFixedCents"] } },
    });
    const get = (k: string) => {
      const v = Number(rows.find((r) => r.key === k)?.value);
      return Number.isFinite(v) && v >= 0 ? v : null;
    };
    return {
      percent: get("payoutFeePercent") ?? DEFAULT_FEE_PERCENT,
      fixedCents: Math.round(get("payoutFeeFixedCents") ?? DEFAULT_FEE_FIXED_CENTS),
    };
  } catch {
    return { percent: DEFAULT_FEE_PERCENT, fixedCents: DEFAULT_FEE_FIXED_CENTS };
  }
}

export async function setPayoutFee(percent: number, fixedCents: number): Promise<void> {
  const put = async (key: string, value: string) => {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  };
  await put("payoutFeePercent", String(Math.max(0, percent)));
  await put("payoutFeeFixedCents", String(Math.max(0, Math.round(fixedCents))));
}

/**
 * What the vendor is charged for a bank transfer, and what actually lands.
 *
 * Never more than the payout itself: a $0.20 balance must not produce a
 * negative transfer. A payout that can't cover its own fee is reported as
 * `sendableCents: 0` so the caller can hold it back rather than send nothing
 * and call it paid.
 */
export function feeFor(netCents: number, fee: PayoutFee): { feeCents: number; sendableCents: number } {
  if (netCents <= 0) return { feeCents: 0, sendableCents: 0 };
  const raw = Math.round((netCents * fee.percent) / 100) + fee.fixedCents;
  const feeCents = Math.min(raw, netCents);
  return { feeCents, sendableCents: netCents - feeCents };
}

/** Below this, a bank transfer costs more in fees and attention than it's worth. */
export const MIN_TRANSFER_CENTS = 100;

export type AccountStatus = {
  hasAccount: boolean;
  payoutsEnabled: boolean;
  /** Stripe is still waiting on something from them. */
  needsInfo: boolean;
  note: string;
};

/**
 * Ask Stripe where a vendor's onboarding actually stands, and write the answer
 * back to the vendor row.
 *
 * Read from Stripe rather than trusted from our own column, because the status
 * moves without anybody touching this app: a document expires, a verification
 * comes back, Stripe asks for more. The column is a cache for listing screens;
 * this is the truth.
 */
export async function refreshAccountStatus(vendorId: string): Promise<AccountStatus> {
  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { stripeAccountId: true, payoutsEnabled: true, payoutStatusNote: true },
  });
  if (!vendor?.stripeAccountId || !stripe) {
    return { hasAccount: false, payoutsEnabled: false, needsInfo: false, note: "" };
  }

  try {
    const acct = await stripe.accounts.retrieve(vendor.stripeAccountId);
    const enabled = !!acct.payouts_enabled && acct.capabilities?.transfers === "active";
    const due = [
      ...(acct.requirements?.currently_due || []),
      ...(acct.requirements?.past_due || []),
    ];
    const disabledReason = acct.requirements?.disabled_reason || "";

    const note = enabled
      ? ""
      : due.length
        ? `Stripe still needs: ${due.slice(0, 3).map(humanRequirement).join(", ")}`
        : disabledReason
          ? "Stripe is reviewing their details."
          : "Their setup isn't finished yet.";

    if (enabled !== vendor.payoutsEnabled || note !== vendor.payoutStatusNote) {
      await db.vendor.update({
        where: { id: vendorId },
        data: { payoutsEnabled: enabled, payoutStatusNote: note },
      });
    }
    return { hasAccount: true, payoutsEnabled: enabled, needsInfo: due.length > 0, note };
  } catch (err) {
    console.error("[payouts] couldn't read the connected account", vendorId, err);
    return {
      hasAccount: true,
      payoutsEnabled: vendor.payoutsEnabled,
      needsInfo: false,
      note: vendor.payoutStatusNote,
    };
  }
}

/** Stripe's requirement keys are machine names; vendors read these instead. */
function humanRequirement(key: string): string {
  const map: Record<string, string> = {
    "individual.verification.document": "a photo ID",
    "individual.id_number": "their SSN",
    "individual.ssn_last_4": "the last 4 of their SSN",
    "individual.dob.day": "their date of birth",
    "individual.address.line1": "their address",
    "external_account": "their bank account",
    "business_profile.url": "a website or product description",
    "business_profile.mcc": "what they sell",
    "tos_acceptance.date": "accepting Stripe's terms",
    "company.tax_id": "an EIN",
  };
  if (map[key]) return map[key];
  // Fall back to the last meaningful segment, tidied up.
  const tail = key.split(".").pop() || key;
  return tail.replace(/_/g, " ");
}

/**
 * The vendor's Express account, created on first use.
 *
 * Express rather than Standard: the vendor gets a Stripe-hosted form and a
 * simple dashboard of their own payouts, without needing a Stripe account or
 * understanding what Stripe is. `transfers` is the only capability requested —
 * this account receives money, it never charges anyone.
 */
export async function ensureConnectedAccount(vendorId: string): Promise<string> {
  if (!stripe) throw new Error("Stripe isn't configured.");
  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, email: true, businessName: true, code: true, stripeAccountId: true },
  });
  if (!vendor) throw new Error("Vendor not found.");
  if (vendor.stripeAccountId) return vendor.stripeAccountId;

  const acct = await stripe.accounts.create({
    type: "express",
    country: "US",
    email: vendor.email,
    business_profile: { name: vendor.businessName, product_description: "Goods sold at Community Harvest market" },
    capabilities: { transfers: { requested: true } },
    metadata: { vendorId: vendor.id, vendorCode: vendor.code },
  });

  await db.vendor.update({ where: { id: vendor.id }, data: { stripeAccountId: acct.id } });
  return acct.id;
}

/** A fresh onboarding link. They expire in minutes, so one is minted per click. */
export async function onboardingLink(vendorId: string, origin: string): Promise<string> {
  if (!stripe) throw new Error("Stripe isn't configured.");
  const accountId = await ensureConnectedAccount(vendorId);
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${origin}/vendor?payout=refresh`,
    return_url: `${origin}/vendor?payout=done`,
    type: "account_onboarding",
  });
  return link.url;
}

/** What the market can actually send right now. */
export async function stripeBalanceCents(): Promise<number | null> {
  if (!stripe) return null;
  try {
    const bal = await stripe.balance.retrieve();
    return bal.available.reduce((n, b) => n + (b.currency === "usd" ? b.amount : 0), 0);
  } catch {
    return null;
  }
}

export type TransferResult =
  | { ok: true; transferId: string; feeCents: number; sentCents: number }
  | { ok: false; error: string; code: "NO_ACCOUNT" | "NOT_ENABLED" | "TOO_SMALL" | "NO_FUNDS" | "FAILED" };

/**
 * Send one vendor their money.
 *
 * @param idempotencyKey the payout row's id — Stripe then refuses to create a
 *   second transfer for the same payout, whatever happens on this side of the
 *   call. Without it, a double-click or a retry after a timeout sends the money
 *   twice, and money sent twice does not come back on its own.
 */
export async function transferToVendor(
  vendorId: string,
  netCents: number,
  idempotencyKey: string,
  description: string
): Promise<TransferResult> {
  if (!stripe) return { ok: false, error: "Stripe isn't configured.", code: "FAILED" };

  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { stripeAccountId: true, payoutsEnabled: true, businessName: true },
  });
  if (!vendor?.stripeAccountId) {
    return { ok: false, error: `${vendor?.businessName || "That vendor"} hasn't connected a bank account yet.`, code: "NO_ACCOUNT" };
  }
  if (!vendor.payoutsEnabled) {
    return { ok: false, error: `Stripe hasn't finished verifying ${vendor.businessName} yet.`, code: "NOT_ENABLED" };
  }

  const fee = await getPayoutFee();
  const { feeCents, sendableCents } = feeFor(netCents, fee);
  if (sendableCents < MIN_TRANSFER_CENTS) {
    return { ok: false, error: `Too small to send by bank (${(sendableCents / 100).toFixed(2)} after the fee).`, code: "TOO_SMALL" };
  }

  try {
    const transfer = await stripe.transfers.create(
      {
        amount: sendableCents,
        currency: "usd",
        destination: vendor.stripeAccountId,
        description,
        metadata: { vendorId, feeCents: String(feeCents), grossCents: String(netCents) },
      },
      { idempotencyKey: `payout_${idempotencyKey}` }
    );
    return { ok: true, transferId: transfer.id, feeCents, sentCents: sendableCents };
  } catch (err) {
    const e = err as { code?: string; raw?: { message?: string }; message?: string };
    /* The one failure worth naming precisely. Everything else is logged and
       reported in general terms, because Stripe's messages can carry account
       details that don't belong on a screen. */
    if (e.code === "balance_insufficient") {
      return {
        ok: false,
        code: "NO_FUNDS",
        error: "Your Stripe balance doesn't cover this. Card sales fund it — cash taken at the register doesn't.",
      };
    }
    console.error("[payouts] transfer failed", { vendorId, sendableCents, err });
    return { ok: false, code: "FAILED", error: "Stripe wouldn't send that transfer. Nothing was paid." };
  }
}

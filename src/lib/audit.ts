import { db } from "@/lib/db";
import { isAdmin, currentEmployeeId, currentVendorId, verifyPin } from "@/lib/auth";
import { currentRole } from "@/lib/perm";
import { clientIp } from "@/lib/ratelimit";
import type { AuditAction } from "@/lib/auditkinds";

/**
 * The audit trail writer. SERVER ONLY — reads cookies and the database.
 * Client code that needs the labels imports @/lib/auditkinds.
 *
 * TWO RULES, both deliberate:
 *
 * 1. Writing an audit row NEVER fails the thing being audited. A refund that
 *    succeeded and then threw on the way to the log would leave the customer
 *    paid, the ledger reversed, and the operator staring at an error telling
 *    them to try again — which would double the refund. So every failure here
 *    is swallowed and logged to the server console instead.
 *
 * 2. It is written AFTER the action commits, not inside its transaction. An
 *    audit row for a transaction that rolled back is a record of something that
 *    never happened, which is worse than no record.
 */

export type AuditInput = {
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  /** Signed cents. Positive means money left the market. */
  amountCents?: number;
  detail?: string;
  before?: unknown;
  after?: unknown;
  approvedBy?: string;
};

export type AuditActor = {
  actorType: "STAFF" | "OWNER_KEY" | "VENDOR" | "SYSTEM";
  actorId: string;
  actorName: string;
  actorRole: string;
};

/** Who is making the current request, resolved from the session cookies. */
export async function currentAuditActor(): Promise<AuditActor> {
  try {
    const empId = currentEmployeeId();
    if (empId) {
      const emp = await db.employee.findUnique({ where: { id: empId }, select: { name: true, role: true } });
      return {
        actorType: "STAFF",
        actorId: empId,
        actorName: emp?.name || "Unknown employee",
        actorRole: String(emp?.role || ""),
      };
    }
    if (isAdmin()) {
      // The shared ADMIN_PASSWORD session isn't a person, and pretending it is
      // would put a name on a row nobody can stand behind.
      return { actorType: "OWNER_KEY", actorId: "", actorName: "", actorRole: "OWNER" };
    }
    const vendorId = currentVendorId();
    if (vendorId) {
      const v = await db.vendor.findUnique({ where: { id: vendorId }, select: { code: true, businessName: true } });
      return {
        actorType: "VENDOR",
        actorId: vendorId,
        actorName: v ? `${v.code} — ${v.businessName}` : "Vendor",
        actorRole: "VENDOR",
      };
    }
  } catch {
    /* fall through to SYSTEM */
  }
  return { actorType: "SYSTEM", actorId: "", actorName: "", actorRole: "" };
}

const trim = (v: unknown, max = 500): string => {
  if (v === undefined || v === null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * Record one event. Best-effort: never throws, never rejects.
 *
 * @param req passed when available, only so the caller's IP lands on the row.
 */
export async function recordAudit(input: AuditInput, req?: Request): Promise<void> {
  try {
    const actor = await currentAuditActor();
    await db.auditEvent.create({
      data: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorName: actor.actorName,
        actorRole: actor.actorRole,
        action: input.action,
        targetType: input.targetType || "",
        targetId: input.targetId || "",
        targetLabel: trim(input.targetLabel, 200),
        amountCents: Math.round(input.amountCents || 0),
        detail: trim(input.detail, 400),
        beforeJson: trim(input.before, 2000),
        afterJson: trim(input.after, 2000),
        approvedBy: trim(input.approvedBy, 120),
        ip: req ? clientIp(req) : "",
      },
    });
  } catch (err) {
    console.error("[audit] failed to record", input.action, err);
  }
}

/**
 * A SYSTEM-attributed event, for cron jobs and webhooks where there is no
 * session to read.
 */
export async function recordSystemAudit(input: AuditInput): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        actorType: "SYSTEM",
        action: input.action,
        targetType: input.targetType || "",
        targetId: input.targetId || "",
        targetLabel: trim(input.targetLabel, 200),
        amountCents: Math.round(input.amountCents || 0),
        detail: trim(input.detail, 400),
        beforeJson: trim(input.before, 2000),
        afterJson: trim(input.after, 2000),
      },
    });
  } catch (err) {
    console.error("[audit] failed to record system event", input.action, err);
  }
}

/* -------------------------------------------------------- manager approval -- */

/**
 * Money going back out over this amount needs a manager or owner PIN, on top of
 * whatever the person at the register is allowed to do on their own.
 *
 * Zero disables the check entirely. Unset means $50, which is low enough to
 * cover the everyday "my friend's ticket" refund and high enough not to make a
 * manager walk over for a $4 candle.
 */
export const DEFAULT_APPROVAL_CENTS = 5000;

export async function getApprovalThresholdCents(): Promise<number> {
  try {
    const row = await db.setting.findUnique({ where: { key: "refundApprovalCents" } });
    if (!row) return DEFAULT_APPROVAL_CENTS;
    const v = Number(row.value);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : DEFAULT_APPROVAL_CENTS;
  } catch {
    return DEFAULT_APPROVAL_CENTS;
  }
}

export async function setApprovalThresholdCents(cents: number): Promise<void> {
  const v = String(Math.max(0, Math.round(cents)));
  await db.setting.upsert({
    where: { key: "refundApprovalCents" },
    create: { key: "refundApprovalCents", value: v },
    update: { value: v },
  });
}

export type ApprovalResult =
  | { ok: true; approvedBy: string; required: boolean }
  | { ok: false; error: string; needsApproval: true };

/**
 * Decide whether this refund/void may go ahead, and by whose authority.
 *
 * An OWNER or MANAGER session authorises itself — making a manager type their
 * own PIN into their own session proves nothing. An EMPLOYEE over the threshold
 * has to have a manager or owner stand there and enter a PIN, and that person's
 * name goes on the audit row.
 *
 * PINs are salted scrypt hashes, so there is no way to look someone up BY their
 * PIN — every manager and owner is tried in turn. That is fine for a market's
 * handful of staff (the kiosk sign-in does the same thing) and would not be at
 * a hundred.
 */
export async function checkApproval(amountCents: number, pin: string): Promise<ApprovalResult> {
  const threshold = await getApprovalThresholdCents();
  const actor = await currentAuditActor();

  const selfAuthorised =
    actor.actorType === "OWNER_KEY" ||
    (await currentRole()) === "OWNER" ||
    (await currentRole()) === "MANAGER";

  if (threshold === 0 || Math.abs(amountCents) < threshold || selfAuthorised) {
    return {
      ok: true,
      required: false,
      approvedBy: actor.actorType === "OWNER_KEY" ? "Owner password" : actor.actorName,
    };
  }

  const entered = String(pin || "").trim();
  if (!entered) {
    return {
      ok: false,
      needsApproval: true,
      error: `Refunds of $${(threshold / 100).toFixed(2)} or more need a manager's PIN.`,
    };
  }

  const managers = await db.employee.findMany({
    where: { active: true, role: { in: ["OWNER", "MANAGER"] } },
    select: { id: true, name: true, pinHash: true },
  });
  const match = managers.find((m) => verifyPin(entered, m.pinHash));
  if (!match) {
    return { ok: false, needsApproval: true, error: "That PIN isn't a manager's or owner's." };
  }
  return { ok: true, required: true, approvedBy: match.name };
}

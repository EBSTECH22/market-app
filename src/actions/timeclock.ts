"use server";

import { prisma } from "@/lib/prisma";
import { getUser } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

async function requireAuth() {
  const user = await getUser();
  if (!user) redirect("/auth/login");
  const profile = await prisma.profile.findUnique({ where: { id: user.id } });
  if (!profile) redirect("/auth/login");
  return profile;
}

async function requireAdmin() {
  const profile = await requireAuth();
  if (profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER") throw new Error("Unauthorized");
  return profile;
}

async function sendPushToAdmins(title: string, body: string) {
  try {
    const webpush = require("web-push");
    const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
    const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
    webpush.setVapidDetails("mailto:Accounting@lightfootroofs.com", VAPID_PUBLIC, VAPID_PRIVATE);
    const admins = await prisma.profile.findMany({
      where: { role: { in: ["ADMIN", "OFFICE_MANAGER" as any] } },
      select: { id: true },
    });
    const subs = await prisma.pushSubscription.findMany({ where: { userId: { in: admins.map((a) => a.id) } } });
    const payload = JSON.stringify({ title, body, url: "/dashboard/timeclock" });
    await Promise.allSettled(
      subs.map((sub: any) =>
        webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload)
          .catch(async (err: any) => {
            if (err.statusCode === 410 || err.statusCode === 404)
              await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          })
      )
    );
  } catch (err) {
    console.error("Push error:", err);
  }
}

// ── Pay Period Config ──────────────────────────────────────────────────────

export interface PayPeriodConfig {
  lengthDays: number;   // 7 = weekly, 14 = bi-weekly
  anchorStart: string;  // UTC ISO of a known period start
}

export interface AutoSubmitConfig {
  globalEnabled: boolean;
  overrides: Record<string, boolean>; // userId → per-user override
}

const DEFAULT_PAY_PERIOD: PayPeriodConfig = {
  lengthDays: 7,
  anchorStart: "2025-01-01T21:00:00.000Z", // Wed Jan 1 2025 3PM CST
};

const DEFAULT_AUTO_SUBMIT: AutoSubmitConfig = {
  globalEnabled: true,
  overrides: {},
};

import { calcPeriod } from "@/lib/timeclock-utils";

export async function getPayPeriodConfig(): Promise<PayPeriodConfig> {
  try {
    const s = await (prisma as any).siteSetting.findUnique({ where: { key: "timeclock_pay_period" } });
    if (s) return { ...DEFAULT_PAY_PERIOD, ...JSON.parse(s.value) };
  } catch {}
  return DEFAULT_PAY_PERIOD;
}

export async function savePayPeriodConfig(config: PayPeriodConfig) {
  await requireAdmin();
  if (!config.anchorStart || !config.lengthDays) throw new Error("Invalid pay period config");
  await (prisma as any).siteSetting.upsert({
    where: { key: "timeclock_pay_period" },
    update: { value: JSON.stringify(config) },
    create: { key: "timeclock_pay_period", value: JSON.stringify(config) },
  });
  revalidatePath("/dashboard/timeclock");
  return { success: true };
}

export async function getAutoSubmitConfig(): Promise<AutoSubmitConfig> {
  try {
    const s = await (prisma as any).siteSetting.findUnique({ where: { key: "timeclock_auto_submit" } });
    if (s) return { ...DEFAULT_AUTO_SUBMIT, ...JSON.parse(s.value) };
  } catch {}
  return DEFAULT_AUTO_SUBMIT;
}

export async function saveAutoSubmitConfig(config: AutoSubmitConfig) {
  await requireAdmin();
  await (prisma as any).siteSetting.upsert({
    where: { key: "timeclock_auto_submit" },
    update: { value: JSON.stringify(config) },
    create: { key: "timeclock_auto_submit", value: JSON.stringify(config) },
  });
  revalidatePath("/dashboard/timeclock");
  return { success: true };
}

// ── Pay period helpers ────────────────────────────────────────────────────

export async function getCurrentPayPeriod() {
  const config = await getPayPeriodConfig();
  return calcPeriod(config);
}

export async function getPayPeriodForDate(date: Date) {
  const config = await getPayPeriodConfig();
  return calcPeriod(config, date);
}

// ── CLOCK IN ─────────────────────────────────────────────────────────────

export async function clockIn(propertyAddress: string) {
  const profile = await requireAuth();
  const isPureAdmin = profile.role === "ADMIN";
  const isAdminOrOM = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";

  if (!isAdminOrOM && !profile.timeclockEnabled) throw new Error("Timeclock access not enabled");

  // Admins are on the clock only when switched on for it. Owners who aren't on
  // payroll leave it off; admins who are get a rate and clock in like anyone
  // else. Without this an admin could clock in at $0 and produce hours that
  // look like payroll but pay nothing.
  if (isPureAdmin) {
    if (!profile.timeclockEnabled) {
      throw new Error("Timeclock isn't enabled for your account. Turn it on in Users to track paid hours.");
    }
    // No rate = hours tracking only: entries record at $0 and no paystub is
    // ever generated. Setting a rate in Users is what puts an admin on payroll.
  } else if (!profile.hourlyRate) {
    throw new Error("No hourly rate set. Contact your administrator.");
  }

  const active = await prisma.timeEntry.findFirst({ where: { userId: profile.id, clockOut: null } });
  if (active) throw new Error("Already clocked in. Clock out first.");

  await prisma.timeEntry.create({
    data: {
      userId: profile.id,
      propertyAddress,
      hourlyRate: profile.hourlyRate ?? 0,
      clockIn: new Date(),
    },
  });

  revalidatePath("/dashboard/timeclock");
  return { success: true };
}

// ── CLOCK OUT ────────────────────────────────────────────────────────────

export async function clockOut() {
  const profile = await requireAuth();
  const active = await prisma.timeEntry.findFirst({ where: { userId: profile.id, clockOut: null } });
  if (!active) throw new Error("Not currently clocked in.");
  await prisma.timeEntry.update({ where: { id: active.id }, data: { clockOut: new Date() } });
  revalidatePath("/dashboard/timeclock");
  return { success: true };
}

// ── GET ACTIVE CLOCK-IN ──────────────────────────────────────────────────

export async function getActiveClock() {
  const profile = await requireAuth();
  const active = await prisma.timeEntry.findFirst({ where: { userId: profile.id, clockOut: null } });
  return active ? JSON.parse(JSON.stringify(active)) : null;
}

// ── GET MY TIME ENTRIES FOR CURRENT PERIOD ───────────────────────────────

export async function getMyTimeEntries() {
  const profile = await requireAuth();
  const { start, end } = await getCurrentPayPeriod();

  const entries = await prisma.timeEntry.findMany({
    where: { userId: profile.id, clockIn: { gte: start, lt: end } },
    orderBy: { clockIn: "desc" },
  });

  return {
    entries: JSON.parse(JSON.stringify(entries)),
    profile: {
      id: profile.id,
      role: profile.role,
      timeclockEnabled: profile.timeclockEnabled,
      hourlyRate: profile.hourlyRate ? Number(profile.hourlyRate) : null,
    },
    period: { start: start.toISOString(), end: end.toISOString() },
  };
}

// ── ADMIN/OM: EDIT ANY ENTRY SILENTLY (no status change) ─────────────────

export async function adminEditTimeEntry(
  entryId: string,
  data: { propertyAddress?: string; clockIn?: string; clockOut?: string }
) {
  await requireAdmin();

  const entry = await prisma.timeEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new Error("Entry not found");

  const updateData: any = {};
  if (data.propertyAddress !== undefined) updateData.propertyAddress = data.propertyAddress;
  if (data.clockIn) updateData.clockIn = new Date(data.clockIn);
  if (data.clockOut) updateData.clockOut = new Date(data.clockOut);

  await prisma.timeEntry.update({ where: { id: entryId }, data: updateData });

  revalidatePath("/dashboard/timeclock");
  return { success: true };
}

// Legacy alias
export async function editTimeEntry(
  entryId: string,
  data: { propertyAddress?: string; clockIn?: string; clockOut?: string }
) {
  return adminEditTimeEntry(entryId, data);
}

// ── ADMIN/OM: DELETE ANY ENTRY ────────────────────────────────────────────

export async function deleteTimeEntry(entryId: string) {
  await requireAdmin();
  const entry = await prisma.timeEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new Error("Entry not found");
  await prisma.timeEntry.delete({ where: { id: entryId } });
  revalidatePath("/dashboard/timeclock");
  return { success: true };
}

// ── SUBMIT HOURS ─────────────────────────────────────────────────────────

export async function submitHours() {
  const profile = await requireAuth();
  const isAdminOrOM = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";
  if (!isAdminOrOM && !profile.timeclockEnabled) throw new Error("Timeclock not enabled");

  const { start, end } = await getCurrentPayPeriod();

  const entries = await prisma.timeEntry.findMany({
    where: {
      userId: profile.id,
      status: "DRAFT",
      clockIn: { gte: start, lt: end },
      clockOut: { not: null },
    },
  });

  if (entries.length === 0) throw new Error("No completed entries to submit");

  const timesheet = await prisma.timesheetSubmission.create({
    data: { userId: profile.id, periodStart: start, periodEnd: end },
  });

  await prisma.timeEntry.updateMany({
    where: { id: { in: entries.map((e) => e.id) } },
    data: { status: "SUBMITTED", timesheetId: timesheet.id },
  });

  const totalHours = entries.reduce((sum, e) => {
    return sum + (new Date(e.clockOut!).getTime() - new Date(e.clockIn).getTime()) / 3600000;
  }, 0);

  await sendPushToAdmins("Hours Submitted", `${profile.fullName} submitted ${totalHours.toFixed(1)} hours for review`);

  revalidatePath("/dashboard/timeclock");
  return { success: true };
}

// ── ADMIN: GET ALL PENDING TIMESHEETS ────────────────────────────────────

export async function getTimesheetsForAdmin() {
  await requireAdmin();

  const timesheets = await prisma.timesheetSubmission.findMany({
    include: {
      user: { select: { id: true, fullName: true, email: true, hourlyRate: true, role: true } },
      entries: { orderBy: { clockIn: "asc" } },
    },
    orderBy: { submittedAt: "desc" },
  });

  const timesheetIds = timesheets.map((t) => t.id);
  let paystubTimesheetIds: string[] = [];
  try {
    const paystubs = await (prisma as any).paystub.findMany({
      where: { timesheetId: { in: timesheetIds } },
      select: { timesheetId: true },
    });
    paystubTimesheetIds = paystubs.map((p: any) => p.timesheetId);
  } catch {}

  return JSON.parse(JSON.stringify(timesheets.map((t) => ({ ...t, hasPaystub: paystubTimesheetIds.includes(t.id) }))));
}

// ── ADMIN: APPROVE TIMESHEET ─────────────────────────────────────────────

export async function approveTimesheet(timesheetId: string) {
  const approver = await requireAdmin();

  // Nobody approves their own pay. An admin's timesheet can only be approved by
  // a different admin — not by themselves, and not by an office manager —
  // because approval is what generates the paystub.
  const sheet = await prisma.timesheetSubmission.findUnique({
    where: { id: timesheetId },
    select: { userId: true, user: { select: { role: true } } },
  });
  if (!sheet) throw new Error("Timesheet not found");
  if (sheet.userId === approver.id) {
    throw new Error("You can't approve your own timesheet. Another admin has to approve it.");
  }
  if (sheet.user?.role === "ADMIN" && approver.role !== "ADMIN") {
    throw new Error("An admin's timesheet has to be approved by another admin.");
  }

  await prisma.timeEntry.updateMany({
    where: { timesheetId, status: "SUBMITTED" },
    data: { status: "APPROVED" },
  });

  const rejected = await prisma.timeEntry.count({ where: { timesheetId, status: "REJECTED" } });

  await prisma.timesheetSubmission.update({
    where: { id: timesheetId },
    data: { status: rejected > 0 ? "PARTIAL" : "APPROVED", reviewedAt: new Date() },
  });

  try {
    const ts = await prisma.timesheetSubmission.findUnique({
      where: { id: timesheetId },
      select: { user: { select: { role: true, hourlyRate: true } } },
    });
    // Skip paystubs only for admins with no hourly rate (owners who aren't on payroll)
    if (ts?.user?.role !== "ADMIN" || Number(ts?.user?.hourlyRate || 0) > 0) {
      const { generatePaystub } = await import("@/actions/paystubs");
      await generatePaystub(timesheetId);
    }
  } catch (e) {
    console.error("Paystub generation failed:", e);
  }

  revalidatePath("/dashboard/timeclock");
  return { success: true };
}

// ── ADMIN: REJECT INDIVIDUAL ENTRY ──────────────────────────────────────

export async function rejectTimeEntry(entryId: string, reason: string) {
  await requireAdmin();
  if (!reason.trim()) throw new Error("Rejection reason is required");

  const entry = await prisma.timeEntry.update({
    where: { id: entryId },
    data: { status: "REJECTED", rejectReason: reason.trim() },
  });

  if (entry.timesheetId) {
    const remaining = await prisma.timeEntry.count({
      where: { timesheetId: entry.timesheetId, status: { not: "REJECTED" } },
    });
    if (remaining === 0) {
      await prisma.timesheetSubmission.update({
        where: { id: entry.timesheetId },
        data: { status: "REJECTED" as any, reviewedAt: new Date() },
      });
    }
  }

  revalidatePath("/dashboard/timeclock");
  revalidatePath("/dashboard");
  return { success: true };
}

// ── ADMIN: SET HOURLY RATE ───────────────────────────────────────────────

export async function setHourlyRate(userId: string, rate: number) {
  await requireAdmin();
  await prisma.profile.update({ where: { id: userId }, data: { hourlyRate: rate } });
  revalidatePath("/admin/users");
}

// ── ADMIN: TOGGLE TIMECLOCK ──────────────────────────────────────────────

export async function toggleTimeclock(userId: string) {
  await requireAdmin();
  const user = await prisma.profile.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");
  await prisma.profile.update({ where: { id: userId }, data: { timeclockEnabled: !user.timeclockEnabled } });
  revalidatePath("/admin/users");
}

// ── ADMIN/OM: GET TIMECLOCK USERS ────────────────────────────────────────

export async function getTimeclockUsers() {
  const profile = await requireAdmin();
  const isOM = (profile.role as string) === "OFFICE_MANAGER";

  const users = await prisma.profile.findMany({
    where: isOM
      ? { OR: [{ timeclockEnabled: true }, { role: "OFFICE_MANAGER" as any }] }
      : { OR: [{ timeclockEnabled: true }, { role: "ADMIN" }, { role: "OFFICE_MANAGER" as any }] },
    select: { id: true, fullName: true, role: true, hourlyRate: true, timeclockEnabled: true },
    orderBy: { fullName: "asc" },
  });

  return JSON.parse(JSON.stringify(users));
}

// ── ADMIN/OM: ADD ENTRY FOR A USER ──────────────────────────────────────

export async function addTimeEntryForUser(data: {
  userId: string;
  clockIn: string;
  clockOut: string;
  propertyAddress: string;
}) {
  const profile = await requireAdmin();
  const isOM = (profile.role as string) === "OFFICE_MANAGER";

  const target = await prisma.profile.findUnique({
    where: { id: data.userId },
    select: { id: true, fullName: true, role: true, hourlyRate: true },
  });
  if (!target) throw new Error("User not found");
  if (isOM && target.role !== "REP") throw new Error("Office Manager can only add entries for Reps");

  const clockIn = new Date(data.clockIn);
  const clockOut = new Date(data.clockOut);
  if (clockOut <= clockIn) throw new Error("Clock out must be after clock in");

  await prisma.timeEntry.create({
    data: {
      userId: data.userId,
      propertyAddress: data.propertyAddress || "Manual entry",
      hourlyRate: target.hourlyRate ?? 0,
      clockIn,
      clockOut,
      status: "DRAFT",
    },
  });

  revalidatePath("/dashboard/timeclock");
  return { success: true };
}

// ── ADMIN: CURRENTLY CLOCKED-IN USERS ───────────────────────────────────

export async function getActiveClockIns() {
  await requireAdmin();
  const entries = await prisma.timeEntry.findMany({
    where: { clockOut: null },
    include: { user: { select: { id: true, fullName: true, role: true, hourlyRate: true } } },
    orderBy: { clockIn: "asc" },
  });
  return JSON.parse(JSON.stringify(entries));
}

// ── ADMIN: DRAFT ENTRIES FOR CURRENT PERIOD ──────────────────────────────

export async function getDraftTimeEntries() {
  await requireAdmin();

  const entries = await prisma.timeEntry.findMany({
    where: { status: "DRAFT", clockOut: { not: null } },
    include: { user: { select: { id: true, fullName: true, role: true, hourlyRate: true } } },
    orderBy: [{ user: { fullName: "asc" } }, { clockIn: "desc" }],
  });
  return JSON.parse(JSON.stringify(entries));
}


// ── ADMIN/OM: ONE USER'S ENTRIES FOR ANY PAY PERIOD ──────────────────────
// anchorISO = any datetime inside the desired period. Returns the entries,
// the period bounds, and anchors for the previous/next periods so the UI
// can page backward and forward.

export async function getUserPeriodEntries(userId: string, anchorISO?: string) {
  await requireAdmin();
  const config = await getPayPeriodConfig();
  const anchor = anchorISO ? new Date(anchorISO) : new Date();
  const { start, end } = calcPeriod(config, anchor);

  const entries = await prisma.timeEntry.findMany({
    where: { userId, clockIn: { gte: start, lt: end } },
    orderBy: { clockIn: "desc" },
  });

  const prevAnchor = new Date(start.getTime() - 12 * 3600000);
  const nextAnchor = new Date(end.getTime() + 12 * 3600000);
  const now = new Date();

  return JSON.parse(JSON.stringify({
    entries,
    period: { start: start.toISOString(), end: end.toISOString() },
    prevAnchor: prevAnchor.toISOString(),
    nextAnchor: end < now ? nextAnchor.toISOString() : null,
    isCurrent: now >= start && now < end,
  }));
}

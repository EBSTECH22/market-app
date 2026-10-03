"use server";

import { createNotificationForAdmins, createNotification } from "@/actions/notifications"; // v2

import { prisma } from "@/lib/prisma";
import { parseDateInput } from "@/lib/date-input";
import { getUser } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  JobStage,
  JobType,
  JobSource,
  JobActivityType,
  JobFileCategory,
  SupplementStatus,
  WorksheetStatus,
  InvoiceStatus,
} from "@prisma/client";

// ─────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────

async function requireAuth() {
  const user = await getUser();
  if (!user) redirect("/auth/login");
  const profile = await prisma.profile.findUnique({ where: { id: user.id } });
  if (!profile) redirect("/auth/login");
  return profile;
}

async function requireAdmin() {
  const profile = await requireAuth();
  if (profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER") throw new Error("Unauthorized: Admin access required");
  return profile;
}

// ─────────────────────────────────────────────
// Push helpers
// ─────────────────────────────────────────────

async function sendPushToUser(userId: string, title: string, body: string, url = "/dashboard/crm") {
  // Always write to DB first — bell works even if push isn't configured
  await createNotification({ userId, title, body, url }).catch(() => {});
  try {
    const webpush = require("web-push");
    const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
    const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
    webpush.setVapidDetails("mailto:Accounting@lightfootroofs.com", VAPID_PUBLIC, VAPID_PRIVATE);

    const subs = await prisma.pushSubscription.findMany({ where: { userId } });
    const payload = JSON.stringify({ title, body: body.length > 120 ? body.slice(0, 120) + "..." : body, url });

    await Promise.allSettled(
      subs.map((sub: any) =>
        webpush
          .sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload)
          .catch(async (err: any) => {
            if (err.statusCode === 410 || err.statusCode === 404) {
              await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
            }
          })
      )
    );
  } catch (err) {
    console.error("Push error:", err);
  }
}

async function sendPushToAdmins(title: string, body: string, url = "/dashboard/crm") {
  // Always write to DB first — bell works even if push isn't configured
  await createNotificationForAdmins({ title, body, url }).catch(() => {});
  try {
    const webpush = require("web-push");
    const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
    const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
    webpush.setVapidDetails("mailto:Accounting@lightfootroofs.com", VAPID_PUBLIC, VAPID_PRIVATE);

    const admins = await prisma.profile.findMany({ where: { role: "ADMIN" }, select: { id: true } });
    const subs = await prisma.pushSubscription.findMany({
      where: { userId: { in: admins.map((a) => a.id) } },
    });
    const payload = JSON.stringify({ title, body: body.length > 120 ? body.slice(0, 120) + "..." : body, url });

    await Promise.allSettled(
      subs.map((sub: any) =>
        webpush
          .sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload)
          .catch(async (err: any) => {
            if (err.statusCode === 410 || err.statusCode === 404) {
              await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
            }
          })
      )
    );
  } catch (err) {
    console.error("Push error:", err);
  }
}

// ─────────────────────────────────────────────
// Activity log helper
// ─────────────────────────────────────────────

async function logActivity(
  jobId: string,
  type: JobActivityType,
  options: {
    userId?: string;
    body?: string;
    fromStage?: JobStage;
    toStage?: JobStage;
    fileId?: string;
    invoiceId?: string;
    isSystem?: boolean;
  } = {}
) {
  await prisma.jobActivity.create({
    data: {
      jobId,
      type,
      userId: options.userId ?? null,
      body: options.body ?? null,
      fromStage: options.fromStage ?? null,
      toStage: options.toStage ?? null,
      fileId: options.fileId ?? null,
      invoiceId: options.invoiceId ?? null,
      isSystem: options.isSystem ?? false,
    },
  });

  // Bump lastActivityAt on the job
  await prisma.job.update({
    where: { id: jobId },
    data: { lastActivityAt: new Date() },
  });
}

// ─────────────────────────────────────────────
// Stage ordering — for validation
// ─────────────────────────────────────────────

const STAGE_ORDER: JobStage[] = [
  "NEW_LEAD",
  "APPOINTMENT_SCHEDULED",
  "INSPECTED",
  "ESTIMATE_SENT",
  "APPROVED",
  "SUPPLEMENT",
  "SUPPLEMENT_APPROVED",
  "MATERIALS_ORDERED",
  "IN_PRODUCTION",
  "COMPLETED",
  "INVOICED",
  "COLLECTED",
  "CLOSED",
];

const TERMINAL_STAGES: JobStage[] = ["LOST", "CANCELLED"];

// ─────────────────────────────────────────────
// Permission check helper
// ─────────────────────────────────────────────

async function canViewSection(
  jobId: string,
  userId: string,
  role: string,
  section: string
): Promise<boolean> {
  if (role === "ADMIN" || role === "OFFICE_MANAGER") return true;
  // Check per-job override
  const override = await prisma.jobPermissionOverride.findUnique({
    where: { jobId_userId_section: { jobId, userId, section } },
  });
  return override?.canView ?? false;
}

// ─────────────────────────────────────────────
// Invoice number generator
// ─────────────────────────────────────────────

async function generateInvoiceNumber(): Promise<string> {
  // INV-MMYY-### — month/year of issue, sequence resets each calendar year
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const countThisYear = await prisma.invoice.count({ where: { createdAt: { gte: yearStart } } });
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  // Sequence starts at 101 each year so numbers never look like day-one volume
  return `INV-${mm}${yy}-${countThisYear + 101}`;
}

// ─────────────────────────────────────────────
// CREATE JOB
// ─────────────────────────────────────────────

export async function createJob(data: {
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  propertyStreet: string;
  propertyCity: string;
  propertyState: string;
  propertyZip: string;
  jobType: JobType;
  source?: JobSource;
  assignedToId?: string; // admin can assign; rep defaults to self
  notes?: string;
  leadId?: string;
  requestId?: string;
  // Insurance
  insuranceCompany?: string;
  claimNumber?: string;
  policyNumber?: string;
  deductible?: number;
  acv?: number;
  rcv?: number;
}) {
  const profile = await requireAuth();
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";

  // Reps can only create jobs assigned to themselves
  const assignedToId = isAdmin && data.assignedToId ? data.assignedToId : profile.id;

  const job = await prisma.job.create({
    data: {
      assignedToId,
      createdById: profile.id,
      customerName: data.customerName,
      customerPhone: data.customerPhone || null,
      customerEmail: data.customerEmail || null,
      propertyStreet: data.propertyStreet,
      propertyCity: data.propertyCity,
      propertyState: data.propertyState,
      propertyZip: data.propertyZip,
      jobType: data.jobType,
      source: data.source ?? "MANUAL",
      notes: data.notes || null,
      leadId: data.leadId || null,
      requestId: data.requestId || null,
      insuranceCompany: data.insuranceCompany || null,
      claimNumber: data.claimNumber || null,
      policyNumber: data.policyNumber || null,
      deductible: data.deductible ?? null,
      acv: data.acv ?? null,
      rcv: data.rcv ?? null,
      stage: "NEW_LEAD",
      lastActivityAt: new Date(),
      stageChangedAt: new Date(),
      stageChangedById: profile.id,
    },
  });

  // Log creation activity
  await logActivity(job.id, "JOB_CREATED", {
    userId: profile.id,
    body: `Job created by ${profile.fullName}${data.source === "COMPANY_LEAD" ? " from company lead" : ""}`,
    isSystem: false,
  });

  // If from a lead, link the lead record
  if (data.leadId) {
    await prisma.lead.update({
      where: { id: data.leadId },
      data: { jobId: job.id },
    }).catch(() => {});
  }

  // If from a partner request, link it
  if (data.requestId) {
    await prisma.inspectionRequest.update({
      where: { id: data.requestId },
      data: { jobId: job.id },
    }).catch(() => {});
  }

  // Notify admin if a rep created it
  if (!isAdmin) {
    await sendPushToAdmins(
      "New Pipeline Job",
      `${profile.fullName} created a new job: ${data.customerName} at ${data.propertyStreet}`,
      `/dashboard/crm/${job.id}`
    );
  }

  revalidatePath("/dashboard/crm");
  return { success: true, id: job.id };
}

// ─────────────────────────────────────────────
// AUTO-CREATE JOB FROM ACCEPTED COMPANY LEAD
// Called internally when a lead is accepted
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// CREATE LEGACY JOB (AccuLynx import / historical records)
// ─────────────────────────────────────────────
export async function createLegacyJob(data: {
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  propertyStreet: string;
  propertyCity: string;
  propertyState: string;
  propertyZip: string;
  jobType: JobType;
  assignedToId?: string;
  notes?: string;
  insuranceCompany?: string;
  claimNumber?: string;
  policyNumber?: string;
  deductible?: number;
  acv?: number;
  rcv?: number;
  stage?: JobStage;
  completedAt?: string;
  jobDate?: string;
}) {
  const profile = await requireAuth();
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";
  if (!isAdmin) throw new Error("Admin only");

  const assignedToId = data.assignedToId || profile.id;

  const job = await prisma.job.create({
    data: {
      customerName: data.customerName.trim(),
      customerPhone: data.customerPhone?.trim() || null,
      customerEmail: data.customerEmail?.trim() || null,
      propertyStreet: data.propertyStreet.trim(),
      propertyCity: data.propertyCity.trim(),
      propertyState: data.propertyState.trim(),
      propertyZip: data.propertyZip.trim(),
      jobType: data.jobType,
      source: "MANUAL" as JobSource,
      stage: (data.stage ?? "CLOSED") as JobStage,
      assignedToId,
      createdById: profile.id,
      isLegacy: true,
      ...(data.jobDate ? { createdAt: new Date(data.jobDate), lastActivityAt: new Date(data.jobDate) } : {}),
      insuranceCompany: data.insuranceCompany || null,
      claimNumber: data.claimNumber || null,
      policyNumber: data.policyNumber || null,
      deductible: data.deductible ?? null,
      acv: data.acv ?? null,
      rcv: data.rcv ?? null,
      notes: data.notes || null,
    },
  });

  await logActivity(job.id, "NOTE", {
    userId: profile.id,
    body: "Legacy job imported from AccuLynx",
    isSystem: true,
  });

  revalidatePath("/dashboard/crm");
  return { success: true, id: job.id };
}

export async function getLegacyJobs(search?: string) {
  await requireAdmin();
  const where: any = {
    isLegacy: true,
    ...(search ? { OR: [
      { customerName: { contains: search, mode: "insensitive" } },
      { propertyStreet: { contains: search, mode: "insensitive" } },
      { propertyCity: { contains: search, mode: "insensitive" } },
      { claimNumber: { contains: search, mode: "insensitive" } },
      { insuranceCompany: { contains: search, mode: "insensitive" } },
    ]} : {}),
  };
  const jobs = await prisma.job.findMany({
    where, orderBy: { createdAt: "desc" },
    include: {
      assignedTo: { select: { id: true, fullName: true } },
      invoices: { select: { id: true, status: true, amount: true } },
    },
  });
  return jobs.map(j => ({
    id: j.id, customerName: j.customerName, customerPhone: j.customerPhone,
    customerEmail: j.customerEmail, propertyStreet: j.propertyStreet,
    propertyCity: j.propertyCity, propertyState: j.propertyState,
    stage: j.stage, jobType: j.jobType, insuranceCompany: j.insuranceCompany,
    claimNumber: j.claimNumber, assignedTo: j.assignedTo,
    createdAt: j.createdAt.toISOString(),
    invoiceTotal: j.invoices.reduce((sum, inv) => sum + Number(inv.amount), 0),
    invoiceCount: j.invoices.length,
  }));
}

export async function createJobFromLead(leadId: string, acceptedById: string) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return;

  // Parse address into parts (best-effort; full parsing done in form if needed)
  const addressParts = lead.customerAddress.split(",").map((s) => s.trim());
  const propertyStreet = addressParts[0] || lead.customerAddress;
  const propertyCity = addressParts[1] || "";
  const stateZip = (addressParts[2] || "").split(" ").filter(Boolean);
  const propertyState = stateZip[0] || "";
  const propertyZip = stateZip[1] || "";

  const job = await prisma.job.create({
    data: {
      assignedToId: acceptedById,
      createdById: acceptedById,
      customerName: lead.customerName,
      customerPhone: lead.customerPhone || null,
      customerEmail: lead.customerEmail || null,
      propertyStreet,
      propertyCity,
      propertyState,
      propertyZip,
      jobType: "INSURANCE", // Company leads are typically insurance — rep can edit
      source: "COMPANY_LEAD",
      notes: lead.notes || null,
      leadId: lead.id,
      stage: "NEW_LEAD",
      lastActivityAt: new Date(),
      stageChangedAt: new Date(),
      stageChangedById: acceptedById,
      contactReminderSent: false,
    },
  });

  // Link lead back to job
  await prisma.lead.update({
    where: { id: leadId },
    data: { jobId: job.id },
  }).catch(() => {});

  // Log creation
  await logActivity(job.id, "JOB_CREATED", {
    userId: acceptedById,
    body: "Job auto-created from accepted company lead",
    isSystem: true,
  });

  await logActivity(job.id, "LEAD_LINKED", {
    userId: acceptedById,
    body: `Linked to lead: ${lead.customerName} at ${lead.customerAddress}`,
    isSystem: true,
  });

  // Push to rep: first contact reminder
  await sendPushToUser(
    acceptedById,
    "⚡ New Job — Contact Required Within 1 Hour",
    `You accepted a lead for ${lead.customerName}. Make first contact now and log it in the Pipeline.`,
    `/dashboard/crm/${job.id}`
  );

  // Schedule the 55-minute warning and 60-minute overdue flag
  // These are handled by the cron job checking firstContactAt IS NULL
  // and job.createdAt being within the window. No separate scheduling needed.

  // Notify admins
  await sendPushToAdmins(
    "Lead Accepted → Job Created",
    `New pipeline job created for ${lead.customerName} — assigned to rep.`,
    `/dashboard/crm/${job.id}`
  );

  return job;
}

// ─────────────────────────────────────────────
// GET JOBS LIST (Pipeline table)
// ─────────────────────────────────────────────

export async function getJobs(filters?: {
  stage?: JobStage;
  jobType?: JobType;
  assignedToId?: string;
  search?: string;
}) {
  const profile = await requireAuth();
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";

  const where: any = {
    isLegacy: false, // exclude legacy/archived jobs from pipeline
    ...(isAdmin ? {} : { assignedToId: profile.id }), // reps see only their own
    ...(filters?.stage ? { stage: filters.stage } : {}),
    ...(filters?.jobType ? { jobType: filters.jobType } : {}),
    ...(isAdmin && filters?.assignedToId ? { assignedToId: filters.assignedToId } : {}),
    ...(filters?.search
      ? {
          OR: [
            { customerName: { contains: filters.search, mode: "insensitive" } },
            { propertyStreet: { contains: filters.search, mode: "insensitive" } },
            { claimNumber: { contains: filters.search, mode: "insensitive" } },
            { insuranceCompany: { contains: filters.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const jobs = await prisma.job.findMany({
    where,
    orderBy: { createdAt: "desc" }, // newest first
    include: {
      assignedTo: { select: { id: true, fullName: true } },
      inspections: { select: { id: true }, take: 1 },
      invoices: { select: { id: true, status: true, amount: true } },
    },
  });

  const now = new Date();

  return {
    jobs: jobs.map((j) => {
      const daysSinceActivity = Math.floor(
        (now.getTime() - new Date(j.lastActivityAt).getTime()) / (1000 * 60 * 60 * 24)
      );
      const daysInStage = Math.floor(
        (now.getTime() - new Date(j.stageChangedAt).getTime()) / (1000 * 60 * 60 * 24)
      );
      const contactOverdue =
        !j.firstContactAt && j.source === "COMPANY_LEAD"
          ? Math.floor((now.getTime() - new Date(j.createdAt).getTime()) / (1000 * 60)) >= 60
          : false;

      return {
        id: j.id,
        createdAt: j.createdAt,
        customerName: j.customerName,
        customerPhone: j.customerPhone,
        customerEmail: j.customerEmail,
        propertyStreet: j.propertyStreet,
        propertyCity: j.propertyCity,
        propertyState: j.propertyState,
        stage: j.stage,
        jobType: j.jobType,
        source: j.source,
        assignedTo: j.assignedTo,
        insuranceCompany: j.insuranceCompany,
        claimNumber: j.claimNumber,
        hasInspection: j.inspections.length > 0,
        firstContactAt: j.firstContactAt,
        inspectionScheduledAt: j.inspectionScheduledAt,
        daysSinceActivity,
        daysInStage,
        needsFollowUp: daysSinceActivity >= 3 && !TERMINAL_STAGES.includes(j.stage) && j.stage !== "CLOSED",
        contactOverdue,
        invoiceSummary: {
          total: j.invoices.reduce((sum, inv) => sum + Number(inv.amount), 0),
          count: j.invoices.length,
          hasUnpaid: j.invoices.some((inv) => inv.status === "SENT" || inv.status === "OVERDUE"),
        },
      };
    }),
    profile: { id: profile.id, role: profile.role },
  };
}

// ─────────────────────────────────────────────
// GET SINGLE JOB (full detail for job file)
// ─────────────────────────────────────────────

export async function getJob(jobId: string) {
  const profile = await requireAuth();
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      assignedTo: { select: { id: true, fullName: true, email: true } },
      createdBy: { select: { id: true, fullName: true } },
      activities: {
        include: {
          user: { select: { id: true, fullName: true } },
          replies: {
            include: { user: { select: { id: true, fullName: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      },
      files: {
        include: { uploadedBy: { select: { id: true, fullName: true, role: true } } },
        orderBy: { createdAt: "desc" },
      },
      inspections: {
        select: {
          id: true,
          inspectionDate: true,
          overallCondition: true,
          recommendation: true,
          propertyStreet: true,
          status: true,
          user: { select: { fullName: true } },
        },
        orderBy: { createdAt: "desc" },
      },
      leads: {
        select: {
          id: true,
          customerName: true,
          customerAddress: true,
          createdAt: true,
          status: true,
        },
      },
      inspectionRequests: {
        select: {
          id: true,
          customerName: true,
          customerAddress: true,
          createdAt: true,
          status: true,
          partner: { select: { fullName: true } },
        },
      },
    },
  });

  if (!job) return null;

  // Reps can only see their own jobs
  if (!isAdmin && job.assignedToId !== profile.id) return null;

  // Check section permissions
  const canSeeCosts = await canViewSection(jobId, profile.id, profile.role, "costs");
  const canSeeInvoices = await canViewSection(jobId, profile.id, profile.role, "invoices");

  // Fetch worksheet (costs hidden from reps unless override)
  let worksheet = null;
  if (isAdmin || canSeeCosts) {
    worksheet = await prisma.financialWorksheet.findUnique({
      where: { jobId },
      include: { approvedBy: { select: { fullName: true } } },
    });
  } else {
    // Reps can see contract-level fields only (no costs, no margin)
    const ws = await prisma.financialWorksheet.findUnique({ where: { jobId } });
    if (ws) {
      worksheet = {
        id: ws.id,
        jobId: ws.jobId,
        contractPrice: ws.contractPrice,
        upgradeAmount: ws.upgradeAmount,
        discountAmount: ws.discountAmount,
        totalJobValue: ws.totalJobValue,
        totalSource: ws.totalSource,
        status: ws.status,
        notes: ws.notes,
        // costs hidden
        materialCost: null,
        laborCost: null,
        permitFees: null,
        otherCosts: null,
        totalCost: null,
        grossProfit: null,
        marginPercent: null,
      };
    }
  }

  // Fetch invoices (admin only unless override)
  let invoices: any[] = [];
  if (isAdmin || canSeeInvoices) {
    invoices = await prisma.invoice.findMany({
      where: { jobId },
      include: {
        lineItems: { orderBy: { sortOrder: "asc" } },
        payments: { orderBy: { paidAt: "asc" }, include: { receivedBy: { select: { fullName: true } } } },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  let estimates: any[] = [];
  if (isAdmin || job.assignedToId === profile.id) {
    const rawEstimates = await prisma.estimate.findMany({
      where: { jobId },
      include: {
        lineItems: { orderBy: { sortOrder: "asc" } },
        createdBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    estimates = rawEstimates.map((est) => ({
      ...est,
      lineItems: est.lineItems.map((item: any) => ({
        ...item,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        amount: Number(item.amount),
      })),
    }));
  }

  const now = new Date();
  const daysSinceActivity = Math.floor(
    (now.getTime() - new Date(job.lastActivityAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  return {
    job: {
      ...job,
      totalSquares: job.totalSquares ? Number(job.totalSquares) : null,
      daysSinceActivity,
      needsFollowUp: daysSinceActivity >= 3 && !TERMINAL_STAGES.includes(job.stage) && job.stage !== "CLOSED",
    },
    worksheet,
    invoices,
    estimates,
    permissions: {
      canSeeCosts: isAdmin || canSeeCosts,
      canSeeInvoices: isAdmin || canSeeInvoices,
      isAdmin,
    },
    profile: { id: profile.id, role: profile.role },
  };
}

// ─────────────────────────────────────────────
// UPDATE JOB (basic fields)
// ─────────────────────────────────────────────

export async function updateJob(
  jobId: string,
  data: {
    customerName?: string;
    customerPhone?: string | null;
    customerEmail?: string | null;
    propertyStreet?: string;
    propertyCity?: string;
    propertyState?: string;
    propertyZip?: string;
    jobType?: JobType;
    totalSquares?: number | null;
    notes?: string | null;
    assignedToId?: string; // admin only
    // Insurance fields
    insuranceCompany?: string | null;
    claimNumber?: string | null;
    policyNumber?: string | null;
    adjusterName?: string | null;
    adjusterPhone?: string | null;
    dateOfLoss?: Date | null;
    adjusterAppointmentAt?: Date | null;
    dateClaimFiled?: Date | null;
    deductible?: number | null;
    rcv?: number | null;
    acv?: number | null;
    depreciation?: number | null;
    supplementStatus?: SupplementStatus;
    supplementRequested?: number | null;
    supplementApproved?: number | null;
    supplementNotes?: string | null;
    supplementSubmittedAt?: Date | null;
    supplementApprovedAt?: Date | null;
    mortgageCompany?: string | null;
    mortgageLoanNumber?: string | null;
    mortgageContact?: string | null;
    supplementReminderSentAt?: Date | null;
    mortgageCheckStatus?: string | null;
    mortgageCheckSentAt?: Date | null;
    mortgageCheckReceivedAt?: Date | null;
    mortgageCheckNotes?: string | null;
  }
) {
  const profile = await requireAuth();
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  if (!isAdmin && job.assignedToId !== profile.id) throw new Error("Unauthorized");

  const updateData: any = { ...data };

  // Only admin can reassign
  if (!isAdmin) delete updateData.assignedToId;

  await prisma.job.update({ where: { id: jobId }, data: updateData });

  await logActivity(jobId, "NOTE", {
    userId: profile.id,
    body: `Job details updated by ${profile.fullName}`,
    isSystem: true,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  revalidatePath("/dashboard/crm");
  return { success: true };
}

// ─────────────────────────────────────────────
// ADVANCE / CHANGE STAGE
// ─────────────────────────────────────────────

export async function changeStage(
  jobId: string,
  newStage: JobStage,
  note?: string
) {
  const profile = await requireAuth();
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  // Reps can only change their own jobs
  if (!isAdmin && job.assignedToId !== profile.id) throw new Error("Unauthorized");

  const currentIndex = STAGE_ORDER.indexOf(job.stage);
  const newIndex = STAGE_ORDER.indexOf(newStage);
  const isTerminal = TERMINAL_STAGES.includes(newStage);

  // Reps can only move forward or to terminal stages
  if (!isAdmin) {
    if (!isTerminal && newIndex <= currentIndex) {
      throw new Error("You can only advance a job forward. Contact an admin to move it back.");
    }
    // Reps cannot jump more than 1 stage ahead (except to terminal)
    if (!isTerminal && newIndex > currentIndex + 1) {
      throw new Error("You can only advance one stage at a time. Contact an admin to skip stages.");
    }
  }

  // Reps cannot reopen terminal stages
  if (!isAdmin && TERMINAL_STAGES.includes(job.stage) && !isTerminal) {
    throw new Error("Contact an admin to reopen a closed, lost, or cancelled job.");
  }

  await prisma.job.update({
    where: { id: jobId },
    data: {
      stage: newStage,
      stageChangedAt: new Date(),
      stageChangedById: profile.id,
    },
  });

  const activityBody = note
    ? `Stage changed: ${job.stage} → ${newStage}. Note: ${note}`
    : `Stage changed: ${job.stage} → ${newStage}`;

  await logActivity(jobId, "STAGE_CHANGE", {
    userId: profile.id,
    body: activityBody,
    fromStage: job.stage,
    toStage: newStage,
    isSystem: false,
  });

  // Notify admins on every stage change
  await sendPushToAdmins(
    `Stage → ${newStage.replace(/_/g, " ")}`,
    `${job.customerName} at ${job.propertyStreet} — ${profile.fullName}`,
    `/dashboard/crm/${jobId}`
  );

  revalidatePath(`/dashboard/crm/${jobId}`);

  try {
    const { logAudit } = await import("@/actions/office-manager");
    await logAudit({ action: `Stage changed to ${newStage}`, entityType: "Job", entityId: jobId, entityLabel: job.customerName, userId: profile.id, userFullName: profile.fullName, userRole: profile.role });
  } catch {}

  revalidatePath("/dashboard/crm");
  return { success: true };
}

// ─────────────────────────────────────────────
// LOG FIRST CONTACT
// ─────────────────────────────────────────────

export async function logFirstContact(jobId: string) {
  const profile = await requireAuth();

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  if ((profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER") && job.assignedToId !== profile.id) throw new Error("Unauthorized");

  await prisma.job.update({
    where: { id: jobId },
    data: {
      firstContactAt: new Date(),
      firstContactOverdue: false,
    },
  });

  await logActivity(jobId, "CONTACT_LOGGED", {
    userId: profile.id,
    body: `First contact logged by ${profile.fullName}`,
    isSystem: false,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  revalidatePath("/dashboard/crm");
  return { success: true };
}

// ─────────────────────────────────────────────
// SCHEDULE INSPECTION
// ─────────────────────────────────────────────

export async function scheduleInspection(jobId: string, scheduledAt: Date) {
  const profile = await requireAuth();

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  if ((profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER") && job.assignedToId !== profile.id) throw new Error("Unauthorized");

  await prisma.job.update({
    where: { id: jobId },
    data: { inspectionScheduledAt: scheduledAt },
  });

  // Create appointment so it appears in the work calendar
  // First remove any existing inspection appointment for this job
  await prisma.appointment.deleteMany({
    where: { jobId, type: "INSPECTION" as any },
  });
  await prisma.appointment.create({
    data: {
      userId: job.assignedToId,
      createdById: profile.id,
      type: "INSPECTION" as any,
      title: `Inspection — ${job.customerName}`,
      scheduledAt,
      address: [job.propertyStreet, job.propertyCity, job.propertyState].filter(Boolean).join(", "),
      jobId,
      isShared: false,
    },
  });

  await logActivity(jobId, "INSPECTION_SCHEDULED", {
    userId: profile.id,
    body: `Inspection scheduled for ${scheduledAt.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`,
    isSystem: false,
  });

  // If stage is still NEW_LEAD, advance to APPOINTMENT_SCHEDULED
  if (job.stage === "NEW_LEAD") {
    await changeStage(jobId, "APPOINTMENT_SCHEDULED");
  }

  // Auto-create a draft Inspection record linked to this job if one doesn't exist yet
  const existingInspection = await prisma.inspection.findFirst({
    where: { jobId, status: { in: ["DRAFT" as any, "SUBMITTED" as any] } },
  });
  if (!existingInspection) {
    await prisma.inspection.create({
      data: {
        userId: job.assignedToId,
        status: "DRAFT" as any,
        inspectorName: "", // filled in when inspector completes the form
        customerName: job.customerName || "",
        customerEmail: job.customerEmail || "",
        customerPhone: job.customerPhone || "",
        inspectionDate: scheduledAt,
        scheduledAt,
        propertyStreet: job.propertyStreet || "",
        propertyCity: job.propertyCity || "",
        propertyState: job.propertyState || "OK",
        propertyZip: job.propertyZip || "",
        jobId,
      },
    });
  }

  revalidatePath(`/dashboard/crm/${jobId}`);
  revalidatePath("/dashboard/crm");
  revalidatePath("/dashboard/schedule");
  return { success: true };
}

export async function scheduleAdjusterMeeting(jobId: string, scheduledAt: Date) {
  const profile = await requireAuth();

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  if ((profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER") && job.assignedToId !== profile.id) throw new Error("Unauthorized");

  const dateStr = scheduledAt.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });

  // Stamp adjusterAppointmentAt on job
  await prisma.job.update({
    where: { id: jobId },
    data: { adjusterAppointmentAt: scheduledAt },
  });

  // Create calendar appointment
  await prisma.appointment.create({
    data: {
      userId: job.assignedToId,
      createdById: profile.id,
      type: "ADJUSTER",
      title: `Adjuster Meeting — ${job.customerName}`,
      scheduledAt,
      address: [job.propertyStreet, job.propertyCity, job.propertyState].filter(Boolean).join(", "),
      jobId,
      isShared: false,
    },
  });

  // Notify admins
  try {
    const { createNotificationForAdmins } = await import("@/actions/notifications");
    await createNotificationForAdmins({
      title: "📋 Adjuster Meeting Scheduled",
      body: `${profile.fullName} scheduled adjuster meeting for ${job.customerName} on ${dateStr}`,
      url: `/dashboard/crm/${jobId}`,
    });
  } catch {}

  await logActivity(jobId, "NOTE", {
    userId: profile.id,
    body: `Adjuster meeting scheduled for ${dateStr}`,
    isSystem: false,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/schedule");
  return { success: true };
}

// ─────────────────────────────────────────────
// UPDATE JOB REFERRAL SOURCE
// ─────────────────────────────────────────────

export async function updateJobReferralSource(jobId: string, referralSourceId: string | null) {
  const profile = await requireAuth();
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  if ((profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER") && job.assignedToId !== profile.id) throw new Error("Unauthorized");

  await prisma.job.update({
    where: { id: jobId },
    data: { referralSourceId: referralSourceId || null },
  });

  // Sync to all linked inspections that don't already have a referral source
  // or that had the previous referral source (keep it in sync)
  await prisma.inspection.updateMany({
    where: { jobId },
    data: { referralSourceId: referralSourceId || null },
  });

  await logActivity(jobId, "NOTE", {
    userId: profile.id,
    body: referralSourceId
      ? `Referral source linked`
      : `Referral source removed`,
    isSystem: true,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// ADD MANUAL ACTIVITY NOTE
// ─────────────────────────────────────────────

export async function addActivityNote(jobId: string, body: string) {
  const profile = await requireAuth();

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  if ((profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER") && job.assignedToId !== profile.id) throw new Error("Unauthorized");

  await logActivity(jobId, "NOTE", {
    userId: profile.id,
    body: body.trim(),
    isSystem: false,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// LINK INSPECTION TO JOB
// ─────────────────────────────────────────────

export async function linkInspectionToJob(jobId: string, inspectionId: string) {
  const profile = await requireAuth();

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  if ((profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER") && job.assignedToId !== profile.id) throw new Error("Unauthorized");

  const inspection = await prisma.inspection.findUnique({ where: { id: inspectionId } });
  if (!inspection) throw new Error("Inspection not found");

  await prisma.inspection.update({
    where: { id: inspectionId },
    data: { jobId },
  });

  await logActivity(jobId, "INSPECTION_LINKED", {
    userId: profile.id,
    body: `Inspection linked: ${inspection.propertyStreet}, ${inspection.propertyCity} on ${new Date(inspection.inspectionDate).toLocaleDateString()}`,
    isSystem: false,
  });

  // Advance stage if currently at APPOINTMENT_SCHEDULED
  if (job.stage === "APPOINTMENT_SCHEDULED") {
    await changeStage(jobId, "INSPECTED");
  }

  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// PERMISSION OVERRIDE (admin grants rep access to section)
// ─────────────────────────────────────────────

export async function grantSectionAccess(jobId: string, userId: string, section: string) {
  const admin = await requireAdmin();

  await prisma.jobPermissionOverride.upsert({
    where: { jobId_userId_section: { jobId, userId, section } },
    create: { jobId, userId, grantedById: admin.id, section, canView: true },
    update: { canView: true, grantedById: admin.id },
  });

  await logActivity(jobId, "PERMISSION_OVERRIDE", {
    userId: admin.id,
    body: `Admin granted "${section}" access to rep for this job`,
    isSystem: false,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true };
}

export async function revokeSectionAccess(jobId: string, userId: string, section: string) {
  await requireAdmin();

  await prisma.jobPermissionOverride.deleteMany({
    where: { jobId, userId, section },
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// FINANCIAL WORKSHEET
// ─────────────────────────────────────────────

export async function saveWorksheet(
  jobId: string,
  data: {
    contractPrice?: number | null;
    upgradeAmount?: number | null;
    discountAmount?: number | null;
    materialCost?: number | null;
    laborCost?: number | null;
    permitFees?: number | null;
    otherCosts?: number | null;
    notes?: string | null;
    contractPriceDesc?: string | null;
    upgradeAmountDesc?: string | null;
    discountAmountDesc?: string | null;
  }
) {
  const admin = await requireAdmin();

  // Auto-calculate totals
  const contractPrice = data.contractPrice ?? 0;
  const upgradeAmount = data.upgradeAmount ?? 0;
  const discountAmount = data.discountAmount ?? 0;
  const totalJobValue = contractPrice + upgradeAmount - discountAmount;

  const materialCost = data.materialCost ?? 0;
  const laborCost = data.laborCost ?? 0;
  const permitFees = data.permitFees ?? 0;
  const otherCosts = data.otherCosts ?? 0;
  const totalCost = materialCost + laborCost + permitFees + otherCosts;
  const grossProfit = totalJobValue - totalCost;
  const marginPercent = totalJobValue > 0 ? (grossProfit / totalJobValue) * 100 : 0;

  await prisma.financialWorksheet.upsert({
    where: { jobId },
    create: {
      jobId,
      contractPrice: data.contractPrice ?? null,
      upgradeAmount: data.upgradeAmount ?? null,
      discountAmount: data.discountAmount ?? null,
      totalJobValue: totalJobValue || null,
      totalSource: "MANUAL",
      materialCost: data.materialCost ?? null,
      laborCost: data.laborCost ?? null,
      permitFees: data.permitFees ?? null,
      otherCosts: data.otherCosts ?? null,
      totalCost: totalCost || null,
      grossProfit: grossProfit || null,
      marginPercent: marginPercent || null,
      notes: data.notes || null,
      contractPriceDesc: data.contractPriceDesc || null,
      upgradeAmountDesc: data.upgradeAmountDesc || null,
      discountAmountDesc: data.discountAmountDesc || null,
      status: "DRAFT",
    },
    update: {
      contractPrice: data.contractPrice ?? null,
      upgradeAmount: data.upgradeAmount ?? null,
      discountAmount: data.discountAmount ?? null,
      totalJobValue: totalJobValue || null,
      totalSource: "MANUAL",
      materialCost: data.materialCost ?? null,
      laborCost: data.laborCost ?? null,
      permitFees: data.permitFees ?? null,
      otherCosts: data.otherCosts ?? null,
      totalCost: totalCost || null,
      grossProfit: grossProfit || null,
      marginPercent: marginPercent || null,
      notes: data.notes || null,
      contractPriceDesc: data.contractPriceDesc || null,
      upgradeAmountDesc: data.upgradeAmountDesc || null,
      discountAmountDesc: data.discountAmountDesc || null,
    },
  });

  await logActivity(jobId, "NOTE", {
    userId: admin.id,
    body: `Financial worksheet updated by ${admin.fullName}`,
    isSystem: true,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true };
}

export async function approveWorksheet(jobId: string) {
  const admin = await requireAdmin();

  await prisma.financialWorksheet.update({
    where: { jobId },
    data: {
      status: "APPROVED",
      approvedById: admin.id,
      approvedAt: new Date(),
    },
  });

  await logActivity(jobId, "WORKSHEET_APPROVED", {
    userId: admin.id,
    body: `Financial worksheet approved by ${admin.fullName}`,
    isSystem: true,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// GENERATE INSURANCE PAYMENT SCHEDULE
// Invoice 1: greater of full ACV or 50% of contract
// Invoice 2: remaining balance
// ─────────────────────────────────────────────

export async function generateInsurancePaymentSchedule(jobId: string) {
  const admin = await requireAdmin();

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  const worksheet = await prisma.financialWorksheet.findUnique({ where: { jobId } });
  if (!worksheet) throw new Error("Financial worksheet must be saved before generating invoices");

  const totalJobValue = Number(worksheet.totalJobValue ?? 0);
  const acv = Number(job.acv ?? 0);
  const halfContract = totalJobValue * 0.5;

  if (totalJobValue <= 0) throw new Error("Total job value must be set in the financial worksheet");

  const invoice1Amount = Math.max(acv, halfContract);
  const invoice2Amount = totalJobValue - invoice1Amount;

  const invoice1Number = await generateInvoiceNumber();
  const invoice1 = await prisma.invoice.create({
    data: {
      jobId,
      worksheetId: worksheet.id,
      createdById: admin.id,
      invoiceNumber: invoice1Number,
      description: acv >= halfContract
        ? `Initial payment (ACV — ${invoice1Amount.toLocaleString("en-US", { style: "currency", currency: "USD" })})`
        : `Initial payment (50% of contract)`,
      amount: invoice1Amount,
      terms: "Due on receipt",
      status: "DRAFT",
      sequenceIndex: 1,
      isFinalInvoice: false,
    },
  });

  // Line items for invoice 1
  await prisma.invoiceLineItem.create({
    data: {
      invoiceId: invoice1.id,
      label: acv >= halfContract ? "Insurance ACV Payment" : "50% Down Payment",
      amount: invoice1Amount,
      sortOrder: 1,
    },
  });

  await logActivity(jobId, "INVOICE_CREATED", {
    userId: admin.id,
    invoiceId: invoice1.id,
    body: `Invoice ${invoice1Number} created — $${invoice1Amount.toLocaleString()} (${acv >= halfContract ? "ACV" : "50% of contract"})`,
    isSystem: false,
  });

  // Invoice 2 (final balance)
  if (invoice2Amount > 0) {
    const invoice2Number = await generateInvoiceNumber();
    const invoice2 = await prisma.invoice.create({
      data: {
        jobId,
        worksheetId: worksheet.id,
        createdById: admin.id,
        invoiceNumber: invoice2Number,
        description: "Final balance — due upon job completion",
        amount: invoice2Amount,
        terms: "Due on receipt — 10% late fee applies if unpaid 10 days after invoice sent",
        status: "DRAFT",
        sequenceIndex: 2,
        isFinalInvoice: true,
      },
    });

    await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice2.id,
        label: "Remaining Balance",
        amount: invoice2Amount,
        sortOrder: 1,
      },
    });

    await logActivity(jobId, "INVOICE_CREATED", {
      userId: admin.id,
      invoiceId: invoice2.id,
      body: `Invoice ${invoice2Number} created — $${invoice2Amount.toLocaleString()} (final balance)`,
      isSystem: false,
    });
  }

  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// GENERATE RETAIL PAYMENT SCHEDULE (50/50)
// ─────────────────────────────────────────────

export async function generateRetailPaymentSchedule(jobId: string) {
  const admin = await requireAdmin();

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  const worksheet = await prisma.financialWorksheet.findUnique({ where: { jobId } });
  if (!worksheet) throw new Error("Financial worksheet must be saved before generating invoices");

  const totalJobValue = Number(worksheet.totalJobValue ?? 0);
  if (totalJobValue <= 0) throw new Error("Total job value must be set in the financial worksheet");

  const halfAmount = totalJobValue * 0.5;

  const invoice1Number = await generateInvoiceNumber();
  const invoice1 = await prisma.invoice.create({
    data: {
      jobId,
      worksheetId: worksheet.id,
      createdById: admin.id,
      invoiceNumber: invoice1Number,
      description: "50% down payment — due before work begins",
      amount: halfAmount,
      terms: "Due on receipt",
      status: "DRAFT",
      sequenceIndex: 1,
      isFinalInvoice: false,
    },
  });

  await prisma.invoiceLineItem.create({
    data: {
      invoiceId: invoice1.id,
      label: "50% Down Payment",
      amount: halfAmount,
      sortOrder: 1,
    },
  });

  await logActivity(jobId, "INVOICE_CREATED", {
    userId: admin.id,
    invoiceId: invoice1.id,
    body: `Invoice ${invoice1Number} created — $${halfAmount.toLocaleString()} (50% down payment)`,
    isSystem: false,
  });

  const invoice2Number = await generateInvoiceNumber();
  const invoice2 = await prisma.invoice.create({
    data: {
      jobId,
      worksheetId: worksheet.id,
      createdById: admin.id,
      invoiceNumber: invoice2Number,
      description: "Final balance (50%) — due upon job completion",
      amount: halfAmount,
      terms: "Due on receipt — 10% late fee applies if unpaid 10 days after invoice sent",
      status: "DRAFT",
      sequenceIndex: 2,
      isFinalInvoice: true,
    },
  });

  await prisma.invoiceLineItem.create({
    data: {
      invoiceId: invoice2.id,
      label: "Final Balance (50%)",
      amount: halfAmount,
      sortOrder: 1,
    },
  });

  await logActivity(jobId, "INVOICE_CREATED", {
    userId: admin.id,
    invoiceId: invoice2.id,
    body: `Invoice ${invoice2Number} created — $${halfAmount.toLocaleString()} (final balance)`,
    isSystem: false,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// CREATE CUSTOM INVOICE
// ─────────────────────────────────────────────

export async function createCustomInvoice(
  jobId: string,
  data: {
    description: string;
    lineItems: { label: string; amount: number }[];
    dueDate?: Date | null;
    isFinalInvoice?: boolean;
    terms?: string;
  }
) {
  const admin = await requireAdmin();

  const worksheet = await prisma.financialWorksheet.findUnique({ where: { jobId } });
  const totalAmount = data.lineItems.reduce((sum, item) => sum + item.amount, 0);
  const invoiceNumber = await generateInvoiceNumber();

  const invoice = await prisma.invoice.create({
    data: {
      jobId,
      worksheetId: worksheet?.id ?? null,
      createdById: admin.id,
      invoiceNumber,
      description: data.description,
      amount: totalAmount,
      dueDate: data.dueDate ?? null,
      terms: data.terms ?? "Due on receipt",
      status: "DRAFT",
      isFinalInvoice: data.isFinalInvoice ?? false,
    },
  });

  await Promise.all(
    data.lineItems.map((item, index) =>
      prisma.invoiceLineItem.create({
        data: {
          invoiceId: invoice.id,
          label: item.label,
          amount: item.amount,
          sortOrder: index + 1,
        },
      })
    )
  );

  await logActivity(jobId, "INVOICE_CREATED", {
    userId: admin.id,
    invoiceId: invoice.id,
    body: `Invoice ${invoiceNumber} created — $${totalAmount.toLocaleString()} (custom)`,
    isSystem: false,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true, invoiceId: invoice.id };
}

// ─────────────────────────────────────────────
// UPDATE INVOICE (line items, description, etc.)
// ─────────────────────────────────────────────

export async function updateInvoice(
  invoiceId: string,
  data: {
    invoiceNumber?: string;
    description?: string;
    dueDate?: Date | null;
    terms?: string;
    isFinalInvoice?: boolean;
    lineItems?: { label: string; amount: number }[];
  }
) {
  const admin = await requireAdmin();

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status === "PAID" || invoice.status === "VOID") {
    throw new Error("Cannot edit a paid or voided invoice");
  }

  const updates: any = {};
  if (data.invoiceNumber !== undefined) updates.invoiceNumber = data.invoiceNumber.trim();
  if (data.description !== undefined) updates.description = data.description;
  if (data.dueDate !== undefined) updates.dueDate = data.dueDate;
  if (data.terms !== undefined) updates.terms = data.terms;
  if (data.isFinalInvoice !== undefined) updates.isFinalInvoice = data.isFinalInvoice;

  if (data.lineItems) {
    const total = data.lineItems.reduce((sum, item) => sum + item.amount, 0);
    updates.amount = total;

    // Replace line items
    await prisma.invoiceLineItem.deleteMany({ where: { invoiceId } });
    await Promise.all(
      data.lineItems.map((item, index) =>
        prisma.invoiceLineItem.create({
          data: { invoiceId, label: item.label, amount: item.amount, sortOrder: index + 1 },
        })
      )
    );
  }

  await prisma.invoice.update({ where: { id: invoiceId }, data: updates });

  await logActivity(invoice.jobId, "INVOICE_CREATED", {
    userId: admin.id,
    invoiceId,
    body: `Invoice ${invoice.invoiceNumber} updated by ${admin.fullName}`,
    isSystem: false,
  });

  revalidatePath(`/dashboard/crm/${invoice.jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// MARK INVOICE SENT
// ─────────────────────────────────────────────

export async function markInvoiceSent(invoiceId: string, sentToEmail: string) {
  const admin = await requireAdmin();

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Invoice not found");

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: "SENT",
      sentAt: new Date(),
      sentToEmail,
    },
  });

  await logActivity(invoice.jobId, "INVOICE_SENT", {
    userId: admin.id,
    invoiceId,
    body: `Invoice ${invoice.invoiceNumber} sent to ${sentToEmail}`,
    isSystem: false,
  });

  // If job stage is COMPLETED or later, advance to INVOICED
  const job = await prisma.job.findUnique({ where: { id: invoice.jobId } });
  if (job && (job.stage === "COMPLETED" || job.stage === "SUPPLEMENT_APPROVED" || job.stage === "MATERIALS_ORDERED")) {
    await changeStage(invoice.jobId, "INVOICED");
  }

  revalidatePath(`/dashboard/crm/${invoice.jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// MARK INVOICE PAID
// ─────────────────────────────────────────────

export async function markInvoicePaid(invoiceId: string, paidAmount?: number) {
  const admin = await requireAdmin();

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Invoice not found");

  const amount = paidAmount ?? Number(invoice.amount);

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: "PAID",
      paidAt: new Date(),
      paidAmount: amount,
    },
  });

  await logActivity(invoice.jobId, "INVOICE_PAID", {
    userId: admin.id,
    invoiceId,
    body: `Invoice ${invoice.invoiceNumber} marked paid — $${amount.toLocaleString()}`,
    isSystem: false,
  });

  // If non-final invoice paid, make commission draw eligible
  if (!invoice.isFinalInvoice) {
    try {
      const { markCommissionsDrawEligible } = await import("@/actions/commissions");
      await markCommissionsDrawEligible(invoice.jobId);
    } catch (commErr) {
      console.error("Commission draw eligible update failed:", commErr);
    }
  }

  // If this is the final invoice and it's paid, suggest COLLECTED stage
  if (invoice.isFinalInvoice) {
    const job = await prisma.job.findUnique({ where: { id: invoice.jobId } });
    if (job && job.stage === "INVOICED") {
      await changeStage(invoice.jobId, "COLLECTED");
    }
    // Mark commissions payable since final invoice is now paid
    try {
      const { markCommissionsPayable } = await import("@/actions/commissions");
      await markCommissionsPayable(invoice.jobId, new Date());
    } catch (commErr) {
      console.error("Commission payable update failed:", commErr);
    }
  }

  revalidatePath(`/dashboard/crm/${invoice.jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// VOID INVOICE
// ─────────────────────────────────────────────

export async function voidInvoice(invoiceId: string) {
  const admin = await requireAdmin();

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status === "PAID") throw new Error("Cannot void a paid invoice");

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: "VOID" },
  });

  await logActivity(invoice.jobId, "INVOICE_CREATED", {
    userId: admin.id,
    invoiceId,
    body: `Invoice ${invoice.invoiceNumber} voided by ${admin.fullName}`,
    isSystem: false,
  });


  try {
    const { logAudit } = await import("@/actions/office-manager");
    await logAudit({ action: `Voided Invoice ${invoice.invoiceNumber}`, entityType: "Invoice", entityId: invoice.id, entityLabel: invoice.invoiceNumber, userId: admin.id, userFullName: admin.fullName, userRole: admin.role });
  } catch {}

  revalidatePath(`/dashboard/crm/${invoice.jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// WAIVE LATE FEE
// ─────────────────────────────────────────────

export async function waiveLateFee(invoiceId: string, reason: string) {
  const admin = await requireAdmin();

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Invoice not found");

  // Remove the late fee line item
  await prisma.invoiceLineItem.deleteMany({
    where: { invoiceId, isLateFee: true },
  });

  // Recalculate total
  const remainingItems = await prisma.invoiceLineItem.findMany({ where: { invoiceId } });
  const newTotal = remainingItems.reduce((sum, item) => sum + Number(item.amount), 0);

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      lateFeeWaived: true,
      lateFeeWaivedById: admin.id,
      lateFeeWaivedNote: reason,
      amount: newTotal > 0 ? newTotal : invoice.amount,
    },
  });

  await logActivity(invoice.jobId, "NOTE", {
    userId: admin.id,
    invoiceId,
    body: `Late fee waived on invoice ${invoice.invoiceNumber}. Reason: ${reason}`,
    isSystem: false,
  });

  revalidatePath(`/dashboard/crm/${invoice.jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// GET ADMIN PIPELINE STATS
// ─────────────────────────────────────────────

export async function getPipelineStats() {
  await requireAdmin();

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  const [
    totalActive,
    newLeadsThisWeek,
    awaitingApproval,
    inProduction,
    completedNotInvoiced,
    overdue,
  ] = await Promise.all([
    prisma.job.count({
      where: { stage: { notIn: ["CLOSED", "LOST", "CANCELLED"] } },
    }),
    prisma.job.count({
      where: { createdAt: { gte: weekAgo } },
    }),
    prisma.job.count({
      where: { stage: "ESTIMATE_SENT" },
    }),
    prisma.job.count({
      where: { stage: "IN_PRODUCTION" },
    }),
    prisma.job.count({
      where: { stage: "COMPLETED" },
    }),
    prisma.job.count({
      where: {
        lastActivityAt: { lt: threeDaysAgo },
        stage: { notIn: ["CLOSED", "LOST", "CANCELLED"] },
      },
    }),
  ]);

  return {
    totalActive,
    newLeadsThisWeek,
    awaitingApproval,
    inProduction,
    completedNotInvoiced,
    overdue,
  };
}

// ─────────────────────────────────────────────
// GET REPS (for admin assign dropdown)
// ─────────────────────────────────────────────

export async function getReps() {
  await requireAdmin();

  return prisma.profile.findMany({
    where: { role: { in: ["REP", "ADMIN"] } },
    select: { id: true, fullName: true, role: true },
    orderBy: { fullName: "asc" },
  });
}

// ─────────────────────────────────────────────
// DELETE JOB (admin only — soft via CANCELLED)
// ─────────────────────────────────────────────

export async function deleteJob(jobId: string) {
  const admin = await requireAdmin();

  // Never hard delete — mark as CANCELLED instead
  await prisma.job.update({
    where: { id: jobId },
    data: {
      stage: "CANCELLED",
      stageChangedAt: new Date(),
      stageChangedById: admin.id,
    },
  });

  await logActivity(jobId, "STAGE_CHANGE", {
    userId: admin.id,
    body: `Job cancelled and removed from pipeline by ${admin.fullName}`,
    isSystem: true,
  });

  revalidatePath("/dashboard/crm");
  return { success: true };
}

export async function hardDeleteJob(jobId: string) {
  const admin = await requireAdmin();

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  // Delete work order children first
  const workOrders = await prisma.workOrder.findMany({
    where: { jobId },
    select: { id: true },
  });
  const woIds = workOrders.map(w => w.id);
  if (woIds.length > 0) {
    await prisma.crewPayment.deleteMany({ where: { workOrderId: { in: woIds } } });
    await prisma.lienWaiver.deleteMany({ where: { workOrderId: { in: woIds } } });
    await prisma.punchListItem.deleteMany({ where: { workOrderId: { in: woIds } } });
    await prisma.workOrderPhoto.deleteMany({ where: { workOrderId: { in: woIds } } });
    await prisma.crewJobNote.deleteMany({ where: { workOrderId: { in: woIds } } });
    await prisma.crewJobChat.deleteMany({ where: { workOrderId: { in: woIds } } });
    await prisma.crewRating.deleteMany({ where: { workOrderId: { in: woIds } } });
    await prisma.workOrderTerm.deleteMany({ where: { workOrderId: { in: woIds } } });
  }
  await prisma.workOrder.deleteMany({ where: { jobId } });

  // Estimates
  const estimates = await prisma.estimate.findMany({ where: { jobId }, select: { id: true } });
  const estIds = estimates.map(e => e.id);
  if (estIds.length > 0) {
    await prisma.estimateLineItem.deleteMany({ where: { estimateId: { in: estIds } } });
  }
  await prisma.estimate.deleteMany({ where: { jobId } });

  // Contracts
  const contracts = await prisma.contract.findMany({ where: { jobId }, select: { id: true } });
  const conIds = contracts.map(c => c.id);
  if (conIds.length > 0) {
    await prisma.contractLineItem.deleteMany({ where: { contractId: { in: conIds } } });
    await (prisma as any).contractChangeOrderLineItem.deleteMany({ where: { changeOrder: { contractId: { in: conIds } } } });
    await prisma.contractChangeOrder.deleteMany({ where: { contractId: { in: conIds } } });
  }
  await prisma.contract.deleteMany({ where: { jobId } });

  // Everything else
  // CollectionAttempts link to invoices — delete before invoices
  const jobInvoices = await prisma.invoice.findMany({ where: { jobId }, select: { id: true } });
  const invIds = jobInvoices.map(i => i.id);
  if (invIds.length > 0) {
    await prisma.collectionAttempt.deleteMany({ where: { invoiceId: { in: invIds } } });
  }
  await prisma.invoice.deleteMany({ where: { jobId } });
  await prisma.payment.deleteMany({ where: { jobId } });
  await prisma.financialWorksheet.deleteMany({ where: { jobId } });
  // Contingency + tarp agreements link to Inspection — delete them but leave inspections intact
  const jobInspections = await prisma.inspection.findMany({ where: { jobId }, select: { id: true } });
  const inspIds = jobInspections.map(i => i.id);
  if (inspIds.length > 0) {
    await prisma.contingencyAgreement.deleteMany({ where: { inspectionId: { in: inspIds } } });
    await prisma.emergencyTarpAgreement.deleteMany({ where: { inspectionId: { in: inspIds } } }).catch(() => {});
  }
  await prisma.jobFile.deleteMany({ where: { jobId } });
  await prisma.jobActivity.deleteMany({ where: { jobId } });
  await prisma.jobPermissionOverride.deleteMany({ where: { jobId } });
  await prisma.task.deleteMany({ where: { jobId } });
  await prisma.pmJobAssignment.deleteMany({ where: { jobId } });
  // CollectionAttempt links to Invoice — handled before invoice delete above

  // Finally delete the job itself
  await prisma.job.delete({ where: { id: jobId } });


  try {
    const { logAudit } = await import("@/actions/office-manager");
    await logAudit({ action: "Deleted Job", entityType: "Job", entityId: jobId, entityLabel: job.customerName, userId: admin.id, userFullName: admin.fullName, userRole: admin.role });
  } catch {}

  revalidatePath("/dashboard/crm");
  revalidatePath("/dashboard");
  return { success: true };
}

// ─────────────────────────────────────────────
// ADD JOB COMMUNICATION
// ─────────────────────────────────────────────

export async function addJobCommunication(jobId: string, type: string, body: string) {
  const profile = await requireAuth();

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  const typeMap: Record<string, string> = {
    CALL: "📞 Call logged",
    EMAIL: "✉️ Email logged",
    TEXT: "💬 Text logged",
    IN_PERSON: "🤝 In-person meeting logged",
    NOTE: "📝 Note added",
  };

  await logActivity(jobId, "CONTACT_LOGGED", {
    userId: profile.id,
    body: `[${type}] ${body.trim()}`,
    isSystem: false,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// APPOINTMENTS
// ─────────────────────────────────────────────

export async function createAppointment(data: {
  type: string;
  title: string;
  scheduledAt: string;
  notes?: string;
  jobId?: string;
}) {
  const profile = await requireAuth();

  const appt = await prisma.appointment.create({
    data: {
      userId: profile.id,
      type: data.type as any,
      title: data.title.trim(),
      scheduledAt: new Date(data.scheduledAt),
      notes: data.notes?.trim() || null,
      jobId: data.jobId || null,
    },
  });

  revalidatePath("/dashboard/schedule");
  return appt;
}

export async function getAppointments(showAll = false) {
  const profile = await requireAuth();
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";

  const where: any = {};
  if (!isAdmin || !showAll) {
    where.userId = profile.id;
  }

  return prisma.appointment.findMany({
    where,
    orderBy: { scheduledAt: "asc" },
    include: {
      user: { select: { fullName: true, role: true } },
      job: { select: { id: true, customerName: true, propertyStreet: true, propertyCity: true } },
    },
  });
}

export async function deleteAppointment(id: string) {
  const profile = await requireAuth();
  const appt = await prisma.appointment.findUnique({ where: { id } });
  if (!appt) throw new Error("Not found");
  if (appt.userId !== profile.id && (profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER")) throw new Error("Unauthorized");
  await prisma.appointment.delete({ where: { id } });
  revalidatePath("/dashboard/schedule");
  return { success: true };
}

export async function updateAppointment(id: string, data: {
  scheduledAt?: string;
  notes?: string;
  title?: string;
}) {
  const profile = await requireAuth();
  const appt = await prisma.appointment.findUnique({ where: { id } });
  if (!appt) throw new Error("Not found");
  if (appt.userId !== profile.id && (profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER")) throw new Error("Unauthorized");

  await prisma.appointment.update({
    where: { id },
    data: {
      ...(data.scheduledAt ? { scheduledAt: new Date(data.scheduledAt) } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.title ? { title: data.title } : {}),
    },
  });

  revalidatePath("/dashboard/schedule");
  return { success: true };
}

// ─────────────────────────────────────────────
// ESTIMATES
// ─────────────────────────────────────────────

const ESTIMATE_DEFAULTS = {
  contractPriceDesc: "Roof replacement per agreed scope of work",
  upgradeAmountDesc: "Material upgrades and additional scope",
  discountAmountDesc: "Applied discount",
  materialCostDesc: "Roofing materials — shingles, underlayment, flashing, ridge cap",
  laborCostDesc: "Labor and installation",
  permitFeesDesc: "Building permit fees",
  otherCostsDesc: "Miscellaneous project costs",
};

async function generateEstimateNumber(): Promise<string> {
  const year = new Date().getFullYear().toString().slice(-2); // "26" for 2026
  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const yearEnd = new Date(new Date().getFullYear() + 1, 0, 1);
  const count = await prisma.estimate.count({
    where: { createdAt: { gte: yearStart, lt: yearEnd } },
  });
  return `${year}${String(count + 1).padStart(2, "0")}`;
}

export async function createEstimate(jobId: string) {
  const profile = await requireAuth();

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  const estimateNumber = await generateEstimateNumber();

  // Start blank — admin builds from price catalog
  const lineItems: { label: string; description: string; quantity: number; unitType: string; unitPrice: number; amount: number; sortOrder: number; isWarranty: boolean }[] = [];

  // Warranty line items (always included, can be toggled on estimate)
  lineItems.push({
    label: "GAF System Plus Warranty",
    description: "GAF System Plus Limited Warranty — 50-year non-prorated Smart Choice® Protection covering 100% of manufacturing defects on shingles and qualifying accessories, including labor and tear-off costs. Must be registered within 45 days of installation.",
    quantity: 1,
    unitType: "each",
    unitPrice: 0,
    amount: 0,
    sortOrder: 90,
    isWarranty: true,
  });
  lineItems.push({
    label: "5-Year Labor Warranty",
    description: "5-Year Workmanship Warranty provided by Lightfoot Roofs — covers all labor and installation",
    quantity: 1,
    unitType: "each",
    unitPrice: 0,
    amount: 0,
    sortOrder: 91,
    isWarranty: true,
  });

  const crypto = await import("crypto");
  const signingToken = crypto.randomBytes(32).toString("hex");

  const estimate = await prisma.estimate.create({
    data: {
      jobId,
      createdById: profile.id,
      estimateNumber,
      status: "DRAFT",
      includeGafWarranty: true,
      includeLaborWarranty: true,
      includeFinancing: false,
      signingToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      lineItems: {
        create: lineItems,
      },
    },
    include: { lineItems: true },
  });

  await logActivity(jobId, "NOTE", {
    userId: profile.id,
    body: `Estimate ${estimateNumber} created`,
    isSystem: true,
  });

  revalidatePath(`/dashboard/crm/${jobId}`);
  return estimate;
}

export async function getEstimates(jobId: string) {
  await requireAdmin();
  return prisma.estimate.findMany({
    where: { jobId },
    include: {
      lineItems: { orderBy: { sortOrder: "asc" } },
      createdBy: { select: { fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateEstimate(estimateId: string, data: {
  includeGafWarranty?: boolean;
  includeLaborWarranty?: boolean;
  includeFinancing?: boolean;
  notes?: string;
  lineItems?: { id: string; label: string; description?: string; quantity?: number; unitType?: string; unitPrice?: number; amount: number }[];
  addItem?: { label: string; description?: string; quantity: number; unitType: string; unitPrice: number; amount: number; sortOrder?: number };
  deleteItemId?: string;
}) {
  const profile = await requireAuth();

  await prisma.estimate.update({
    where: { id: estimateId },
    data: {
      ...(data.includeGafWarranty !== undefined ? { includeGafWarranty: data.includeGafWarranty } : {}),
      ...(data.includeLaborWarranty !== undefined ? { includeLaborWarranty: data.includeLaborWarranty } : {}),
      ...(data.includeFinancing !== undefined ? { includeFinancing: data.includeFinancing } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
  });

  if (data.lineItems) {
    for (const item of data.lineItems) {
      if (item.id.startsWith("new-")) {
        // New item from catalog — create it
        const existing = await prisma.estimate.findUnique({
          where: { id: estimateId },
          include: { lineItems: { select: { sortOrder: true } } },
        });
        const maxOrder = existing?.lineItems.reduce((max: number, i: any) => Math.max(max, i.sortOrder), 0) ?? 0;
        await prisma.estimateLineItem.create({
          data: {
            estimateId,
            label: item.label,
            description: item.description ?? null,
            quantity: item.quantity ?? 1,
            unitType: item.unitType ?? "each",
            unitPrice: item.unitPrice ?? 0,
            amount: item.amount,
            sortOrder: maxOrder + 1,
            isWarranty: false,
          },
        });
      } else {
        await prisma.estimateLineItem.update({
          where: { id: item.id },
          data: {
            label: item.label,
            description: item.description ?? null,
            quantity: item.quantity ?? 1,
            unitType: item.unitType ?? "each",
            unitPrice: item.unitPrice ?? item.amount,
            amount: item.amount,
          },
        });
      }
    }
  }

  if (data.addItem) {
    const estimate = await prisma.estimate.findUnique({
      where: { id: estimateId },
      include: { lineItems: { select: { sortOrder: true } } },
    });
    const maxOrder = estimate?.lineItems.reduce((max, i) => Math.max(max, i.sortOrder), 0) ?? 0;
    await prisma.estimateLineItem.create({
      data: {
        estimateId,
        label: data.addItem.label,
        description: data.addItem.description ?? null,
        quantity: data.addItem.quantity,
        unitType: data.addItem.unitType,
        unitPrice: data.addItem.unitPrice,
        amount: data.addItem.amount,
        sortOrder: data.addItem.sortOrder ?? maxOrder + 1,
        isWarranty: false,
      },
    });
  }

  if (data.deleteItemId) {
    await prisma.estimateLineItem.delete({ where: { id: data.deleteItemId } });
  }

  // Auto-update financial worksheet from estimate total
  // Only if no signed contract exists and no manual override
  try {
    const estimate = await prisma.estimate.findUnique({
      where: { id: estimateId },
      include: { lineItems: true },
    });
    if (estimate) {
      const signedContract = await prisma.contract.findFirst({
        where: { jobId: estimate.jobId, status: "SIGNED" },
      });
      if (!signedContract) {
        const estimateTotal = estimate.lineItems
          .filter((li: any) => !li.isWarranty)
          .reduce((sum: number, li: any) => sum + Number(li.amount), 0);
        if (estimateTotal > 0) {
          const existing = await prisma.financialWorksheet.findUnique({
            where: { jobId: estimate.jobId },
          });
          if (!existing || existing.totalSource !== "MANUAL") {
            await prisma.financialWorksheet.upsert({
              where: { jobId: estimate.jobId },
              update: { totalJobValue: estimateTotal, totalSource: "ESTIMATE" },
              create: {
                jobId: estimate.jobId,
                totalJobValue: estimateTotal,
                totalSource: "ESTIMATE",
                status: "DRAFT",
              },
            });
          }
        }
      }
    }
  } catch (wsErr) {
    console.error("Failed to update worksheet from estimate:", wsErr);
  }

  revalidatePath(`/dashboard/crm`);
  return { success: true };
}

export async function sendEstimate(estimateId: string, toEmail: string) {
  const profile = await requireAuth();

  const estimate = await prisma.estimate.findUnique({
    where: { id: estimateId },
    include: {
      job: { select: { id: true, customerName: true, propertyStreet: true, propertyCity: true } },
      lineItems: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!estimate) throw new Error("Estimate not found");

  const signingUrl = `${process.env.NEXT_PUBLIC_APP_URL}/estimate/${estimate.signingToken}`;

  // Send email
  const nodemailerMod = await import("nodemailer");
  const transporter = nodemailerMod.default.createTransport({
    service: "gmail",
    auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASSWORD },
  });

  const total = estimate.lineItems
    .filter(i => !i.isWarranty)
    .reduce((sum, i) => sum + Number(i.amount), 0);

  await transporter.sendMail({
    from: `"Lightfoot Roofs" <accounting@lightfootroofs.com>`,
    to: toEmail,
    subject: `Your Estimate from Lightfoot Roofs — ${estimate.estimateNumber}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <img src="https://app.lightfootroofsinspections.com/logo-email.png" alt="Lightfoot Roofs" width="600" style="display:block;width:100%;max-width:600px;border-radius:8px 8px 0 0" />
        <div style="background:#f9fafb;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb">
          <h2 style="color:#111827">Hello ${estimate.job.customerName},</h2>
          <p style="color:#374151">Please find your estimate for the roofing project at <strong>${estimate.job.propertyStreet}, ${estimate.job.propertyCity}</strong>.</p>
          <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0">
            <p style="margin:0;color:#6b7280;font-size:14px">Estimate Total</p>
            <p style="margin:4px 0;font-size:28px;font-weight:bold;color:#111827">${total.toLocaleString("en-US", { style: "currency", currency: "USD" })}</p>
            <p style="margin:0;color:#6b7280;font-size:12px">Estimate #${estimate.estimateNumber}</p>
          </div>
          <p style="color:#374151">To review and sign your estimate, click the button below:</p>
          <a href="${signingUrl}" style="display:inline-block;background:#DC2626;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin:8px 0">Review & Sign Estimate</a>
          <p style="color:#6b7280;font-size:12px;margin-top:24px">This estimate is available to sign for 30 days. Questions? Contact us at accounting@lightfootroofs.com</p>
          <p style="color:#6b7280;font-size:12px">Lightfoot Roofs | Edmond, Oklahoma</p>
        </div>
      </div>
    `,
  });

  await prisma.estimate.update({
    where: { id: estimateId },
    data: { status: "SENT", sentAt: new Date(), sentToEmail: toEmail },
  });

  // Notify referral source partner if job has one
  try {
    const job = await prisma.job.findUnique({
      where: { id: estimate.job.id },
      include: {
        inspections: {
          include: {
            referralSource: {
              include: { partnerProfile: { select: { email: true, fullName: true } } },
            },
          },
          take: 1,
        },
      },
    });

    const partnerEmail = job?.inspections?.[0]?.referralSource?.partnerProfile?.email;
    const partnerName = job?.inspections?.[0]?.referralSource?.partnerProfile?.fullName;
    if (partnerEmail) {
      const nodemailerMod2 = await import("nodemailer");
      const transporter2 = nodemailerMod2.default.createTransport({
        service: "gmail",
        auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASSWORD },
      });
      await transporter2.sendMail({
        from: `"Lightfoot Roofs" <accounting@lightfootroofs.com>`,
        to: partnerEmail,
        subject: `Estimate Sent — ${estimate.job.customerName} at ${estimate.job.propertyStreet}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <img src="https://app.lightfootroofsinspections.com/logo-email.png" alt="Lightfoot Roofs" width="600" style="display:block;width:100%;max-width:600px;border-radius:8px 8px 0 0" />
          <div style="background:white;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
            <p style="color:#374151">Hi${partnerName ? " " + partnerName : ""},</p>
            <p style="color:#374151">We wanted to let you know that an estimate has been sent to your referral, <strong>${estimate.job.customerName}</strong>, for the project at ${estimate.job.propertyStreet}, ${estimate.job.propertyCity}.</p>
            <p style="color:#374151">We will keep you updated as the project progresses. Thank you for your continued partnership with Lightfoot Roofs!</p>
            <p style="color:#9ca3af;font-size:12px">Lightfoot Roofs · 2236 NW 164th St, Ste 12, Edmond OK, 73013 · (405) 834-4799</p>
          </div>
        </div>`,
      });
    }
  } catch (partnerEmailErr) {
    console.error("Partner estimate-sent notification failed:", partnerEmailErr);
  }

  revalidatePath(`/dashboard/crm/${estimate.job.id}`);
  return { success: true };
}

export async function getEstimateByToken(token: string) {
  return prisma.estimate.findFirst({
    where: { signingToken: token },
    include: {
      job: { select: { customerName: true, propertyStreet: true, propertyCity: true, propertyState: true, propertyZip: true } },
      lineItems: { orderBy: { sortOrder: "asc" } },
      createdBy: { select: { fullName: true } },
    },
  });
}


// ─────────────────────────────────────────────
// NOTIFY ADMINS: estimate signing link opened
// ─────────────────────────────────────────────

export async function notifyEstimateOpened(token: string) {
  try {
    const estimate = await prisma.estimate.findFirst({
      where: { signingToken: token },
      include: {
        job: { select: { id: true, customerName: true, propertyStreet: true } },
      },
    });
    if (!estimate) return;
    // Don't notify if already signed
    if (estimate.status === "SIGNED") return;

    // Rate limit: only notify once per hour per estimate
    // Check if we already sent a notification for this estimate in the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentNotif = await prisma.notification.findFirst({
      where: {
        title: "👀 Estimate Opened",
        body: { contains: estimate.estimateNumber },
        createdAt: { gte: oneHourAgo },
      },
    });
    if (recentNotif) return; // Already notified within the last hour

    await sendPushToAdmins(
      "👀 Estimate Opened",
      `${estimate.job.customerName} opened ${estimate.estimateNumber} — ${estimate.job.propertyStreet}`,
      `/dashboard/crm/${estimate.job.id}`
    );
  } catch (err) {
    console.error("notifyEstimateOpened error:", err);
  }
}

export async function signEstimate(token: string, signedByName: string, signedByIp: string, signatureImage?: string) {
  const estimate = await prisma.estimate.findFirst({
    where: { signingToken: token },
    include: { lineItems: true },
  });
  if (!estimate) throw new Error("Estimate not found");
  if (estimate.status === "SIGNED") throw new Error("Already signed");
  if (estimate.expiresAt && estimate.expiresAt < new Date()) throw new Error("The signing period for this estimate has expired. Please contact us for a new estimate.");

  await prisma.estimate.update({
    where: { id: estimate.id },
    data: {
      status: "SIGNED",
      signedAt: new Date(),
      signedByName,
      signedByIp: signedByIp || null,
      signatureImage: signatureImage || null,
    },
  });

  // Auto-populate financial worksheet if no signed contract exists
  try {
    const signedContracts = await prisma.contract.findFirst({
      where: { jobId: estimate.jobId, status: "SIGNED" },
    });
    if (!signedContracts) {
      const estimateTotal = estimate.lineItems
        .filter((li: any) => !li.isWarranty)
        .reduce((sum: number, li: any) => sum + Number(li.amount), 0);
      if (estimateTotal > 0) {
        const existing = await prisma.financialWorksheet.findUnique({
          where: { jobId: estimate.jobId },
        });
        // Only auto-populate if no manual override exists
        if (!existing || existing.totalSource !== "MANUAL") {
          await prisma.financialWorksheet.upsert({
            where: { jobId: estimate.jobId },
            update: { totalJobValue: estimateTotal, totalSource: "ESTIMATE" },
            create: {
              jobId: estimate.jobId,
              totalJobValue: estimateTotal,
              totalSource: "ESTIMATE",
              status: "DRAFT",
            },
          });
        }
      }
    }
  } catch (wsErr) {
    console.error("Failed to auto-populate worksheet from estimate:", wsErr);
  }

  // Log activity
  await prisma.jobActivity.create({
    data: {
      jobId: estimate.jobId,
      type: "NOTE",
      body: `Estimate ${estimate.estimateNumber} signed by ${signedByName}`,
      isSystem: true,
    },
  });

  // Push notification to admins on signing
  try {
    const signedJob = await prisma.job.findUnique({
      where: { id: estimate.jobId },
      select: { customerName: true, propertyStreet: true },
    });
    if (signedJob) {
      await sendPushToAdmins(
        "✍️ Estimate Signed",
        `${signedByName} signed ${estimate.estimateNumber} — ${signedJob.propertyStreet}`,
        `/dashboard/crm/${estimate.jobId}`
      );
    }
  } catch {}

  // Push notification — rep + admins
  try {
    const job = await prisma.job.findUnique({
      where: { id: estimate.jobId },
      select: { assignedToId: true, customerName: true },
    });
    const pushTitle = "✍️ Estimate Signed";
    const pushBody = `${signedByName} signed estimate ${estimate.estimateNumber}${job?.customerName ? " for " + job.customerName : ""}.`;
    const pushUrl = `/dashboard/crm/${estimate.jobId}`;
    if (job?.assignedToId) {
      await sendPushToUser(job.assignedToId, pushTitle, pushBody, pushUrl);
    }
    await sendPushToAdmins(pushTitle, pushBody, pushUrl);
  } catch (pushErr) {
    console.error("Estimate signed push failed:", pushErr);
  }

  // Send welcome email with estimate copy
  try {
    const fullEstimate = await prisma.estimate.findUnique({
      where: { id: estimate.id },
      include: {
        lineItems: { orderBy: { sortOrder: "asc" } },
        job: { select: { customerName: true, customerEmail: true, propertyStreet: true, propertyCity: true, propertyState: true } },
      },
    });

    if (fullEstimate?.job?.customerEmail) {
      const nodemailerMod = await import("nodemailer");
      const transporter = nodemailerMod.default.createTransport({
        service: "gmail",
        auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASSWORD },
      });
      const lineItems = fullEstimate.lineItems.filter((i: any) => !i.isWarranty);
      const warrantyItems = fullEstimate.lineItems.filter((i: any) => i.isWarranty);
      const total = lineItems.reduce((sum: number, i: any) => sum + Number(i.amount), 0);
      const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

      const lineItemRows = lineItems.map((item: any) => `
        <tr style="border-bottom:1px solid #f3f4f6">
          <td style="padding:12px 16px">
            <div style="font-size:14px;font-weight:600;color:#111827">${item.label}</div>
            ${item.description ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${item.description}</div>` : ""}
          </td>
          <td style="padding:12px 16px;text-align:right;font-size:14px;font-weight:700;color:#111827;white-space:nowrap">${fmt(Number(item.amount))}</td>
        </tr>
      `).join("");

      const warrantyRows = warrantyItems.filter((i: any) =>
        (i.label.includes("GAF") && fullEstimate.includeGafWarranty) ||
        (i.label.includes("Labor") && fullEstimate.includeLaborWarranty)
      ).map((item: any) => `
        <tr>
          <td style="padding:8px 16px;display:flex;align-items:flex-start;gap:8px">
            <span style="color:#1d4ed8;font-weight:700;font-size:14px">✓</span>
            <div>
              <div style="font-size:13px;font-weight:600;color:#1e40af">${item.label}</div>
              ${item.description ? `<div style="font-size:11px;color:#3b82f6;margin-top:2px">${item.description}</div>` : ""}
            </div>
          </td>
          <td style="padding:8px 16px;text-align:right;font-size:12px;font-weight:700;color:#1d4ed8;white-space:nowrap">Included</td>
        </tr>
      `).join("");

      await transporter.sendMail({
        from: `"Lightfoot Roofs" <accounting@lightfootroofs.com>`,
        to: fullEstimate.job.customerEmail,
        subject: `Welcome to the Lightfoot Family — Your Signed Estimate ${fullEstimate.estimateNumber}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb">
            <img src="https://app.lightfootroofsinspections.com/logo-email.png" alt="Lightfoot Roofs" width="600" style="display:block;width:100%;max-width:600px;border-radius:8px 8px 0 0" />
            <div style="background:white;padding:32px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
              <h2 style="color:#111827;margin:0 0 8px">Welcome to the Lightfoot Family, ${fullEstimate.job.customerName}! 🏠</h2>
              <p style="color:#374151;font-size:14px;margin:0 0 24px">Thank you for choosing Lightfoot Roofs. Your signed estimate is below for your records. We will be in touch shortly to schedule your project.</p>

              <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px;overflow:hidden">
                <div style="padding:12px 16px;border-bottom:1px solid #e5e7eb">
                  <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">Estimate ${fullEstimate.estimateNumber}</div>
                  <div style="font-size:12px;color:#6b7280;margin-top:2px">${fullEstimate.job.propertyStreet}, ${fullEstimate.job.propertyCity}, ${fullEstimate.job.propertyState}</div>
                  <div style="font-size:11px;color:#9ca3af;margin-top:2px">Signed by ${signedByName} on ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
                </div>
                <table style="width:100%;border-collapse:collapse">
                  ${lineItemRows}
                  <tr style="background:#f9fafb;border-top:2px solid #e5e7eb">
                    <td style="padding:14px 16px;font-size:15px;font-weight:700;color:#111827">Total</td>
                    <td style="padding:14px 16px;text-align:right;font-size:18px;font-weight:700;color:#111827">${fmt(total)}</td>
                  </tr>
                </table>
              </div>

              ${warrantyRows ? `
              <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin-bottom:24px">
                <div style="font-size:13px;font-weight:700;color:#1e3a8a;margin-bottom:12px">✓ Included Warranties</div>
                <table style="width:100%;border-collapse:collapse">${warrantyRows}</table>
              </div>` : ""}

              <div style="background:#f9fafb;border-radius:8px;padding:16px;text-align:center;margin-bottom:24px">
                <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.lightfootroofsinspections.com'}/estimate/${fullEstimate.signingToken}" target="_blank" style="display:inline-block;background:#111827;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;margin-bottom:6px">View &amp; Print Signed Estimate</a><br/><span style="font-size:11px;color:#9ca3af">Click to open your signed estimate — use browser Print to save as PDF</span>
              <p style="color:#374151;font-size:14px;margin:0 0 4px">Questions? We are here to help.</p>
                <p style="color:#dc2626;font-size:16px;font-weight:700;margin:0">(405) 834-4799</p>
                <p style="color:#6b7280;font-size:12px;margin:4px 0 0">accounting@lightfootroofs.com</p>
              </div>

              <p style="color:#9ca3af;font-size:11px;text-align:center;margin:0">Lightfoot Roofs · 2236 NW 164th St, Ste 12, Edmond OK, 73013 · LightfootRoofs.com</p>
            </div>
          </div>
        `,
      });
    }
  } catch (emailErr) {
    console.error("Welcome email failed:", emailErr);
  }

  // Notify assigned rep + admins + referral source partner
  try {
    const fullJob = await prisma.job.findUnique({
      where: { id: estimate.jobId },
      include: {
        assignedTo: { select: { email: true, fullName: true } },
        inspections: {
          include: {
            referralSource: {
              include: { partnerProfile: { select: { email: true, fullName: true } } },
            },
          },
          take: 1,
        },
      },
    });

    const admins = await prisma.profile.findMany({
      where: { role: "ADMIN" },
      select: { email: true, fullName: true },
    });

    const nodemailerNotify = await import("nodemailer");
    const notifyTransporter = nodemailerNotify.default.createTransport({
      service: "gmail",
      auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASSWORD },
    });

    const internalHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <img src="https://app.lightfootroofsinspections.com/logo-email.png" alt="Lightfoot Roofs" width="600" style="display:block;width:100%;max-width:600px;border-radius:8px 8px 0 0" />
      <div style="background:white;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
        <h2 style="color:#111827;margin:0 0 8px">✓ Estimate Signed</h2>
        <p style="color:#374151"><strong>${estimate.estimateNumber}</strong> has been signed by <strong>${signedByName}</strong>.</p>
        <p style="color:#374151">Customer: ${fullJob?.customerName || ""}<br/>Property: ${fullJob?.propertyStreet || ""}</p>
        <a href="${process.env.NEXT_PUBLIC_APP_URL || "https://app.lightfootroofsinspections.com"}/dashboard/crm/${estimate.jobId}" style="display:inline-block;background:#DC2626;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:8px">View Job</a>
        <p style="color:#9ca3af;font-size:12px;margin-top:16px">Lightfoot Roofs · (405) 834-4799</p>
      </div>
    </div>`;

    // Notify all admins
    for (const admin of admins) {
      await notifyTransporter.sendMail({
        from: `"Lightfoot Roofs" <accounting@lightfootroofs.com>`,
        to: admin.email,
        subject: `✓ Estimate Signed — ${fullJob?.customerName} (${estimate.estimateNumber})`,
        html: internalHtml,
      });
    }

    // Notify assigned rep if not admin
    if (fullJob?.assignedTo?.email && !admins.find(a => a.email === fullJob.assignedTo!.email)) {
      await notifyTransporter.sendMail({
        from: `"Lightfoot Roofs" <accounting@lightfootroofs.com>`,
        to: fullJob.assignedTo.email,
        subject: `✓ Estimate Signed — ${fullJob.customerName} (${estimate.estimateNumber})`,
        html: internalHtml,
      });
    }

    // Notify referral source partner
    const partner = fullJob?.inspections?.[0]?.referralSource?.partnerProfile;
    if (partner?.email) {
      await notifyTransporter.sendMail({
        from: `"Lightfoot Roofs" <accounting@lightfootroofs.com>`,
        to: partner.email,
        subject: `Great News — Your Referral Signed! (${fullJob?.customerName})`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <img src="https://app.lightfootroofsinspections.com/logo-email.png" alt="Lightfoot Roofs" width="600" style="display:block;width:100%;max-width:600px;border-radius:8px 8px 0 0" />
          <div style="background:white;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
            <h2 style="color:#111827;margin:0 0 8px">🎉 Great News!</h2>
            <p style="color:#374151">Hi${partner.fullName ? " " + partner.fullName : ""},</p>
            <p style="color:#374151">Your referral, <strong>${fullJob?.customerName}</strong>, has signed their estimate for the project at ${fullJob?.propertyStreet}, and we are moving forward with their roof!</p>
            <p style="color:#374151">Thank you for trusting Lightfoot Roofs. We truly appreciate your partnership.</p>
            <p style="color:#9ca3af;font-size:12px;margin-top:16px">Lightfoot Roofs · 2236 NW 164th St, Ste 12, Edmond OK, 73013 · (405) 834-4799</p>
          </div>
        </div>`,
      });
    }
  } catch (notifyErr) {
    console.error("Signed notifications failed:", notifyErr);
  }

  revalidatePath(`/dashboard/crm/${estimate.jobId}`);
  return { success: true };
}

export async function voidEstimate(estimateId: string) {
  await requireAdmin();
  const estimate = await prisma.estimate.findUnique({ where: { id: estimateId } });
  if (!estimate) throw new Error("Not found");
  await prisma.estimate.update({ where: { id: estimateId }, data: { status: "EXPIRED" } });
  revalidatePath(`/dashboard/crm/${estimate.jobId}`);
  return { success: true };
}

export async function deleteEstimate(estimateId: string) {
  const profile = await requireAdmin();
  const estimate = await prisma.estimate.findUnique({ where: { id: estimateId } });
  if (!estimate) throw new Error("Estimate not found");
  if (estimate.status === "SIGNED") throw new Error("Cannot delete a signed estimate");
  await prisma.estimate.delete({ where: { id: estimateId } });
  await logActivity(estimate.jobId, "NOTE", {
    userId: profile.id,
    body: `Estimate deleted`,
    isSystem: true,
  });
  revalidatePath(`/dashboard/crm/${estimate.jobId}`);
  return { success: true };
}

export async function searchJobsForLinking(query: string) {
  const profile = await requireAuth();
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";
  const where: any = {
    isLegacy: false,
    ...(isAdmin ? {} : { assignedToId: profile.id }),
    ...(query.trim() ? { OR: [
      { customerName: { contains: query, mode: "insensitive" } },
      { propertyStreet: { contains: query, mode: "insensitive" } },
      { propertyCity: { contains: query, mode: "insensitive" } },
      { claimNumber: { contains: query, mode: "insensitive" } },
    ]} : {}),
  };
  return prisma.job.findMany({
    where,
    select: { id: true, customerName: true, propertyStreet: true, propertyCity: true, propertyState: true, stage: true, jobType: true, assignedTo: { select: { fullName: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

// Update saveWorksheet to include description fields
export async function saveWorksheetDescriptions(jobId: string, data: {
  contractPriceDesc?: string;
  upgradeAmountDesc?: string;
  discountAmountDesc?: string;
  materialCostDesc?: string;
  laborCostDesc?: string;
  permitFeesDesc?: string;
  otherCostsDesc?: string;
}) {
  await requireAdmin();
  await prisma.financialWorksheet.update({
    where: { jobId },
    data: {
      contractPriceDesc: data.contractPriceDesc ?? null,
      upgradeAmountDesc: data.upgradeAmountDesc ?? null,
      discountAmountDesc: data.discountAmountDesc ?? null,
      materialCostDesc: data.materialCostDesc ?? null,
      laborCostDesc: data.laborCostDesc ?? null,
      permitFeesDesc: data.permitFeesDesc ?? null,
      otherCostsDesc: data.otherCostsDesc ?? null,
    },
  });
  revalidatePath(`/dashboard/crm/${jobId}`);
  return { success: true };
}

// ─────────────────────────────────────────────
// PIPELINE ACTIVITY + COMMUNICATIONS FEED
// ─────────────────────────────────────────────

export async function getPipelineActivityFeed(limit = 30) {
  const profile = await requireAuth();
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";

  const where: any = isAdmin
    ? {}
    : { job: { assignedToId: profile.id } };

  const activities = await prisma.jobActivity.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      job: { select: { id: true, customerName: true, propertyStreet: true, propertyCity: true } },
      user: { select: { fullName: true } },
    },
  });

  return activities;
}

export async function getPipelineCommunications(limit = 50) {
  const profile = await requireAuth();
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";

  const where: any = {
    type: { in: ["CONTACT_LOGGED", "NOTE"] },
    isSystem: false,
    handledAt: null,
    parentId: null,
    ...(isAdmin ? {} : { job: { assignedToId: profile.id } }),
  };

  const comms = await prisma.jobActivity.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      job: { select: { id: true, customerName: true, propertyStreet: true, propertyCity: true, assignedToId: true } },
      user: { select: { fullName: true } },
      replies: {
        include: { user: { select: { fullName: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  return comms;
}

// ─────────────────────────────────────────────
// COMMUNICATION HANDLED + COMMENTS
// ─────────────────────────────────────────────

export async function markCommunicationHandled(activityId: string) {
  const profile = await requireAuth();
  await prisma.jobActivity.update({
    where: { id: activityId },
    data: { handledAt: new Date(), handledById: profile.id },
  });
  revalidatePath("/dashboard/crm");
  return { success: true };
}

export async function addCommunicationComment(activityId: string, body: string) {
  const profile = await requireAuth();
  const parent = await prisma.jobActivity.findUnique({ where: { id: activityId } });
  if (!parent) throw new Error("Activity not found");
  await prisma.jobActivity.create({
    data: {
      jobId: parent.jobId,
      userId: profile.id,
      type: "NOTE",
      body: body.trim(),
      isSystem: false,
      parentId: activityId,
    },
  });
  revalidatePath("/dashboard/crm");
  return { success: true };
}

// ─────────────────────────────────────────────
// DOCUMENTS — admin list views
// ─────────────────────────────────────────────

export async function getAllEstimates() {
  await requireAdmin();
  const rows = await prisma.estimate.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      job: { select: { id: true, customerName: true, propertyStreet: true, propertyCity: true, assignedTo: { select: { fullName: true } } } },
      lineItems: { select: { amount: true, isWarranty: true } },
      createdBy: { select: { fullName: true } },
    },
  });
  return rows.map(e => {
    const { lineItems, ...rest } = e;
    return {
      ...rest,
      total: lineItems.filter((i: any) => !i.isWarranty).reduce((s: number, i: any) => s + Number(i.amount), 0),
    };
  });
}

export async function getAllContingencies() {
  await requireAdmin();
  return prisma.contingencyAgreement.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      inspection: { select: { id: true, propertyStreet: true, propertyCity: true, user: { select: { fullName: true } } } },
      createdBy: { select: { fullName: true } },
    },
  });
}

export async function getAllInvoices() {
  await requireAdmin();
  return prisma.invoice.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      job: { select: { id: true, customerName: true, propertyStreet: true, assignedTo: { select: { fullName: true } } } },
      createdBy: { select: { fullName: true } },
    },
  });
}

export async function getAllLienWaivers() {
  await requireAdmin();
  return prisma.lienWaiver.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      workOrder: {
        select: {
          id: true,
          job: { select: { id: true, customerName: true, propertyStreet: true } },
          crew: { select: { companyName: true } },
        },
      },
      createdBy: { select: { fullName: true } },
    },
  });
}

export async function getAllWorkOrders() {
  await requireAdmin();
  return prisma.workOrder.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      job: { select: { id: true, customerName: true, propertyStreet: true, assignedTo: { select: { fullName: true } } } },
      crew: { select: { companyName: true } },
      createdBy: { select: { fullName: true } },
    },
  });
}

// ─────────────────────────────────────────────
// REPORTS — data fetchers
// ─────────────────────────────────────────────

export async function getRevenueReport(startDate?: string, endDate?: string) {
  await requireAdmin();
  const where: any = {};
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }
  const invoices = await prisma.invoice.findMany({
    where,
    include: { job: { select: { assignedTo: { select: { fullName: true } }, jobType: true, createdAt: true } } },
  });
  return invoices.map(i => ({
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    amount: Number(i.amount),
    paidAmount: Number(i.paidAmount ?? 0),
    status: i.status,
    createdAt: i.createdAt,
    paidAt: i.paidAt,
    rep: i.job?.assignedTo?.fullName ?? "—",
    jobType: i.job?.jobType ?? "—",
  }));
}

export async function getPipelineReport() {
  await requireAdmin();
  const jobs = await prisma.job.findMany({
    select: {
      id: true, stage: true, stageChangedAt: true, createdAt: true, jobType: true,
      customerName: true, propertyStreet: true,
      assignedTo: { select: { fullName: true } },
      lastActivityAt: true,
    },
  });
  const now = new Date();
  return jobs.map(j => ({
    ...j,
    daysInStage: Math.floor((now.getTime() - new Date(j.stageChangedAt).getTime()) / 86400000),
    totalDays: Math.floor((now.getTime() - new Date(j.createdAt).getTime()) / 86400000),
  }));
}

export async function getRepPerformanceReport(startDate?: string, endDate?: string) {
  await requireAdmin();
  const dateFilter: any = {};
  if (startDate) dateFilter.gte = new Date(startDate);
  if (endDate) dateFilter.lte = new Date(endDate);
  const where = Object.keys(dateFilter).length ? { createdAt: dateFilter } : {};

  const [reps, jobs, estimates, inspections] = await Promise.all([
    prisma.profile.findMany({ where: { role: { in: ["ADMIN", "REP"] } }, select: { id: true, fullName: true } }),
    prisma.job.findMany({ where, select: { id: true, assignedToId: true, stage: true } }),
    prisma.estimate.findMany({ where, select: { jobId: true, status: true, createdById: true } }),
    prisma.inspection.findMany({ where, select: { id: true, userId: true } }),
  ]);

  return reps.map(rep => ({
    id: rep.id,
    name: rep.fullName,
    inspections: inspections.filter(i => i.userId === rep.id).length,
    jobsCreated: jobs.filter(j => j.assignedToId === rep.id).length,
    estimatesSent: estimates.filter(e => e.createdById === rep.id).length,
    estimatesSigned: estimates.filter(e => e.createdById === rep.id && e.status === "SIGNED").length,
    jobsClosed: jobs.filter(j => j.assignedToId === rep.id && j.stage === "CLOSED").length,
  }));
}

export async function getEstimateConversionReport(startDate?: string, endDate?: string) {
  await requireAdmin();
  const where: any = {};
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }
  const estimates = await prisma.estimate.findMany({
    where,
    include: {
      job: { select: { customerName: true, assignedTo: { select: { fullName: true } } } },
      lineItems: { select: { amount: true, isWarranty: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return estimates.map(e => ({
    id: e.id,
    estimateNumber: e.estimateNumber,
    status: e.status,
    customerName: e.job?.customerName ?? "—",
    rep: e.job?.assignedTo?.fullName ?? "—",
    total: e.lineItems.filter((i: any) => !i.isWarranty).reduce((s: number, i: any) => s + Number(i.amount), 0),
    sentAt: e.sentAt,
    signedAt: e.signedAt,
    daysToSign: e.sentAt && e.signedAt
      ? Math.floor((new Date(e.signedAt).getTime() - new Date(e.sentAt).getTime()) / 86400000)
      : null,
    createdAt: e.createdAt,
  }));
}

export async function getCollectionsReport() {
  await requireAdmin();
  const invoices = await prisma.invoice.findMany({
    where: { status: { in: ["DRAFT", "SENT", "OVERDUE"] } },
    include: {
      job: { select: { id: true, customerName: true, propertyStreet: true, assignedTo: { select: { fullName: true } } } },
    },
    orderBy: { dueDate: "asc" },
  });
  const now = new Date();
  return invoices.map(i => ({
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    amount: Number(i.amount),
    status: i.status,
    dueDate: i.dueDate,
    sentAt: i.sentAt,
    daysOverdue: i.dueDate && i.dueDate < now && i.status !== "PAID"
      ? Math.floor((now.getTime() - new Date(i.dueDate).getTime()) / 86400000)
      : 0,
    customerName: i.job?.customerName ?? "—",
    propertyStreet: i.job?.propertyStreet ?? "—",
    rep: i.job?.assignedTo?.fullName ?? "—",
    jobId: i.job?.id,
    lateFeeApplied: i.lateFeeApplied,
    lateFeeAmount: Number(i.lateFeeAmount ?? 0),
  }));
}

export async function getProfitLossReport(jobIds?: string[]) {
  await requireAdmin();
  const where = jobIds && jobIds.length ? { jobId: { in: jobIds } } : {};
  const worksheets = await prisma.financialWorksheet.findMany({
    where,
    include: {
      job: {
        select: {
          id: true, customerName: true, propertyStreet: true, propertyCity: true,
          jobType: true, stage: true, createdAt: true,
          assignedTo: { select: { fullName: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return worksheets.map(w => ({
    jobId: w.jobId,
    customerName: w.job?.customerName ?? "—",
    propertyStreet: w.job?.propertyStreet ?? "—",
    propertyCity: w.job?.propertyCity ?? "—",
    jobType: w.job?.jobType ?? "—",
    stage: w.job?.stage ?? "—",
    rep: w.job?.assignedTo?.fullName ?? "—",
    createdAt: w.job?.createdAt,
    contractPrice: Number(w.contractPrice ?? 0),
    upgradeAmount: Number(w.upgradeAmount ?? 0),
    discountAmount: Number(w.discountAmount ?? 0),
    totalJobValue: Number(w.totalJobValue ?? 0),
    materialCost: Number(w.materialCost ?? 0),
    laborCost: Number(w.laborCost ?? 0),
    permitFees: Number(w.permitFees ?? 0),
    otherCosts: Number(w.otherCosts ?? 0),
    totalCost: Number(w.totalCost ?? 0),
    grossProfit: Number(w.grossProfit ?? 0),
    marginPercent: Number(w.marginPercent ?? 0),
  }));
}

export async function getDeductibleTrackingReport() {
  await requireAdmin();
  const jobs = await prisma.job.findMany({
    where: { jobType: "INSURANCE", deductible: { not: null } },
    include: {
      assignedTo: { select: { fullName: true } },
      invoices: { select: { status: true, amount: true, paidAmount: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return jobs.map(j => {
    const deductible = Number(j.deductible ?? 0);
    const totalPaid = j.invoices.filter(i => i.status === "PAID").reduce((s, i) => s + Number(i.paidAmount ?? i.amount), 0);
    return {
      id: j.id,
      customerName: j.customerName,
      propertyStreet: j.propertyStreet,
      rep: j.assignedTo?.fullName ?? "—",
      stage: j.stage,
      deductible,
      deductibleCollected: totalPaid >= deductible,
      insuranceCompany: j.insuranceCompany,
      claimNumber: j.claimNumber,
      createdAt: j.createdAt,
    };
  });
}

export async function getDepreciationReport() {
  await requireAdmin();
  const jobs = await prisma.job.findMany({
    where: { jobType: "INSURANCE" },
    include: { assignedTo: { select: { fullName: true } } },
    orderBy: { createdAt: "desc" },
  });
  return jobs.map(j => ({
    id: j.id,
    customerName: j.customerName,
    propertyStreet: j.propertyStreet,
    rep: j.assignedTo?.fullName ?? "—",
    stage: j.stage,
    rcv: Number(j.rcv ?? 0),
    acv: Number(j.acv ?? 0),
    depreciation: Number(j.depreciation ?? 0),
    supplementStatus: j.supplementStatus,
    supplementRequested: Number(j.supplementRequested ?? 0),
    supplementApproved: Number(j.supplementApproved ?? 0),
    insuranceCompany: j.insuranceCompany,
    claimNumber: j.claimNumber,
  }));
}

export async function getLateFeeReport() {
  await requireAdmin();
  const invoices = await prisma.invoice.findMany({
    where: { OR: [{ lateFeeApplied: true }, { lateFeeWaived: true }] },
    include: {
      job: { select: { id: true, customerName: true, assignedTo: { select: { fullName: true } } } },
      createdBy: { select: { fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return invoices.map(i => ({
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    amount: Number(i.amount),
    status: i.status,
    lateFeeApplied: i.lateFeeApplied,
    lateFeeAmount: Number(i.lateFeeAmount ?? 0),
    lateFeeAppliedAt: i.lateFeeAppliedAt,
    lateFeeWaived: i.lateFeeWaived,
    lateFeeWaivedNote: i.lateFeeWaivedNote,
    customerName: i.job?.customerName ?? "—",
    rep: i.job?.assignedTo?.fullName ?? "—",
    jobId: i.job?.id,
  }));
}

export async function getSubcontractorReport(startDate?: string, endDate?: string) {
  await requireAdmin();
  const where: any = {};
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }
  const workOrders = await prisma.workOrder.findMany({
    where: { ...where, status: "COMPLETED" },
    include: {
      crew: { select: { id: true, companyName: true } },
      job: { select: { customerName: true, propertyStreet: true } },
    },
  });
  // Group by crew
  const crewMap = new Map<string, { name: string; totalLabor: number; jobs: number; retainage: number }>();
  for (const wo of workOrders) {
    const key = wo.crew.id;
    const existing = crewMap.get(key) ?? { name: wo.crew.companyName, totalLabor: 0, jobs: 0, retainage: 0 };
    crewMap.set(key, {
      name: wo.crew.companyName,
      totalLabor: existing.totalLabor + Number(wo.laborAmount ?? 0),
      jobs: existing.jobs + 1,
      retainage: existing.retainage + Number(wo.retainageAmount ?? 0),
    });
  }
  return Array.from(crewMap.entries()).map(([id, data]) => ({ id, ...data }));
}

export async function getCashFlowForecast() {
  await requireAdmin();
  const now = new Date();
  const in90 = new Date(now.getTime() + 90 * 86400000);
  const invoices = await prisma.invoice.findMany({
    where: { status: { in: ["SENT", "OVERDUE", "DRAFT"] }, dueDate: { lte: in90 } },
    include: { job: { select: { customerName: true, stage: true } } },
    orderBy: { dueDate: "asc" },
  });
  return invoices.map(i => ({
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    amount: Number(i.amount),
    status: i.status,
    dueDate: i.dueDate,
    customerName: i.job?.customerName ?? "—",
    stage: i.job?.stage ?? "—",
    bucket: !i.dueDate ? "No Due Date"
      : new Date(i.dueDate) < now ? "Overdue"
      : new Date(i.dueDate) <= new Date(now.getTime() + 30 * 86400000) ? "Next 30 Days"
      : new Date(i.dueDate) <= new Date(now.getTime() + 60 * 86400000) ? "31–60 Days"
      : "61–90 Days",
  }));
}

export async function getInsuranceVsRetailReport(startDate?: string, endDate?: string) {
  await requireAdmin();
  const where: any = {};
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }
  const jobs = await prisma.job.findMany({
    where,
    include: {
      worksheet: { select: { totalJobValue: true } },
      assignedTo: { select: { fullName: true } },
    },
  });
  return jobs.map(j => ({
    id: j.id,
    customerName: j.customerName,
    propertyStreet: j.propertyStreet,
    jobType: j.jobType,
    stage: j.stage,
    rep: j.assignedTo?.fullName ?? "—",
    totalJobValue: Number(j.worksheet?.totalJobValue ?? 0),
    rcv: Number(j.rcv ?? 0),
    acv: Number(j.acv ?? 0),
    deductible: Number(j.deductible ?? 0),
    createdAt: j.createdAt,
  }));
}

export async function getJobsForPLSelector() {
  await requireAdmin();
  return prisma.job.findMany({
    where: { worksheet: { isNot: null } },
    select: {
      id: true, customerName: true, propertyStreet: true, propertyCity: true,
      stage: true, jobType: true, createdAt: true,
      assignedTo: { select: { fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

// ─────────────────────────────────────────────
// PAYMENTS
// ─────────────────────────────────────────────

export async function receivePayment(data: {
  amount: number;
  paidAt: string;
  method: string;
  referenceNumber?: string;
  notes?: string;
  customerName?: string;
  jobId: string;
  invoiceId?: string;
  checkPhotoUrl?: string;
}) {
  const profile = await requireAdmin();

  const payment = await prisma.payment.create({
    data: {
      amount: data.amount,
      paidAt: parseDateInput(data.paidAt),
      method: data.method as any,
      referenceNumber: data.referenceNumber || null,
      notes: data.notes || null,
      customerName: data.customerName || null,
      checkPhotoUrl: data.checkPhotoUrl || null,
      jobId: data.jobId,
      invoiceId: data.invoiceId || null,
      receivedById: profile.id,
    },
  });

  // If attached to an invoice, check if it covers the balance
  if (data.invoiceId) {
    await applyPaymentToInvoice(payment.id, data.invoiceId);
  }

  await logActivity(data.jobId, "NOTE", {
    userId: profile.id,
    body: `Payment received: $${data.amount.toLocaleString()} via ${data.method}${data.referenceNumber ? ` (Ref: ${data.referenceNumber})` : ""}`,
    isSystem: true,
  });
  revalidatePath(`/dashboard/crm/${data.jobId}`);

  revalidatePath("/admin/payments");
  return { success: true, paymentId: payment.id };
}

async function applyPaymentToInvoice(paymentId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { payments: true },
  });
  if (!invoice || invoice.status === "VOID") return;

  const totalPaid = invoice.payments.reduce((s, p) => s + Number(p.amount), 0);
  const invoiceAmount = Number(invoice.amount);

  if (totalPaid >= invoiceAmount) {
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "PAID",
        paidAt: new Date(),
        paidAmount: totalPaid,
      },
    });

    // Auto-advance to COLLECTED if final invoice
    if (invoice.isFinalInvoice) {
      const job = await prisma.job.findUnique({ where: { id: invoice.jobId } });
      if (job && job.stage === "INVOICED") {
        await changeStage(invoice.jobId, "COLLECTED");
      }
    }
  } else if (totalPaid > 0) {
    // Partial payment — update paidAmount so balance shows correctly on invoice
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        paidAmount: totalPaid,
        status: invoice.status === "PAID" ? "SENT" : invoice.status,
      },
    });
  }
}

export async function applyPayment(paymentId: string, invoiceId: string) {
  const profile = await requireAdmin();

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new Error("Payment not found");
  if (payment.invoiceId) throw new Error("Payment already applied to an invoice");

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Invoice not found");

  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      invoiceId,
      jobId: payment.jobId || invoice.jobId,
    },
  });

  await applyPaymentToInvoice(paymentId, invoiceId);

  if (invoice.jobId) {
    await logActivity(invoice.jobId, "NOTE", {
      userId: profile.id,
      body: `Payment of $${Number(payment.amount).toLocaleString()} applied to invoice ${invoice.invoiceNumber}`,
      isSystem: true,
    });
    revalidatePath(`/dashboard/crm/${invoice.jobId}`);
  }

  revalidatePath("/admin/payments");
  return { success: true };
}

export async function unapplyPayment(paymentId: string) {
  const profile = await requireAdmin();
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { invoice: true },
  });
  if (!payment) throw new Error("Payment not found");

  await prisma.payment.update({
    where: { id: paymentId },
    data: { invoiceId: null },
  });

  // Revert invoice status if needed
  if (payment.invoiceId && payment.invoice?.status === "PAID") {
    await prisma.invoice.update({
      where: { id: payment.invoiceId },
      data: { status: "SENT", paidAt: null, paidAmount: null },
    });
  }

  revalidatePath("/admin/payments");
  return { success: true };
}

export async function deletePayment(paymentId: string) {
  const profile = await requireAdmin();
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { invoice: true },
  });
  if (!payment) throw new Error("Payment not found");

  await prisma.payment.delete({ where: { id: paymentId } });

  // Revert invoice if it was paid by this payment
  if (payment.invoiceId && payment.invoice?.status === "PAID") {
    const remaining = await prisma.payment.findMany({
      where: { invoiceId: payment.invoiceId },
    });
    if (remaining.length === 0) {
      await prisma.invoice.update({
        where: { id: payment.invoiceId },
        data: { status: "SENT", paidAt: null, paidAmount: null },
      });
    }
  }

  revalidatePath("/admin/payments");
  return { success: true };
}

export async function getPayments() {
  await requireAdmin();
  return prisma.payment.findMany({
    orderBy: { paidAt: "desc" },
    include: {
      job: { select: { id: true, customerName: true, propertyStreet: true } },
      invoice: { select: { id: true, invoiceNumber: true, amount: true, status: true } },
      receivedBy: { select: { fullName: true } },
    },
  });
}

export async function getJobCreditBalance(jobId: string): Promise<number> {
  await requireAuth();
  const payments = await prisma.payment.findMany({
    where: { jobId },
    include: { invoice: { select: { amount: true } } },
  });
  let credit = 0;
  for (const p of payments) {
    const paid = Number(p.amount);
    if (!p.invoice) {
      // Fully unapplied payment
      credit += paid;
    } else {
      const invoiceAmt = Number(p.invoice.amount);
      if (paid > invoiceAmt) {
        credit += paid - invoiceAmt;
      }
    }
  }
  return credit;
}

export async function getOpenInvoicesForJob(jobId: string) {
  await requireAuth();
  const rows = await prisma.invoice.findMany({
    where: { jobId, status: { in: ["DRAFT", "SENT", "OVERDUE"] } },
    select: { id: true, invoiceNumber: true, amount: true, status: true, dueDate: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(r => ({ ...r, amount: Number(r.amount) }));
}

export async function getJobsWithOpenInvoices() {
  await requireAdmin();
  const jobs = await prisma.job.findMany({
    where: { invoices: { some: { status: { in: ["DRAFT", "SENT", "OVERDUE"] } } } },
    select: {
      id: true,
      customerName: true,
      propertyStreet: true,
      propertyCity: true,
      assignedTo: { select: { fullName: true } },
      invoices: {
        where: { status: { in: ["DRAFT", "SENT", "OVERDUE"] } },
        select: { id: true, invoiceNumber: true, amount: true, status: true, dueDate: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
  return jobs;
}

export async function getUnappliedPaymentsForJob(jobId: string) {
  await requireAuth();
  return prisma.payment.findMany({
    where: { jobId, invoiceId: null },
    orderBy: { paidAt: "desc" },
    select: {
      id: true,
      amount: true,
      paidAt: true,
      method: true,
      referenceNumber: true,
      customerName: true,
      checkPhotoUrl: true,
    },
  });
}

export async function getAllActiveJobs() {
  await requireAdmin();
  return prisma.job.findMany({
    where: {
      stage: {
        notIn: ["CLOSED", "LOST", "CANCELLED"],
      },
    },
    select: {
      id: true,
      customerName: true,
      propertyStreet: true,
      propertyCity: true,
      stage: true,
      assignedTo: { select: { fullName: true } },
    },
    orderBy: { lastActivityAt: "desc" },
  });
}

// ── DASHBOARD: OPEN INVOICES (SENT + OVERDUE) ──
export async function getDashboardOpenInvoices() {
  await requireAdmin();
  const invoices = await prisma.invoice.findMany({
    where: { status: { in: ["SENT", "OVERDUE"] } },
    include: {
      job: { select: { id: true, customerName: true, propertyStreet: true, propertyCity: true } },
      payments: { select: { amount: true } },
    },
    orderBy: { sentAt: "asc" },
  });

  // Auto-correct any invoices whose payments already cover the full amount
  // (handles cases where payments were recorded before the status fix)
  const staleIds: string[] = [];
  const open = invoices.filter(inv => {
    const totalPaid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
    if (totalPaid >= Number(inv.amount)) {
      staleIds.push(inv.id);
      return false; // exclude from open invoices
    }
    return true;
  });

  // Silently fix stale statuses in the background
  if (staleIds.length > 0) {
    prisma.invoice.updateMany({
      where: { id: { in: staleIds } },
      data: { status: "PAID", paidAt: new Date() },
    }).catch(() => {});
  }

  return JSON.parse(JSON.stringify(open));
}

// ── GLOBAL SEARCH ──
export async function globalSearch(query: string) {
  const profile = await requireAuth();
  if (!query.trim() || query.trim().length < 2) return { jobs: [], inspections: [] };
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";
  const q = query.trim();

  const [jobs, inspections] = await Promise.all([
    prisma.job.findMany({
      where: {
        ...(!isAdmin ? { assignedToId: profile.id } : {}),
        OR: [
          { customerName: { contains: q, mode: "insensitive" } },
          { propertyStreet: { contains: q, mode: "insensitive" } },
          { propertyCity: { contains: q, mode: "insensitive" } },
          { referralSource: { name: { contains: q, mode: "insensitive" } } },
        ],
      },
      select: {
        id: true,
        customerName: true,
        propertyStreet: true,
        propertyCity: true,
        propertyState: true,
        stage: true,
        referralSource: { select: { name: true } },
        assignedTo: { select: { fullName: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 6,
    }),
    prisma.inspection.findMany({
      where: {
        ...(!isAdmin ? { userId: profile.id } : {}),
        OR: [
          { customerName: { contains: q, mode: "insensitive" } },
          { propertyStreet: { contains: q, mode: "insensitive" } },
          { propertyCity: { contains: q, mode: "insensitive" } },
          { referralSource: { name: { contains: q, mode: "insensitive" } } },
        ],
      },
      select: {
        id: true,
        customerName: true,
        propertyStreet: true,
        propertyCity: true,
        inspectionDate: true,
        status: true,
        referralSource: { select: { name: true } },
        user: { select: { fullName: true } },
      },
      orderBy: { inspectionDate: "desc" },
      take: 6,
    }),
  ]);

  return JSON.parse(JSON.stringify({ jobs, inspections }));
}

// ── BACKFILL: Create draft inspection records for jobs missing them ───────────
export async function backfillInspectionDrafts() {
  await requireAdmin();

  // Find all jobs that have an inspection date set but no linked inspection draft
  const jobs = await prisma.job.findMany({
    where: {
      inspectionScheduledAt: { not: null },
      isLegacy: false,
    },
    include: {
      inspections: {
        where: { status: { in: ["DRAFT" as any, "SUBMITTED" as any] } },
        select: { id: true },
      },
    },
  });

  const missing = jobs.filter(j => j.inspections.length === 0);
  let created = 0;

  for (const job of missing) {
    await prisma.inspection.create({
      data: {
        userId: job.assignedToId,
        status: "DRAFT" as any,
        inspectorName: "",
        customerName: job.customerName || "",
        customerEmail: job.customerEmail || "",
        customerPhone: job.customerPhone || "",
        inspectionDate: job.inspectionScheduledAt!,
        scheduledAt: job.inspectionScheduledAt!,
        propertyStreet: job.propertyStreet || "",
        propertyCity: job.propertyCity || "",
        propertyState: job.propertyState || "OK",
        propertyZip: job.propertyZip || "",
        jobId: job.id,
      },
    });
    created++;
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/admin/settings");
  return { created, total: missing.length };
}

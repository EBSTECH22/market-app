"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";

async function requireAdmin() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  const profile = await prisma.profile.findUnique({ where: { id: user.id } });
  if (!profile || (profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER")) throw new Error("Admin required");
  return profile;
}

async function requireAdminOrAssignedRep(jobId: string) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  const profile = await prisma.profile.findUnique({ where: { id: user.id } });
  if (!profile) throw new Error("Unauthorized");
  const isAdmin = profile.role === "ADMIN" || (profile.role as string) === "OFFICE_MANAGER";
  if (isAdmin) return profile;
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { assignedToId: true } });
  if (!job || job.assignedToId !== profile.id) throw new Error("You are not assigned to this job");
  return profile;
}

async function generateCCONumber(): Promise<string> {
  // CO-MMYY-### — month/year of issue, sequence resets each calendar year
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const countThisYear = await prisma.contractChangeOrder.count({ where: { createdAt: { gte: yearStart } } });
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  return `CO-${mm}${yy}-${countThisYear + 101}`;
}

// ─── CREATE ──────────────────────────────────────────────────────────────────

export async function createContractChangeOrder(data: {
  contractId: string;
  description: string;
  lineItems: {
    label: string;
    description?: string;
    quantity: number;
    unitType: string;
    unitPrice: number;
    amount: number;
    isAddition: boolean;
  }[];
  notes?: string;
}) {
  const contract = await prisma.contract.findUnique({
    where: { id: data.contractId },
    select: { jobId: true, contractNumber: true },
  });
  if (!contract) throw new Error("Contract not found");
  const admin = await requireAdminOrAssignedRep(contract.jobId);

  const changeOrderNumber = await generateCCONumber();
  const signingToken = require("crypto").randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const co = await prisma.contractChangeOrder.create({
    data: {
      contractId: data.contractId,
      jobId: contract.jobId,
      createdById: admin.id,
      changeOrderNumber,
      description: data.description,
      signingToken,
      expiresAt,
      notes: data.notes || null,
      lineItems: {
        create: data.lineItems.map((item, idx) => ({
          label: item.label,
          description: item.description || null,
          quantity: item.quantity,
          unitType: item.unitType,
          unitPrice: item.unitPrice,
          amount: item.amount,
          isAddition: item.isAddition,
        })),
      },
    },
    include: { lineItems: true },
  });

  await prisma.jobActivity.create({
    data: {
      jobId: contract.jobId,
      userId: admin.id,
      type: "NOTE",
      body: `Change order ${changeOrderNumber} created for contract ${contract.contractNumber}`,
      isSystem: true,
    },
  });

  revalidatePath(`/dashboard/crm/${contract.jobId}`);
  return co;
}

// ─── UPDATE ──────────────────────────────────────────────────────────────────

export async function updateContractChangeOrder(coId: string, data: {
  description?: string;
  lineItems?: {
    label: string;
    description?: string;
    quantity: number;
    unitType: string;
    unitPrice: number;
    amount: number;
    isAddition: boolean;
  }[];
  notes?: string;
}) {
  const co = await prisma.contractChangeOrder.findUnique({ where: { id: coId } });
  if (!co) throw new Error("Change order not found");
  await requireAdminOrAssignedRep(co.jobId);
  if (co.status === "SIGNED") throw new Error("Cannot edit a signed change order");

  if (data.lineItems) {
    await prisma.contractChangeOrderLineItem.deleteMany({ where: { changeOrderId: coId } });
    await prisma.contractChangeOrderLineItem.createMany({
      data: data.lineItems.map(item => ({
        changeOrderId: coId,
        label: item.label,
        description: item.description || null,
        quantity: item.quantity,
        unitType: item.unitType,
        unitPrice: item.unitPrice,
        amount: item.amount,
        isAddition: item.isAddition,
      })),
    });
  }

  await prisma.contractChangeOrder.update({
    where: { id: coId },
    data: {
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
  });

  revalidatePath(`/dashboard/crm/${co.jobId}`);
  return { success: true };
}

// ─── SEND ─────────────────────────────────────────────────────────────────────

export async function sendContractChangeOrder(coId: string, toEmail: string) {
  const co = await prisma.contractChangeOrder.findUnique({
    where: { id: coId },
    include: {
      lineItems: true,
      contract: { select: { contractNumber: true } },
      job: { select: { id: true, customerName: true, propertyStreet: true, propertyCity: true } },
    },
  });
  if (!co) throw new Error("Change order not found");
  const admin = await requireAdminOrAssignedRep(co.jobId);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.lightfootroofsinspections.com";
  const signingUrl = `${appUrl}/change-order/${co.signingToken}`;

  const additions = co.lineItems.filter(i => i.isAddition).reduce((sum, i) => sum + Number(i.amount), 0);
  const deductions = co.lineItems.filter(i => !i.isAddition).reduce((sum, i) => sum + Number(i.amount), 0);
  const netChange = additions - deductions;

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASSWORD },
  });

  await transporter.sendMail({
    from: `"Lightfoot Roofs" <accounting@lightfootroofs.com>`,
    to: toEmail,
    subject: `Change Order ${co.changeOrderNumber} — ${co.job.customerName} | Lightfoot Roofs`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <img src="https://app.lightfootroofsinspections.com/logo-email.png" alt="Lightfoot Roofs" width="600" style="display:block;width:100%;max-width:600px;border-radius:8px 8px 0 0" />
        <div style="background:#f9fafb;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
          <h2 style="color:#111;font-size:18px">Hello ${co.job.customerName},</h2>
          <p style="color:#374151">A change order has been created for your roofing project at <strong>${co.job.propertyStreet}, ${co.job.propertyCity}</strong>.</p>
          <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0">
            <p style="margin:0;color:#6b7280;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px">Change Order Summary</p>
            <p style="margin:6px 0 2px;font-size:13px"><strong>Change Order #:</strong> ${co.changeOrderNumber}</p>
            <p style="margin:2px 0;font-size:13px"><strong>Original Contract:</strong> ${co.contract.contractNumber}</p>
            <p style="margin:2px 0;font-size:13px"><strong>Description:</strong> ${co.description}</p>
            <p style="margin:8px 0 0;font-size:20px;font-weight:bold;color:${netChange >= 0 ? '#CC0000' : '#16a34a'}">
              Net Change: ${netChange >= 0 ? '+' : ''}${netChange.toLocaleString("en-US", { style: "currency", currency: "USD" })}
            </p>
          </div>
          <a href="${signingUrl}" style="display:inline-block;background:#CC0000;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px">
            Review &amp; Sign Change Order
          </a>
          <p style="color:#6b7280;font-size:12px;margin-top:20px">Questions? Call us at 405-834-4799 or email accounting@lightfootroofs.com</p>
          <p style="color:#6b7280;font-size:12px">Lightfoot Roofs · 2236 NW 164th St, Suite 12, Edmond, OK 73013 · License #OK 80006087</p>
        </div>
      </div>
    `,
  });

  await prisma.contractChangeOrder.update({
    where: { id: coId },
    data: { status: "SENT", sentAt: new Date(), sentToEmail: toEmail },
  });

  await prisma.jobActivity.create({
    data: {
      jobId: co.job.id,
      userId: admin.id,
      type: "NOTE",
      body: `Change order ${co.changeOrderNumber} sent to ${toEmail}`,
      isSystem: true,
    },
  });

  revalidatePath(`/dashboard/crm/${co.job.id}`);
  return { success: true };
}

// ─── GET BY TOKEN (public signing page) ──────────────────────────────────────

export async function getContractChangeOrderByToken(token: string) {
  return prisma.contractChangeOrder.findFirst({
    where: { signingToken: token },
    include: {
      lineItems: true,
      contract: {
        select: {
          contractNumber: true,
          shingleType: true,
          shingleColor: true,
          totalSquares: true,
          signedAt: true,
          signedByName: true,
          lineItems: { orderBy: { sortOrder: "asc" } },
        },
      },
      job: {
        select: {
          customerName: true,
          customerPhone: true,
          customerEmail: true,
          propertyStreet: true,
          propertyCity: true,
          propertyState: true,
          propertyZip: true,
        },
      },
      createdBy: { select: { fullName: true } },
    },
  });
}

// ─── NOTIFY OPENED ────────────────────────────────────────────────────────────

export async function notifyChangeOrderOpened(token: string) {
  try {
    const co = await prisma.contractChangeOrder.findFirst({
      where: { signingToken: token },
      include: { job: { select: { id: true, customerName: true, propertyStreet: true } } },
    });
    if (!co || co.status === "SIGNED") return;

    // Rate limit: once per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await prisma.notification.findFirst({
      where: {
        title: "👀 Change Order Opened",
        body: { contains: co.changeOrderNumber },
        createdAt: { gte: oneHourAgo },
      },
    });
    if (recent) return;

    const { createNotificationForAdmins } = await import("@/actions/notifications");
    await createNotificationForAdmins({
      title: "👀 Change Order Opened",
      body: `${co.job.customerName} opened ${co.changeOrderNumber} — ${co.job.propertyStreet}`,
      url: `/dashboard/crm/${co.job.id}`,
    });
  } catch (err) {
    console.error("notifyChangeOrderOpened error:", err);
  }
}

// ─── SIGN (customer) ─────────────────────────────────────────────────────────

export async function signContractChangeOrder(token: string, signedByName: string, signedByIp: string) {
  const co = await prisma.contractChangeOrder.findFirst({ where: { signingToken: token } });
  if (!co) throw new Error("Change order not found");
  if (co.status === "SIGNED") throw new Error("Already signed");
  if (co.expiresAt && co.expiresAt < new Date()) throw new Error("The signing period for this change order has expired.");

  await prisma.contractChangeOrder.update({
    where: { id: co.id },
    data: { status: "SIGNED", signedAt: new Date(), signedByName, signedByIp },
  });

  await prisma.jobActivity.create({
    data: {
      jobId: co.jobId,
      type: "NOTE",
      body: `Change order ${co.changeOrderNumber} signed by ${signedByName}`,
      isSystem: true,
    },
  });

  // Customer signature is the moment the money is real: roll the contract
  // price, the commissions, and the customer's invoice forward together.
  // Wrapped because a failure here must not block the signature itself — the
  // office can re-sync from the job file.
  try {
    const { applyChangeOrdersToJob } = await import("@/actions/change-order-apply");
    await applyChangeOrdersToJob(co.jobId, co.id);
  } catch (e) {
    await prisma.jobActivity.create({
      data: {
        jobId: co.jobId,
        type: "NOTE",
        body: `Change order ${co.changeOrderNumber} signed, but the contract total did not update automatically. Use "Re-sync contract totals" on the job file.`,
        isSystem: true,
      },
    }).catch(() => {});
  }

  // Notify admins
  try {
    const { createNotificationForAdmins } = await import("@/actions/notifications");
    const fullCo = await prisma.contractChangeOrder.findUnique({
      where: { id: co.id },
      include: { job: { select: { customerName: true, propertyStreet: true } } },
    });
    if (fullCo) {
      await createNotificationForAdmins({
        title: "✍️ Change Order Signed",
        body: `${signedByName} signed ${co.changeOrderNumber} — ${fullCo.job.propertyStreet}`,
        url: `/dashboard/crm/${co.jobId}`,
      });
    }
  } catch {}

  revalidatePath(`/dashboard/crm/${co.jobId}`);
  return { success: true };
}

// ─── ADMIN SIGN ───────────────────────────────────────────────────────────────

export async function adminSignContractChangeOrder(coId: string) {
  const admin = await requireAdmin();

  const co = await prisma.contractChangeOrder.findUnique({
    where: { id: coId },
    include: {
      job: { select: { id: true, customerName: true, customerEmail: true, propertyStreet: true } },
      contract: { select: { contractNumber: true } },
      lineItems: true,
    },
  });
  if (!co) throw new Error("Change order not found");
  if (co.adminSignedAt) throw new Error("Already counter-signed");
  if (!co.signedAt) throw new Error("Customer must sign first");

  await prisma.contractChangeOrder.update({
    where: { id: coId },
    data: { adminSignedAt: new Date(), adminSignedBy: admin.fullName },
  });

  await prisma.jobActivity.create({
    data: {
      jobId: co.job.id,
      userId: admin.id,
      type: "NOTE",
      body: `Change order ${co.changeOrderNumber} counter-signed by ${admin.fullName}`,
      isSystem: true,
    },
  });

  // Send final copy to customer
  if (co.sentToEmail || co.job.customerEmail) {
    const toEmail = (co.sentToEmail || co.job.customerEmail)!;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.lightfootroofsinspections.com";
    const printUrl = `${appUrl}/print/change-order/${co.signingToken}`;
    const netChange = co.lineItems.reduce((sum, i) => sum + (i.isAddition ? 1 : -1) * Number(i.amount), 0);

    try {
      const nodemailer = require("nodemailer");
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASSWORD },
      });
      await transporter.sendMail({
        from: `"Lightfoot Roofs" <accounting@lightfootroofs.com>`,
        to: toEmail,
        subject: `Fully Executed Change Order ${co.changeOrderNumber} | Lightfoot Roofs`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
            <img src="https://app.lightfootroofsinspections.com/logo-email.png" alt="Lightfoot Roofs" width="600" style="display:block;width:100%;max-width:600px;border-radius:8px 8px 0 0" />
            <div style="background:#f9fafb;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
              <h2 style="color:#111">Change Order Fully Executed</h2>
              <p style="color:#374151">Your change order for ${co.job.propertyStreet} has been signed by both parties.</p>
              <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0">
                <p style="margin:0;color:#6b7280;font-size:12px">Change Order #${co.changeOrderNumber} · Contract ${co.contract.contractNumber}</p>
                <p style="margin:8px 0 0;font-size:20px;font-weight:bold;color:${netChange >= 0 ? '#CC0000' : '#16a34a'}">
                  Net Change: ${netChange >= 0 ? '+' : ''}${netChange.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                </p>
              </div>
              <a href="${printUrl}" style="display:inline-block;background:#111;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold">
                View &amp; Download Change Order
              </a>
              <p style="color:#6b7280;font-size:12px;margin-top:20px">Questions? 405-834-4799 · accounting@lightfootroofs.com</p>
            </div>
          </div>
        `,
      });
    } catch {}
  }

  revalidatePath(`/dashboard/crm/${co.job.id}`);
  return { success: true };
}

// ─── VOID ─────────────────────────────────────────────────────────────────────

export async function voidContractChangeOrder(coId: string) {
  await requireAdmin();
  const co = await prisma.contractChangeOrder.findUnique({ where: { id: coId } });
  if (!co) throw new Error("Not found");
  await prisma.contractChangeOrder.update({ where: { id: coId }, data: { status: "VOID" } });

  // Voiding a signed change order has to take the money back out too.
  try {
    const { applyChangeOrdersToJob } = await import("@/actions/change-order-apply");
    await applyChangeOrdersToJob(co.jobId);
  } catch { /* re-sync available on the job file */ }

  revalidatePath(`/dashboard/crm/${co.jobId}`);
  return { success: true };
}

// ─── GET FOR JOB ─────────────────────────────────────────────────────────────

export async function getContractChangeOrdersForJob(jobId: string) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  const profile = await prisma.profile.findUnique({ where: { id: user.id } });
  if (!profile || (profile.role !== "ADMIN" && (profile.role as string) !== "OFFICE_MANAGER")) throw new Error("Admin required");

  const cos = await prisma.contractChangeOrder.findMany({
    where: { jobId },
    include: {
      lineItems: true,
      createdBy: { select: { fullName: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return cos.map(co => ({
    ...co,
    lineItems: co.lineItems.map(i => ({
      ...i,
      quantity: Number(i.quantity),
      unitPrice: Number(i.unitPrice),
      amount: Number(i.amount),
    })),
  }));
}

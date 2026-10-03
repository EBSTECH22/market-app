"use server";

// Certificate of Completion e-signing.
// Records everything needed to establish the electronic signature under
// E-SIGN / Oklahoma UETA: the drawn signature image, typed name, signing
// timestamp, signer IP, and a separate timestamp for the signer's consent
// to use electronic records (15 U.S.C. § 7001(c) disclosures shown on the
// signing page).

import { prisma } from "@/lib/prisma";
import { getUser } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import crypto from "crypto";

async function requireStaff() {
  const user = await getUser();
  if (!user) redirect("/auth/login");
  const profile = await prisma.profile.findUnique({ where: { id: user.id } });
  if (!profile) redirect("/auth/login");
  return profile;
}

export async function ensureCompletionCertToken(jobId: string) {
  await requireStaff();
  const job = await (prisma as any).job.findUnique({ where: { id: jobId }, select: { id: true, completionCertToken: true } });
  if (!job) throw new Error("Job not found");
  if (job.completionCertToken) return { token: job.completionCertToken };

  const token = crypto.randomBytes(32).toString("hex");
  await (prisma as any).job.update({ where: { id: jobId }, data: { completionCertToken: token } });
  revalidatePath(`/print/completion/${jobId}`);
  return { token };
}

export async function saveCompletionCertDetails(jobId: string, data: { completedDate?: string; exceptions?: string }) {
  await requireStaff();
  const existing = await (prisma as any).job.findUnique({ where: { id: jobId }, select: { completionCertSignedAt: true } });
  if (existing?.completionCertSignedAt) throw new Error("This certificate has been signed and can no longer be edited");
  const update: any = {};
  if (data.completedDate !== undefined) update.completionCertCompletedDate = data.completedDate ? new Date(data.completedDate + "T12:00:00Z") : null;
  if (data.exceptions !== undefined) update.completionCertExceptions = data.exceptions.trim() || null;
  await (prisma as any).job.update({ where: { id: jobId }, data: update });
  revalidatePath(`/print/completion/${jobId}`);
  return { success: true };
}

export async function saveCompletionCertData(jobId: string, data: {
  carrier?: string;
  claimNumber?: string;
  policyNumber?: string;
  roofingSystem?: string;
  ownerName?: string;
  completedItems?: string[];
  excludedItems?: string[];
}) {
  await requireStaff();
  const existing = await (prisma as any).job.findUnique({ where: { id: jobId }, select: { completionCertSignedAt: true, completionCertData: true } });
  if (!existing) throw new Error("Job not found");
  if (existing.completionCertSignedAt) throw new Error("This certificate has been signed and can no longer be edited");

  const clean = (arr?: string[]) => (arr || []).map(x => String(x).trim()).filter(Boolean).slice(0, 40);
  const merged = {
    ...(existing.completionCertData || {}),
    carrier: data.carrier?.trim() || null,
    claimNumber: data.claimNumber?.trim() || null,
    policyNumber: data.policyNumber?.trim() || null,
    roofingSystem: data.roofingSystem?.trim() || null,
    ownerName: data.ownerName?.trim() || null,
    completedItems: clean(data.completedItems),
    excludedItems: clean(data.excludedItems),
  };
  await (prisma as any).job.update({ where: { id: jobId }, data: { completionCertData: merged } });
  revalidatePath(`/print/completion/${jobId}`);
  return { success: true };
}

export async function getCompletionCertByToken(token: string) {
  if (!token || token.length < 20) return null;
  const job = await (prisma as any).job.findUnique({
    where: { completionCertToken: token },
    select: {
      id: true,
      customerName: true,
      propertyStreet: true,
      propertyCity: true,
      propertyState: true,
      propertyZip: true,
      insuranceCompany: true,
      claimNumber: true,
      policyNumber: true,
      completionCertCompletedDate: true,
      completionCertData: true,
      completionCertExceptions: true,
      completionCertSignedAt: true,
      completionCertSignedBy: true,
      completionCertSignatureImage: true,
      contracts: {
        where: { status: "SIGNED" },
        orderBy: { signedAt: "desc" },
        take: 1,
        select: { contractNumber: true, signedAt: true, shingleType: true, shingleBrand: true, shingleCustomType: true, shingleColor: true },
      },
    },
  });
  return job ? JSON.parse(JSON.stringify(job)) : null;
}

export async function adminSignCompletionCert(jobId: string, signatureImage: string) {
  const profile = await requireStaff();
  if (!signatureImage?.startsWith("data:image")) throw new Error("Please draw a signature");

  const job = await (prisma as any).job.findUnique({
    where: { id: jobId },
    select: { id: true, completionCertAdminSignedAt: true },
  });
  if (!job) throw new Error("Job not found");
  if (job.completionCertAdminSignedAt) throw new Error("The contractor signature is already on this certificate");

  const now = new Date();
  await (prisma as any).job.update({
    where: { id: jobId },
    data: {
      completionCertAdminSignedAt: now,
      completionCertAdminSignedBy: (profile.fullName || "Lightfoot Roofing Inc, DBA Lightfoot Roofs").slice(0, 120),
      completionCertAdminSignatureImage: signatureImage,
    },
  });

  await prisma.jobActivity.create({
    data: {
      jobId,
      type: "NOTE" as any,
      userId: profile.id,
      body: `Certificate of Completion signed for Contractor by ${profile.fullName || "staff"}`,
      isSystem: true,
    } as any,
  });
  await prisma.job.update({ where: { id: jobId }, data: { lastActivityAt: now } });

  revalidatePath(`/print/completion/${jobId}`);
  return { success: true };
}

export async function signCompletionCert(token: string, signedName: string, signatureImage: string, consentAccepted: boolean) {
  if (!consentAccepted) throw new Error("You must consent to the use of electronic records and signatures to sign electronically");
  if (!signedName?.trim()) throw new Error("Please type your full name");
  if (!signatureImage?.startsWith("data:image")) throw new Error("Please draw your signature");

  const job = await (prisma as any).job.findUnique({
    where: { completionCertToken: token },
    select: { id: true, customerName: true, completionCertSignedAt: true },
  });
  if (!job) throw new Error("Certificate not found");
  if (job.completionCertSignedAt) throw new Error("This certificate has already been signed");

  const hdrs = await headers();
  const ip = (hdrs.get("x-forwarded-for") || hdrs.get("x-real-ip") || "").split(",")[0].trim() || "unknown";
  const now = new Date();

  await (prisma as any).job.update({
    where: { id: job.id },
    data: {
      completionCertConsentAt: now,
      completionCertSignedAt: now,
      completionCertSignedBy: signedName.trim().slice(0, 120),
      completionCertSignedIp: ip,
      completionCertSignatureImage: signatureImage,
    },
  });

  await prisma.jobActivity.create({
    data: {
      jobId: job.id,
      type: "NOTE" as any,
      body: `Certificate of Completion electronically signed by ${signedName.trim()} (IP ${ip}) — E-SIGN consent recorded`,
      isSystem: true,
    } as any,
  });
  await prisma.job.update({ where: { id: job.id }, data: { lastActivityAt: now } });

  // Bell + push to admins and office managers (same channel as clock events)
  try {
    const targets = await prisma.profile.findMany({
      where: { role: { in: ["ADMIN", "OFFICE_MANAGER" as any] } },
      select: { id: true },
    });
    if (targets.length > 0) {
      const { createNotification } = await import("@/actions/notifications");
      await Promise.allSettled(
        targets.map((t) =>
          createNotification({
            userId: t.id,
            title: "Certificate of Completion signed",
            body: `${job.customerName || "Customer"} signed the Certificate of Completion`,
            url: `/print/completion/${job.id}`,
          })
        )
      );
    }
  } catch (err) {
    console.error("Completion cert notification failed:", err);
  }

  revalidatePath(`/print/completion/${job.id}`);
  return { success: true };
}

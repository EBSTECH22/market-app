import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { postFirstMonthRent } from "@/lib/firstrent";
import { pushToAdmin } from "@/lib/push";
import { sendExecutedContractEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

// Token IS the auth — same trust model as pay links. Vendor-side signing only.
async function byToken(token: string) {
  if (!token || token.length < 16) return null;
  return db.contract.findFirst({ where: { signToken: token }, include: { vendor: true } });
}

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const contract = await byToken(params.token);
  if (!contract) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const application = await db.vendorApplication.findFirst({
    where: { email: { equals: contract.vendor.email, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    role: "VENDOR",
    contract: {
      id: contract.id, boothLabel: contract.boothLabel, monthlyRentCents: contract.monthlyRentCents,
      startDate: contract.startDate, status: contract.status,
      vendorSignedName: contract.vendorSignedName, vendorSignatureData: contract.vendorSignatureData, vendorSignedAt: contract.vendorSignedAt,
      marketSignedName: contract.marketSignedName, marketSignatureData: contract.marketSignatureData, marketSignedAt: contract.marketSignedAt,
    },
    vendor: { businessName: contract.vendor.businessName, contactName: contract.vendor.contactName, email: contract.vendor.email, commissionPercent: contract.vendor.commissionPercent },
    application: application ? {
      businessName: application.businessName, contactName: application.contactName, email: application.email, phone: application.phone,
      category: application.category, products: application.products, madeByYou: application.madeByYou, links: application.links,
      licenses: application.licenses, insurance: application.insurance, availability: application.availability,
      boothRequest: application.boothRequest, heardFrom: application.heardFrom, submittedAt: application.createdAt,
    } : null,
  });
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const contract = await byToken(params.token);
  if (!contract) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (contract.vendorSignedAt) return NextResponse.json({ error: "Already signed." }, { status: 400 });
  const { signatureData, typedName } = await req.json();
  if (typeof signatureData !== "string" || !signatureData.startsWith("data:image/png") || signatureData.length > 300000) {
    return NextResponse.json({ error: "Bad signature data." }, { status: 400 });
  }
  const name = String(typedName || "").trim().slice(0, 80);
  if (name.length < 3) return NextResponse.json({ error: "Type your full name." }, { status: 400 });
  await db.contract.update({
    where: { id: contract.id },
    data: { vendorSignedName: name, vendorSignatureData: signatureData, vendorSignedAt: new Date() },
  });
  try { await pushToAdmin("Contract signed ✍️", `${contract.vendor.businessName} signed booth ${contract.boothLabel}${contract.marketSignedAt ? " — fully executed ✅" : " — your countersignature is next"}`); } catch {}
  if (contract.marketSignedAt) {
    const app = await db.vendorApplication.findFirst({ where: { email: { equals: contract.vendor.email, mode: "insensitive" } }, orderBy: { createdAt: "desc" } });
    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
    try { await sendExecutedContractEmail(contract.vendor.email, contract.vendor.businessName, `${base}/sign/${params.token}`, app?.phoneType || ""); } catch {}
    try { await postFirstMonthRent(contract.id); } catch {}
  }
  return NextResponse.json({ ok: true });
}

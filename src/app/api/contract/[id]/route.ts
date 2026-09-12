import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isStaff, isAdmin, currentVendorId } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function canSee(contractVendorId: string) {
  if (isStaff()) return { role: "STAFF" as const };
  const vid = currentVendorId();
  if (vid && vid === contractVendorId) return { role: "VENDOR" as const };
  return null;
}

// GET: packet data — agreement + vendor + matched application + signatures
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const contract = await db.contract.findUnique({ where: { id: params.id }, include: { vendor: true } });
  if (!contract) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const who = await canSee(contract.vendorId);
  if (!who) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const application = await db.vendorApplication.findFirst({
    where: { email: { equals: contract.vendor.email, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    role: who.role,
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

// POST { signatureData, typedName } — vendor signs as vendor, admin signs as market
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const contract = await db.contract.findUnique({ where: { id: params.id } });
  if (!contract) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { signatureData, typedName } = await req.json();
  if (typeof signatureData !== "string" || !signatureData.startsWith("data:image/png") || signatureData.length > 300000) {
    return NextResponse.json({ error: "Bad signature data." }, { status: 400 });
  }
  const name = String(typedName || "").trim().slice(0, 80);
  if (name.length < 3) return NextResponse.json({ error: "Type your full name." }, { status: 400 });

  const vid = currentVendorId();
  if (vid && vid === contract.vendorId) {
    if (contract.vendorSignedAt) return NextResponse.json({ error: "Already signed." }, { status: 400 });
    await db.contract.update({ where: { id: contract.id }, data: { vendorSignedName: name, vendorSignatureData: signatureData, vendorSignedAt: new Date() } });
    return NextResponse.json({ ok: true });
  }
  if (isAdmin()) {
    if (contract.marketSignedAt) return NextResponse.json({ error: "Already signed." }, { status: 400 });
    await db.contract.update({ where: { id: contract.id }, data: { marketSignedName: name, marketSignatureData: signatureData, marketSignedAt: new Date() } });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

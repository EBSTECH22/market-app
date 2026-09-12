import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin, hashPassword } from "@/lib/auth";
import { sendWelcomeEmail } from "@/lib/email";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const vendors = await db.vendor.findMany({
    orderBy: { code: "asc" },
    select: { id: true, code: true, businessName: true, contactName: true, email: true, phone: true, commissionPercent: true, active: true, allowSelfCheckout: true },
  });
  const balances = await db.ledgerEntry.groupBy({ by: ["vendorId"], _sum: { amountCents: true } });
  const map = Object.fromEntries(balances.map((b) => [b.vendorId, b._sum.amountCents || 0]));
  return NextResponse.json({ vendors: vendors.map((v) => ({ ...v, balance: map[v.id] || 0 })) });
}

export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { businessName, contactName, email, phone, commissionPercent } = await req.json();
  if (!businessName?.trim() || !email?.includes("@")) {
    return NextResponse.json({ error: "Business name and a valid email are required." }, { status: 400 });
  }
  const count = await db.vendor.count();
  const code = `V${String(count + 1).padStart(2, "0")}`;
  const tempPassword = randomBytes(4).toString("hex");

  const vendor = await db.vendor.create({
    data: {
      code,
      businessName: businessName.trim(),
      contactName: (contactName || "").trim(),
      email: email.toLowerCase().trim(),
      phone: (phone || "").trim(),
      passwordHash: hashPassword(tempPassword),
      mustChangePassword: true,
      commissionPercent: Math.max(0, Math.min(50, Number(commissionPercent) || 0)),
    },
  });

  try {
    await sendWelcomeEmail(vendor, tempPassword);
  } catch (err) {
    console.error("welcome email failed", err);
  }

  return NextResponse.json({ vendor, tempPassword });
}

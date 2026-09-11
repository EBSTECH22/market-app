import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin, hashPassword } from "@/lib/auth";
import { randomBytes } from "crypto";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const data: { businessName?: string; contactName?: string; phone?: string; commissionPercent?: number; active?: boolean } = {};
  if (typeof body.businessName === "string" && body.businessName.trim()) data.businessName = body.businessName.trim();
  if (typeof body.contactName === "string") data.contactName = body.contactName.trim();
  if (typeof body.phone === "string") data.phone = body.phone.trim();
  if (body.commissionPercent !== undefined) {
    const c = Number(body.commissionPercent);
    if (Number.isNaN(c) || c < 0 || c > 50) return NextResponse.json({ error: "Commission must be 0-50%." }, { status: 400 });
    data.commissionPercent = c;
  }
  if (typeof body.active === "boolean") data.active = body.active;

  let tempPassword: string | undefined;
  if (body.resetPassword) {
    tempPassword = randomBytes(4).toString("hex");
  }

  if (!Object.keys(data).length && !tempPassword) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const vendor = await db.vendor.update({
    where: { id: params.id },
    data: { ...data, ...(tempPassword ? { passwordHash: hashPassword(tempPassword) } : {}) },
  });
  return NextResponse.json({ vendor, tempPassword });
}

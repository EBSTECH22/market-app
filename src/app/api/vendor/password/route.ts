import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId, hashPassword, verifyPassword } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const vendorId = currentVendorId();
  if (!vendorId) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const { currentPassword, newPassword } = await req.json();
  if (!newPassword || newPassword.length < 8) {
    return NextResponse.json({ error: "New password must be at least 8 characters." }, { status: 400 });
  }
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Forced first-change: they just authenticated with the temp password, so don't ask for it again.
  if (!vendor.mustChangePassword && !verifyPassword(currentPassword || "", vendor.passwordHash)) {
    return NextResponse.json({ error: "Current password is wrong." }, { status: 401 });
  }
  await db.vendor.update({ where: { id: vendorId }, data: { passwordHash: hashPassword(newPassword), mustChangePassword: false } });
  return NextResponse.json({ ok: true });
}

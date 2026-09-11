import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const { action, monthlyRentDollars, boothLabel } = body as { action?: string; monthlyRentDollars?: number; boothLabel?: string };

  const contract = await db.contract.findUnique({ where: { id: params.id } });
  if (!contract) return NextResponse.json({ error: "Contract not found." }, { status: 404 });

  if (action === "give_notice") {
    const nd = typeof (body as { noticeDate?: string }).noticeDate === "string" && (body as { noticeDate: string }).noticeDate
      ? new Date((body as { noticeDate: string }).noticeDate + "T12:00:00")
      : new Date();
    if (isNaN(nd.getTime())) return NextResponse.json({ error: "Bad notice date." }, { status: 400 });
    const endDate = new Date(nd.getTime() + 30 * 24 * 60 * 60 * 1000);
    const dim = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).getDate();
    const finalRentCents = Math.round((contract.monthlyRentCents * endDate.getDate()) / dim);
    const updated = await db.contract.update({
      where: { id: contract.id },
      data: { status: "TERMINATING", noticeGivenAt: nd, endDate },
    });
    return NextResponse.json({ contract: updated, finalRentCents });
  }

  if (action === "end_now") {
    const updated = await db.contract.update({
      where: { id: contract.id },
      data: { status: "ENDED", endDate: new Date() },
    });
    return NextResponse.json({ contract: updated });
  }

  const data: { monthlyRentCents?: number; boothLabel?: string } = {};
  if (monthlyRentDollars !== undefined) {
    const rent = Math.round(Number(monthlyRentDollars) * 100);
    if (Number.isNaN(rent) || rent < 0) return NextResponse.json({ error: "Invalid rent." }, { status: 400 });
    data.monthlyRentCents = rent;
  }
  if (typeof boothLabel === "string" && boothLabel.trim()) data.boothLabel = boothLabel.trim();
  if (!Object.keys(data).length) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const updated = await db.contract.update({ where: { id: contract.id }, data });
  return NextResponse.json({ contract: updated });
}

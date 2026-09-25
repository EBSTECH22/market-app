import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";

export const dynamic = "force-dynamic";

/**
 * A capture from the scanner probe, left where it can be read from anywhere.
 *
 * The tablet is the machine with the scanner on it and the machine nobody is
 * sitting at with a keyboard to describe what they saw. So the probe page
 * posts what it recorded, and whoever is at a laptop reads it back. It saves
 * somebody photographing a screen and emailing it to themselves at the end of
 * a long day.
 *
 * Kept in the settings table rather than a table of its own: it is one string,
 * it is overwritten every time, and it exists to be read once.
 */
export async function POST(req: NextRequest) {
  return runRoute("admin/keylog POST", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const text = String(body.text || "").slice(0, 8000);
    const value = `${new Date().toISOString()}\n${text}`;
    await db.setting.upsert({
      where: { key: "scannerProbe" },
      create: { key: "scannerProbe", value },
      update: { value },
    });
    return NextResponse.json({ ok: true });
  });
}

/** GET — read the last capture, from whatever machine you happen to be at. */
export async function GET() {
  return runRoute("admin/keylog GET", async () => {
    { const denied = await denyUnless("ops"); if (denied) return denied; }
    const row = await db.setting.findUnique({ where: { key: "scannerProbe" } });
    const raw = row?.value || "";
    const nl = raw.indexOf("\n");
    return NextResponse.json({
      at: nl > 0 ? raw.slice(0, nl) : "",
      text: nl > 0 ? raw.slice(nl + 1) : "",
    });
  });
}

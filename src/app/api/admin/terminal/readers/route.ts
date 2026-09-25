import { NextResponse, type NextRequest } from "next/server";
import { runRoute } from "@/lib/handler";
import { denyUnless } from "@/lib/perm";
import { recordAudit } from "@/lib/audit";
import { listReaders, listLocations, registerReader, forgetReader, ensureLocation, TerminalError } from "@/lib/terminal";
import { getTerminalReaderId, setTerminalReaderId, getTerminalLocationId, setTerminalLocationId } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** GET — every reader on the account, and which one the till uses. */
export async function GET() {
  return runRoute("admin/terminal/readers GET", async () => {
    { const denied = await denyUnless("config"); if (denied) return denied; }
    try {
      const [readers, locations, selected] = await Promise.all([
        listReaders(),
        listLocations(),
        getTerminalReaderId(),
      ]);
      return NextResponse.json({ readers, locations, selected });
    } catch (err) {
      if (err instanceof TerminalError) return NextResponse.json({ error: err.message, readers: [], locations: [] }, { status: 200 });
      throw err;
    }
  });
}

/** POST { registrationCode, label } — pair the reader in the shop. */
export async function POST(req: NextRequest) {
  return runRoute("admin/terminal/readers POST", async () => {
    { const denied = await denyUnless("config"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const code = String(body.registrationCode || "").trim();
    if (!code) return NextResponse.json({ error: "Type the code from the reader's screen." }, { status: 400 });

    try {
      /* A reader has to belong to a location before Stripe will take it, and
         the market has exactly one. Making it here rather than asking removes
         a setup step nobody would know how to answer. */
      let location = await getTerminalLocationId();
      if (!location) {
        location = await ensureLocation("Community Harvest", {
          line1: "510 N Main St",
          city: "Noble",
          state: "OK",
          postal_code: "73068",
          country: "US",
        });
        await setTerminalLocationId(location);
      }

      const reader = await registerReader(code, String(body.label || "Front till"), location);
      /* First reader paired becomes the one the till talks to — there is only
         ever going to be one at a market this size, and making them then pick
         it from a list of one is a step for nothing. */
      if (!(await getTerminalReaderId())) await setTerminalReaderId(reader.id);

      await recordAudit(
        {
          action: "SETTING_CHANGE",
          targetType: "TERMINAL_READER",
          targetId: reader.id,
          targetLabel: reader.label,
          detail: `Card reader "${reader.label}" paired (${reader.deviceType || "reader"}).`,
          after: { readerId: reader.id, label: reader.label },
        },
        req
      );
      return NextResponse.json({ ok: true, reader });
    } catch (err) {
      if (err instanceof TerminalError) return NextResponse.json({ error: err.message }, { status: 400 });
      const msg = String((err as { message?: string })?.message || "");
      /* Stripe's own wording here is unusually good — the code is wrong, or it
         has expired, and both are things the cashier fixes at the reader. */
      return NextResponse.json({ error: msg || "Stripe wouldn't take that code." }, { status: 400 });
    }
  });
}

/** PATCH { readerId } — which reader the till sends charges to. */
export async function PATCH(req: NextRequest) {
  return runRoute("admin/terminal/readers PATCH", async () => {
    { const denied = await denyUnless("config"); if (denied) return denied; }
    const body = await req.json().catch(() => ({}));
    const readerId = String(body.readerId || "").trim();
    await setTerminalReaderId(readerId);
    await recordAudit(
      {
        action: "SETTING_CHANGE",
        targetType: "TERMINAL_READER",
        targetId: readerId,
        targetLabel: readerId,
        detail: readerId ? `The till now charges to reader ${readerId}.` : "The till has no card reader set.",
        after: { readerId },
      },
      req
    );
    return NextResponse.json({ ok: true });
  });
}

/** DELETE ?id= — unpair it from Stripe. */
export async function DELETE(req: NextRequest) {
  return runRoute("admin/terminal/readers DELETE", async () => {
    { const denied = await denyUnless("config"); if (denied) return denied; }
    const id = req.nextUrl.searchParams.get("id") || "";
    if (!id) return NextResponse.json({ error: "Which reader?" }, { status: 400 });
    try {
      await forgetReader(id);
    } catch (err) {
      if (err instanceof TerminalError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
    if ((await getTerminalReaderId()) === id) await setTerminalReaderId("");
    await recordAudit(
      {
        action: "SETTING_CHANGE",
        targetType: "TERMINAL_READER",
        targetId: id,
        targetLabel: id,
        detail: `Card reader ${id} unpaired.`,
      },
      req
    );
    return NextResponse.json({ ok: true });
  });
}

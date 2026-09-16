import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { runRoute } from "@/lib/handler";
import { parseViewingText } from "@/lib/parseviewing";
import { sendViewingEmail } from "@/lib/email";
import { TZ, centralInputToDate } from "@/lib/time";

export const dynamic = "force-dynamic";

/** Loose labels rather than a DB enum, so adding a type needs no migration. */
export const EVENT_KINDS = ["VIEWING", "MARKET_DAY", "MOVE_IN", "MEETING", "REMINDER", "OTHER"] as const;
const STATUSES = ["SCHEDULED", "CONFIRMED", "DONE", "CANCELED", "NO_SHOW"] as const;

function bad(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

/**
 * Accepts "YYYY-MM-DDTHH:mm" from <input type="datetime-local">.
 *
 * The string is a WALL CLOCK time with no timezone, and it always means
 * Central — that's where the market is. Building it with `new Date(y, m, d, h)`
 * would interpret it in the server's timezone, which on Vercel is UTC, putting
 * every event 5-6 hours out. centralInputToDate does the conversion properly,
 * including DST.
 */
function toDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const hh = m[4] ? String(Number(m[4])).padStart(2, "0") : "00";
  const mm = m[5] ?? "00";
  const d = centralInputToDate(`${m[1]}-${m[2]}-${m[3]}T${hh}:${mm}`);
  return isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ GET --- */

export async function GET(req: NextRequest) {
  return runRoute("admin/calendar GET", async () => {
    if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const from = toDate(url.searchParams.get("from"));
    const to = toDate(url.searchParams.get("to"));

    // Default window: this month plus a generous margin either side, so a
    // month grid always has its leading and trailing days filled in.
    const now = new Date();
    const start = from ?? new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = to ?? new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59);

    const events = await db.calendarEvent.findMany({
      where: { startAt: { gte: start, lte: end } },
      orderBy: { startAt: "asc" },
    });

    // How many old free-text viewings are still sitting un-imported, so the UI
    // can offer the importer without the admin having to go looking.
    const legacy = await db.vendorApplication.findMany({
      where: { viewingAt: { not: "" } },
      select: { id: true, viewingAt: true },
    });
    const importedIds = new Set(
      (await db.calendarEvent.findMany({
        where: { applicationId: { not: "" }, kind: "VIEWING" },
        select: { applicationId: true },
      })).map((e) => e.applicationId)
    );
    const pendingImport = legacy.filter((a) => !importedIds.has(a.id)).length;

    return NextResponse.json({ events, pendingImport });
  });
}

/* ----------------------------------------------------------------- POST --- */

export async function POST(req: NextRequest) {
  return runRoute("admin/calendar POST", async () => {
    if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));

    /* -- one-time importer for viewings typed before the calendar existed -- */
    if (body.action === "import_legacy") {
      const apps = await db.vendorApplication.findMany({
        where: { viewingAt: { not: "" } },
        select: { id: true, viewingAt: true, businessName: true, contactName: true, phone: true, email: true },
      });
      const already = new Set(
        (await db.calendarEvent.findMany({
          where: { applicationId: { not: "" }, kind: "VIEWING" },
          select: { applicationId: true },
        })).map((e) => e.applicationId)
      );

      const imported: { businessName: string; when: string }[] = [];
      const flagged: { applicationId: string; businessName: string; raw: string; reason: string }[] = [];

      for (const a of apps) {
        if (already.has(a.id)) continue;
        const parsed = parseViewingText(a.viewingAt);
        if (!parsed.ok) {
          flagged.push({ applicationId: a.id, businessName: a.businessName, raw: a.viewingAt, reason: parsed.reason });
          continue;
        }
        // A dry run reports what would happen and writes nothing.
        if (!body.dryRun) {
          await db.calendarEvent.create({
            data: {
              title: `Viewing — ${a.businessName}`,
              kind: "VIEWING",
              startAt: parsed.date,
              allDay: !parsed.hadTime,
              applicationId: a.id,
              contactName: a.contactName || "",
              contactPhone: a.phone || "",
              contactEmail: a.email || "",
              notes: `Imported from "${a.viewingAt}"`,
            },
          });
        }
        imported.push({ businessName: a.businessName, when: parsed.date.toISOString() });
      }

      return NextResponse.json({
        ok: true,
        dryRun: !!body.dryRun,
        importedCount: imported.length,
        imported,
        flagged,
      });
    }

    /* ------------------------------ create an event ---------------------- */
    const title = String(body.title || "").trim().slice(0, 140);
    if (!title) return bad("Give the event a title.");

    const startAt = toDate(body.startAt);
    if (!startAt) return bad("Pick a date and time.");

    const endAt = toDate(body.endAt);
    if (endAt && endAt < startAt) return bad("The end time is before the start time.");

    const kind = EVENT_KINDS.includes(body.kind) ? body.kind : "OTHER";
    const status = STATUSES.includes(body.status) ? body.status : "SCHEDULED";

    const event = await db.calendarEvent.create({
      data: {
        title,
        kind,
        status,
        startAt,
        endAt: endAt ?? null,
        allDay: !!body.allDay,
        location: String(body.location || "").trim().slice(0, 140),
        notes: String(body.notes || "").trim().slice(0, 2000),
        applicationId: String(body.applicationId || "").trim(),
        vendorId: String(body.vendorId || "").trim(),
        contactName: String(body.contactName || "").trim().slice(0, 120),
        contactPhone: String(body.contactPhone || "").trim().slice(0, 40),
        contactEmail: String(body.contactEmail || "").trim().slice(0, 160),
      },
    });

    // Keep the application's own viewing line in step, and tell the applicant.
    let emailed = false;
    if (kind === "VIEWING" && event.applicationId) {
      const when = startAt.toLocaleString("en-US", {
        weekday: "long", month: "short", day: "numeric", timeZone: TZ,
        ...(event.allDay ? {} : { hour: "numeric", minute: "2-digit" }),
      });
      await db.vendorApplication.update({
        where: { id: event.applicationId },
        data: { viewingAt: when, stage: "VIEWING" },
      }).catch(() => {});
      if (body.notify && event.contactEmail) {
        try {
          await sendViewingEmail(event.contactEmail, event.contactName || "there", title.replace(/^Viewing — /, ""), when);
          emailed = true;
        } catch { /* the event is saved either way */ }
      }
    }

    return NextResponse.json({ event, emailed });
  });
}

/* ---------------------------------------------------------------- PATCH --- */

export async function PATCH(req: NextRequest) {
  return runRoute("admin/calendar PATCH", async () => {
    if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "").trim();
    if (!id) return bad("Which event?");

    const existing = await db.calendarEvent.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "That event no longer exists." }, { status: 404 });

    const data: Record<string, unknown> = {};

    if (body.title !== undefined) {
      const t = String(body.title).trim().slice(0, 140);
      if (!t) return bad("Title can't be blank.");
      data.title = t;
    }
    if (body.startAt !== undefined) {
      const d = toDate(body.startAt);
      if (!d) return bad("That start time isn't valid.");
      data.startAt = d;
    }
    if (body.endAt !== undefined) {
      const d = toDate(body.endAt);
      if (body.endAt && !d) return bad("That end time isn't valid.");
      data.endAt = d;
    }
    const finalStart = (data.startAt as Date) ?? existing.startAt;
    const finalEnd = (data.endAt as Date | null | undefined) ?? existing.endAt;
    if (finalEnd && finalEnd < finalStart) return bad("The end time is before the start time.");

    if (body.kind !== undefined) {
      if (!EVENT_KINDS.includes(body.kind)) return bad("Unknown event type.");
      data.kind = body.kind;
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return bad("Unknown status.");
      data.status = body.status;
    }
    if (body.allDay !== undefined) data.allDay = !!body.allDay;
    if (body.location !== undefined) data.location = String(body.location).trim().slice(0, 140);
    if (body.notes !== undefined) data.notes = String(body.notes).trim().slice(0, 2000);
    if (body.contactName !== undefined) data.contactName = String(body.contactName).trim().slice(0, 120);
    if (body.contactPhone !== undefined) data.contactPhone = String(body.contactPhone).trim().slice(0, 40);
    if (body.contactEmail !== undefined) data.contactEmail = String(body.contactEmail).trim().slice(0, 160);

    if (!Object.keys(data).length) return bad("Nothing to change.");

    const event = await db.calendarEvent.update({ where: { id }, data });

    if (event.kind === "VIEWING" && event.applicationId && data.startAt) {
      const when = event.startAt.toLocaleString("en-US", {
        weekday: "long", month: "short", day: "numeric", timeZone: TZ,
        ...(event.allDay ? {} : { hour: "numeric", minute: "2-digit" }),
      });
      await db.vendorApplication.update({
        where: { id: event.applicationId },
        data: { viewingAt: when },
      }).catch(() => {});
    }

    return NextResponse.json({ event });
  });
}

/* --------------------------------------------------------------- DELETE --- */

export async function DELETE(req: NextRequest) {
  return runRoute("admin/calendar DELETE", async () => {
    if (!isAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return bad("Which event?");
    const existing = await db.calendarEvent.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: true });
    await db.calendarEvent.delete({ where: { id } });
    if (existing.kind === "VIEWING" && existing.applicationId) {
      await db.vendorApplication.update({
        where: { id: existing.applicationId },
        data: { viewingAt: "" },
      }).catch(() => {});
    }
    return NextResponse.json({ ok: true });
  });
}

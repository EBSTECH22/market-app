import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runRoute } from "@/lib/handler";
import { enforceRateLimit } from "@/lib/ratelimit";
import { pushToAdmin } from "@/lib/push";
import { sendJobApplicationReceivedEmail, sendJobApplicationNotifyEmail } from "@/lib/email";
import { afterResponse } from "@/lib/after";

export const dynamic = "force-dynamic";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const POSITIONS = ["Cashier"];

/** The public job application. Anyone can send one; nobody can read them back here. */
export async function POST(req: NextRequest) {
  return runRoute("public/jobs POST", async () => {
    const b = await req.json().catch(() => ({}));
    if (b.website) return NextResponse.json({ ok: true }); // honeypot

    const t = (v: unknown, n: number) => String(v || "").trim().slice(0, n);
    const name = t(b.name, 80), email = t(b.email, 120).toLowerCase(), phone = t(b.phone, 25);
    if (!name) return NextResponse.json({ error: "Your name is needed." }, { status: 400 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "A real email is needed." }, { status: 400 });
    if (phone.replace(/\D/g, "").length < 10) return NextResponse.json({ error: "A phone number is needed — we call to set up interviews." }, { status: 400 });

    const limited = await enforceRateLimit(req, "job-apply", email, { limit: 5, windowMs: 60 * 60 * 1000 }, "Too many applications from here — try again in an hour.");
    if (limited) return limited;

    const days = (Array.isArray(b.days) ? b.days : []).map(String).filter((d: string) => DAYS.includes(d));
    if (!days.length) return NextResponse.json({ error: "Pick at least one day you can work." }, { status: 400 });
    const position = POSITIONS.includes(String(b.position)) ? String(b.position) : "Cashier";

    const app = await db.jobApplication.create({
      data: {
        position, name, email, phone,
        over18: b.over18 === "YES" || b.over18 === "NO" ? b.over18 : "",
        days: DAYS.filter((d) => days.includes(d)).join(","),
        hours: t(b.hours, 200),
        startDate: t(b.startDate, 30),
        experience: t(b.experience, 2000),
        history: t(b.history, 2000),
        why: t(b.why, 2000),
        references: t(b.references, 1000),
        resumeUrl: t(b.resumeUrl, 500),
        heardFrom: t(b.heardFrom, 200),
        notes: t(b.notes, 1000),
      },
    });

    await afterResponse(Promise.all([
      sendJobApplicationReceivedEmail(email, name, position).catch(() => false),
      sendJobApplicationNotifyEmail({ name, position, email, phone, days: app.days.replace(/,/g, ", "), hours: app.hours, startDate: app.startDate, experience: app.experience }).catch(() => false),
      pushToAdmin(`New ${position.toLowerCase()} applicant`, `${name} · ${app.days.replace(/,/g, ", ")}`, { url: "/admin/jobs" }).catch(() => 0),
    ]));

    return NextResponse.json({ ok: true });
  });
}

"use client";

/**
 * Apply to work at the market — cashier for now.
 *
 * Public, no account. One page, the questions a market owner actually asks
 * before calling someone in: when can you work, have you run a register, who
 * were you working for, why here.
 */
import { useState } from "react";
import { Button, Card, Checkbox, Field, Input, LinkButton, Note, Segmented, Textarea } from "@/components/ui";

const DAYS = [
  { v: "Mon", label: "Monday" }, { v: "Tue", label: "Tuesday" }, { v: "Wed", label: "Wednesday" },
  { v: "Thu", label: "Thursday" }, { v: "Fri", label: "Friday" }, { v: "Sat", label: "Saturday" }, { v: "Sun", label: "Sunday" },
];

const looksLikeEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());

export default function JobsPage() {
  const [f, setF] = useState<Record<string, string>>({});
  const [days, setDays] = useState<string[]>([]);
  const [over18, setOver18] = useState<"" | "YES" | "NO">("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [sent, setSent] = useState(false);

  const set = (k: string) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setErrors((x) => (x[k] ? { ...x, [k]: "" } : x));
  };

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!(f.name || "").trim()) e.name = "Your name, please.";
    if (!looksLikeEmail(f.email || "")) e.email = "A real email address, please.";
    if ((f.phone || "").replace(/\D/g, "").length < 10) e.phone = "A phone number with area code.";
    if (!days.length) e.days = "Pick at least one day.";
    if (!over18) e.over18 = "Pick one.";
    setErrors(e);
    if (Object.values(e).some(Boolean)) { setMsg("A few things need filling in — they're marked below."); return; }
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/public/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, days, over18, position: "Cashier" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(String(d.error || "That didn't send. Try again in a moment.")); return; }
      setSent(true);
      window.scrollTo({ top: 0 });
    } catch {
      setMsg("No connection — check your signal and try again.");
    } finally { setBusy(false); }
  };

  const header = (
    <header className="public-header">
      <div className="public-header-inner">
        <a href="/market" aria-label="Community Harvest" style={{ display: "flex", alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/wordmark.png" alt="Community Harvest" style={{ width: 150, maxWidth: "46vw", height: "auto", display: "block" }} />
        </a>
        <LinkButton href="/market" variant="ghost" size="sm" icon="arrowLeft" className="shrink0">Market</LinkButton>
      </div>
    </header>
  );

  if (sent) {
    return (
      <>
        {header}
        <main className="public-wrap public-narrow">
          <div className="hero">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" style={{ width: 110, margin: "0 auto var(--sp-3)", display: "block" }} />
            <h1 className="hero-title">Application sent</h1>
            <p className="hero-sub">
              Thanks{f.name ? `, ${f.name.trim().split(/\s+/)[0]}` : ""}. We read every application ourselves. If it looks like a fit,
              we&rsquo;ll call {f.phone ? f.phone.trim() : "you"} or email {f.email ? f.email.trim() : "you"} to set up a time to talk.
            </p>
          </div>
          <LinkButton href="/market" variant="primary" size="lg" block icon="store">See the market</LinkButton>
        </main>
      </>
    );
  }

  return (
    <>
      {header}
      <main className="public-wrap public-narrow">
        <div className="hero">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 110, margin: "0 auto var(--sp-3)", display: "block" }} />
          <h1 className="hero-title">Work at Community Harvest</h1>
          <p className="hero-sub">
            We&rsquo;re hiring <b>cashiers</b> for our indoor market in Noble — ringing up sales, handling cash and cards,
            and helping shoppers find what they&rsquo;re after. Fill this in and we&rsquo;ll be in touch.
          </p>
        </div>

        <Card title="About you" className="mb-4">
          <div className="stack g-4">
            <Field label="Your name" error={errors.name} required>
              {(p) => <Input {...p} value={f.name || ""} onChange={set("name")} autoComplete="name" />}
            </Field>
            <Field label="Phone" hint="We call to set up interviews." error={errors.phone} required>
              {(p) => <Input {...p} type="tel" inputMode="tel" value={f.phone || ""} onChange={set("phone")} autoComplete="tel" />}
            </Field>
            <Field label="Email" error={errors.email} required>
              {(p) => <Input {...p} type="email" inputMode="email" value={f.email || ""} onChange={set("email")} autoComplete="email" />}
            </Field>
            <Field label="Are you 18 or older?" error={errors.over18} required>
              {() => (
                <Segmented<"YES" | "NO">
                  label="Are you 18 or older?"
                  value={over18 as "YES" | "NO"}
                  onChange={(v) => { setOver18(v); setErrors((x) => ({ ...x, over18: "" })); }}
                  options={[{ value: "YES", label: "Yes" }, { value: "NO", label: "No" }]}
                />
              )}
            </Field>
          </div>
        </Card>

        <Card title="When you can work" className="mb-4">
          <div className="stack g-4">
            <Field label="Days you're available" error={errors.days} required>
              {() => (
                <div className="grid-auto" style={{ ["--min" as string]: "140px" }}>
                  {DAYS.map((d) => (
                    <Checkbox
                      key={d.v}
                      label={d.label}
                      checked={days.includes(d.v)}
                      onCheckedChange={(on) => { setDays((x) => (on ? [...x, d.v] : x.filter((y) => y !== d.v))); setErrors((x) => ({ ...x, days: "" })); }}
                    />
                  ))}
                </div>
              )}
            </Field>
            <Field label="Hours" hint="e.g. Saturdays 9–3, any time after school, 20 hours a week">
              {(p) => <Input {...p} value={f.hours || ""} onChange={set("hours")} />}
            </Field>
            <Field label="When could you start?">
              {(p) => <Input {...p} type="date" value={f.startDate || ""} onChange={set("startDate")} />}
            </Field>
          </div>
        </Card>

        <Card title="Experience" className="mb-4">
          <div className="stack g-4">
            <Field label="Cash register or customer service experience" hint="Where, how long, what you did. None is fine — say so.">
              {(p) => <Textarea {...p} rows={4} value={f.experience || ""} onChange={set("experience")} />}
            </Field>
            <Field label="Recent jobs" hint="Employer, your role, and roughly when.">
              {(p) => <Textarea {...p} rows={4} value={f.history || ""} onChange={set("history")} />}
            </Field>
            <Field label="Why would you like to work here?">
              {(p) => <Textarea {...p} rows={3} value={f.why || ""} onChange={set("why")} />}
            </Field>
            <Field label="References" hint="Optional — a name and phone number or two.">
              {(p) => <Textarea {...p} rows={2} value={f.references || ""} onChange={set("references")} />}
            </Field>
            <Field label="Resume link" hint="Optional — Google Drive, Dropbox, LinkedIn.">
              {(p) => <Input {...p} type="url" inputMode="url" value={f.resumeUrl || ""} onChange={set("resumeUrl")} />}
            </Field>
            <Field label="How did you hear about us?">
              {(p) => <Input {...p} value={f.heardFrom || ""} onChange={set("heardFrom")} />}
            </Field>
            <Field label="Anything else we should know?">
              {(p) => <Textarea {...p} rows={2} value={f.notes || ""} onChange={set("notes")} />}
            </Field>
            {/* Honeypot: hidden from people, filled in by bots. */}
            <input
              type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden
              value={f.website || ""} onChange={set("website")}
              style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
            />
          </div>
        </Card>

        {msg ? <div className="mb-3"><Note tone="error">{msg}</Note></div> : null}
        <Button variant="primary" size="lg" block icon="check" loading={busy} disabled={busy} onClick={() => void submit()}>
          Send my application
        </Button>
        <p className="t-xs t-muted mt-4" style={{ textAlign: "center" }}>
          Community Harvest · 510 N Main St, Noble, OK
        </p>
      </main>
    </>
  );
}

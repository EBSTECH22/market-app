"use client";

// A window onto what the tablet actually receives when the scanner fires.
//
// Three attempts at fixing the scanner from the outside have missed, each for
// a different reason, because every guess was about what the browser PROBABLY
// does with a USB scanner on Android. This page stops guessing: it records
// every keystroke exactly as it arrives — the key, the timing, and which field
// caught it — and shows it. Whatever is really happening will be plain here.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Note, PageHeader, LinkButton, Input, Field } from "@/components/ui";

type Hit = {
  n: number;
  key: string;
  code: string;
  keyCode: number;
  mods: string;
  target: string;
  /** Milliseconds since the previous keystroke. */
  gap: number;
  phase: string;
};

export default function KeyProbe() {
  const [hits, setHits] = useState<Hit[]>([]);
  const [typed, setTyped] = useState("");
  const lastRef = useRef(0);
  const nRef = useRef(0);

  const record = useCallback((e: KeyboardEvent, phase: string) => {
    const now = Date.now();
    const gap = lastRef.current ? now - lastRef.current : 0;
    lastRef.current = now;

    const el = e.target as HTMLElement | null;
    const target = el
      ? `${el.tagName.toLowerCase()}${(el as HTMLInputElement).name ? `[${(el as HTMLInputElement).name}]` : ""}${
          el.id ? `#${el.id}` : ""
        }`
      : "(none)";

    const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.metaKey && "meta", e.shiftKey && "shift"]
      .filter(Boolean)
      .join("+");

    setHits((h) => [
      ...h.slice(-59),
      { n: ++nRef.current, key: e.key, code: e.code, keyCode: e.keyCode, mods, target, gap, phase },
    ]);
    if (e.key.length === 1) setTyped((t) => t + e.key);
  }, []);

  useEffect(() => {
    const cap = (e: KeyboardEvent) => record(e, "capture");
    window.addEventListener("keydown", cap, true);
    return () => window.removeEventListener("keydown", cap, true);
  }, [record]);

  const summary = (() => {
    const chars = hits.filter((h) => h.key.length === 1);
    if (chars.length < 2) return "";
    const gaps = chars.slice(1).map((c) => c.gap);
    const avg = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    const enders = hits.filter((h) => h.key.length > 1).map((h) => h.key);
    return `${chars.length} characters, ${avg}ms apart on average${
      enders.length ? `, then: ${enders.join(", ")}` : ", and no finishing key"
    }`;
  })();

  const [sent, setSent] = useState("");
  const [fetched, setFetched] = useState<{ at: string; text: string } | null>(null);

  /** The capture, as plain text somebody can read. */
  const asText = useCallback(() => {
    const lines = hits.map(
      (h) =>
        `${String(h.n).padEnd(4)}${(h.key === " " ? "(space)" : h.key).slice(0, 12).padEnd(13)}` +
        `${h.code.slice(0, 14).padEnd(15)}${String(h.keyCode).padEnd(5)}${String(h.gap).padEnd(6)}${h.target}` +
        `${h.mods ? ` (${h.mods})` : ""}`
    );
    return [
      `device: ${typeof navigator === "undefined" ? "?" : navigator.userAgent}`,
      summary ? `summary: ${summary}` : "summary: (not enough keystrokes)",
      `joined: ${typed}`,
      "",
      "#   key          code           kc   gap   where",
      ...lines,
    ].join("\n");
  }, [hits, summary, typed]);

  const send = async () => {
    setSent("sending…");
    try {
      const r = await fetch("/api/admin/keylog", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: asText() }),
      });
      setSent(r.ok ? "Sent. It can be read from any device now." : "Couldn't send it.");
    } catch {
      setSent("Couldn't send it — no connection.");
    }
  };

  const load = async () => {
    const r = await fetch("/api/admin/keylog");
    if (r.ok) setFetched(await r.json());
  };

  const clear = () => {
    setHits([]);
    setTyped("");
    lastRef.current = 0;
    nRef.current = 0;
  };

  return (
    <main className="content content-narrow">
      <div className="mb-3">
        <LinkButton href="/admin" variant="ghost" size="sm" icon="arrowLeft">Admin</LinkButton>
      </div>

      <PageHeader
        title="Scanner probe"
        subtitle="Scan something with the cursor in the box below, then send me a screenshot of this page."
      />

      <div className="mb-4">
        <Card title="Scan into here">
          <div className="stack g-3">
            <Field label="Aim the scanner at this box">
              {(p) => <Input {...p} name="probe" className="mono" placeholder="scan now" autoComplete="off" />}
            </Field>
            <Field label="And a second box, to see where the cursor goes">
              {(p) => <Input {...p} name="second" className="mono" placeholder="(watch this one)" autoComplete="off" />}
            </Field>
            {summary ? <Note tone="info" title="What just arrived">{summary}</Note> : null}
            <div className="row wrap g-2">
              <Button variant="primary" icon="mail" disabled={!hits.length} onClick={() => void send()}>
                Send this to the office
              </Button>
              <Button variant="secondary" icon="refresh" onClick={clear}>Clear and try again</Button>
              <Button variant="ghost" icon="download" onClick={() => void load()}>Read the last one</Button>
            </div>
            {sent ? <Note tone="info">{sent}</Note> : null}
            {fetched?.text ? (
              <div className="stack g-1">
                <span className="t-label">Last capture — {fetched.at}</span>
                <code className="mono t-xs" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{fetched.text}</code>
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      <Card
        title={`Keystrokes (${hits.length})`}
        subtitle="Newest at the bottom. 'gap' is milliseconds since the one before."
      >
        {hits.length === 0 ? (
          <Note tone="neutral">Nothing yet. Scan something.</Note>
        ) : (
          <div className="stack g-1">
            <span className="mono t-xs t-muted">{"#   key          code           kc   gap   where"}</span>
            {hits.map((h) => (
              <span key={h.n} className="mono t-xs" style={{ whiteSpace: "pre" }}>
                {String(h.n).padEnd(4)}
                {(h.key === " " ? "(space)" : h.key).slice(0, 12).padEnd(13)}
                {h.code.slice(0, 14).padEnd(15)}
                {String(h.keyCode).padEnd(5)}
                {String(h.gap).padEnd(6)}
                {h.target}
                {h.mods ? ` (${h.mods})` : ""}
              </span>
            ))}
          </div>
        )}

        {typed ? (
          <div className="stack g-1 mt-3">
            <span className="t-label">Characters, joined up</span>
            <code className="mono t-sm" style={{ wordBreak: "break-all" }}>{typed}</code>
          </div>
        ) : null}
      </Card>
    </main>
  );
}

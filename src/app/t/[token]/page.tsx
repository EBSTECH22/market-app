"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Field, LinkButton, Note, Skeleton, Textarea } from "@/components/ui";
import { fmtDateShort } from "@/lib/format";

type Msg = { id: string; sender: string; body: string; createdAt: string };
type T = { type: string; status: string; customerName: string; vendorName: string; messages: Msg[] };

export default function ThreadPage({ params }: { params: { token: string } }) {
  const [thread, setThread] = useState<T | null>(null);
  const [missing, setMissing] = useState(false);
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/public/thread/${params.token}`);
    if (!res.ok) { setMissing(true); return; }
    setThread((await res.json()).thread);
  }, [params.token]);

  useEffect(() => { load(); }, [load]);

  const send = async () => {
    setMsg("");
    setSending(true);
    try {
      const res = await fetch(`/api/public/thread/${params.token}/msg`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, website: "" }),
      });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error || "Couldn't send."); return; }
      setBody("");
      await load();
    } finally {
      setSending(false);
    }
  };

  if (missing) {
    return (
      <main className="public-wrap public-narrow">
        <Card title="We couldn't find that conversation">
          <div className="stack g-4">
            <Note tone="error">
              This link doesn&rsquo;t match a conversation. Open the most recent link from your email — that
              link is the only way back in, so keep the email.
            </Note>
            <LinkButton href="/market" variant="secondary" size="lg" block icon="store">
              See the market
            </LinkButton>
          </div>
        </Card>
      </main>
    );
  }

  if (!thread) {
    return (
      <main className="public-wrap public-narrow" aria-busy="true">
        <span className="sr-only">Loading your conversation…</span>
        <Card>
          <div className="stack g-3">
            <Skeleton height={54} />
            <Skeleton height={54} style={{ marginLeft: "var(--sp-6)" }} />
            <Skeleton height={54} />
          </div>
        </Card>
      </main>
    );
  }

  const label = thread.type === "PREORDER" ? "Pre-order" : thread.type === "REQUEST" ? "Request" : "Complaint";

  return (
    <main className="public-wrap public-narrow">
      <div className="stack g-1 mb-4" style={{ textAlign: "center" }}>
        <h1 className="t-page">{label} — {thread.vendorName}</h1>
        <p className="t-xs t-muted">Private conversation · keep your email link to return here</p>
      </div>

      <Card>
        <div className="stack g-4">
          {thread.messages.length === 0 ? (
            <p className="t-sm t-muted">Nothing has been said yet — start the conversation below.</p>
          ) : (
            <ol className="stack g-3">
              {thread.messages.map((m) => {
                const mine = m.sender === "CUSTOMER";
                return (
                  <li
                    key={m.id}
                    className="stack g-1"
                    style={{
                      padding: "var(--sp-3)",
                      borderRadius: "var(--r-lg)",
                      border: "1px solid",
                      marginLeft: mine ? 0 : "var(--sp-6)",
                      marginRight: mine ? "var(--sp-6)" : 0,
                      background: mine ? "var(--bg-sunken)" : "var(--accent-soft)",
                      borderColor: mine ? "var(--border)" : "var(--accent-border)",
                      color: mine ? "var(--text)" : "var(--accent-text)",
                    }}
                  >
                    <span className="t-label" style={{ color: "inherit", opacity: 0.75 }}>
                      {mine ? thread.customerName : thread.vendorName} · {fmtDateShort(m.createdAt)}
                    </span>
                    <span className="t-sm" style={{ whiteSpace: "pre-wrap" }}>{m.body}</span>
                  </li>
                );
              })}
            </ol>
          )}

          {thread.status === "CLOSED" ? (
            <Note tone="neutral" title="Conversation closed">
              The vendor closed this conversation, so no new replies can be sent.
            </Note>
          ) : (
            <div className="stack g-3">
              <Field label="Reply" hint="The vendor is emailed when you send.">
                {(p) => (
                  <Textarea
                    {...p}
                    rows={3}
                    value={body}
                    placeholder="Type your reply…"
                    onChange={(e) => setBody(e.target.value)}
                  />
                )}
              </Field>
              <Button
                variant="primary"
                size="lg"
                block
                icon="message"
                loading={sending}
                disabled={!body.trim()}
                onClick={send}
              >
                Send
              </Button>
              {msg && <Note tone="error">{msg}</Note>}
            </div>
          )}
        </div>
      </Card>
    </main>
  );
}

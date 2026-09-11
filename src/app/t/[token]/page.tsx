"use client";

import { useCallback, useEffect, useState } from "react";

type Msg = { id: string; sender: string; body: string; createdAt: string };
type T = { type: string; status: string; customerName: string; vendorName: string; messages: Msg[] };

export default function ThreadPage({ params }: { params: { token: string } }) {
  const [thread, setThread] = useState<T | null>(null);
  const [missing, setMissing] = useState(false);
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/public/thread/${params.token}`);
    if (!res.ok) { setMissing(true); return; }
    setThread((await res.json()).thread);
  }, [params.token]);

  useEffect(() => { load(); }, [load]);

  const send = async () => {
    setMsg("");
    const res = await fetch(`/api/public/thread/${params.token}/msg`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, website: "" }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(data.error || "Couldn't send."); return; }
    setBody("");
    await load();
  };

  if (missing) return <main style={{ padding: 60, textAlign: "center" }}>Conversation not found — check the link from your email.</main>;
  if (!thread) return <main style={{ padding: 60, textAlign: "center" }}>Loading…</main>;

  const label = thread.type === "PREORDER" ? "Pre-order" : thread.type === "REQUEST" ? "Request" : "Complaint";

  return (
    <main style={{ maxWidth: 520, margin: "0 auto", padding: "26px 14px 70px" }}>
      <div style={{ textAlign: "center", marginBottom: 12 }}>
        <div className="display" style={{ fontSize: 20 }}>{label.toUpperCase()} — {thread.vendorName.toUpperCase()}</div>
        <div style={{ fontSize: 12, color: "var(--ash)" }}>Private conversation · keep your email link to return here</div>
      </div>
      <div className="card">
        {thread.messages.map((m) => (
          <div key={m.id} style={{
            margin: "8px 0", padding: "8px 10px", border: "1px solid #000", fontSize: 13.5,
            background: m.sender === "CUSTOMER" ? "#fff" : "#000", color: m.sender === "CUSTOMER" ? "#000" : "#fff",
            marginLeft: m.sender === "CUSTOMER" ? 0 : 24, marginRight: m.sender === "CUSTOMER" ? 24 : 0,
          }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, opacity: 0.7 }}>
              {m.sender === "CUSTOMER" ? thread.customerName : thread.vendorName} · {new Date(m.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </div>
            {m.body}
          </div>
        ))}
        {thread.status === "CLOSED" ? (
          <p style={{ fontSize: 13, fontWeight: 700, textAlign: "center", marginTop: 10 }}>— conversation closed by the vendor —</p>
        ) : (
          <>
            <label>Reply</label>
            <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
            <div style={{ marginTop: 10 }}><button className="btn" onClick={send}>SEND</button></div>
            {msg && <p className="err">{msg}</p>}
          </>
        )}
      </div>
    </main>
  );
}

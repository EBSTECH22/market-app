"use client";

/**
 * Every conversation a vendor has, in one texting-style screen:
 *
 *   Vendor chat          the whole market's board (no notifications)
 *   Community Harvest    their private line to the office
 *   Everyone / groups    messages the office sent to everyone or a group
 *   Other vendors        private chats with another vendor (the office can't see these)
 *
 * List on the left, the open conversation on the right; on a phone the list
 * and the conversation take turns. The reply box is always at the bottom.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, Badge, Modal, SearchInput, EmptyState, useToast } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { usePulse } from "@/lib/usePulse";

type Conv = { id: string; kind: string; title: string; lastAt: string; lastBody: string; lastFromOffice: boolean; unread: number };
type Msg = { id: string; fromOffice: boolean; mine: boolean; name: string; body: string; createdAt: string };
type BoardMsg = { id: string; vendorId: string; name: string; body: string; createdAt: string };

const BOARD = "__board__";
const KIND: Record<string, string> = { ALL: "From the office · everyone", TAG: "From the office · group", DIRECT: "Private · office", CUSTOM: "From the office · group", VENDOR: "Private · vendor" };

export function VendorMessages({ focus, onFocused, onUnread }: {
  /** A conversation to open (from the Home banner's Reply button). */
  focus?: string;
  onFocused?: () => void;
  /** Total unread, for the tab badge. */
  onUnread?: (n: number) => void;
}) {
  const toast = useToast();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [board, setBoard] = useState<BoardMsg[]>([]);
  const [me, setMe] = useState("");
  const [openId, setOpenId] = useState("");
  const [thread, setThread] = useState<{ conversation: { id: string; kind: string; title: string }; messages: Msg[] } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [boardSeen, setBoardSeen] = useState(0);

  const seenKey = me ? `ch_board_seen_${me}` : "";
  useEffect(() => {
    if (!seenKey) return;
    try { setBoardSeen(Number(window.localStorage.getItem(seenKey) || 0)); } catch { /* storage blocked */ }
  }, [seenKey]);
  const markBoardSeen = useCallback(() => {
    const now = Date.now();
    setBoardSeen(now);
    try { if (seenKey) window.localStorage.setItem(seenKey, String(now)); } catch { /* storage blocked */ }
  }, [seenKey]);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([fetch("/api/vendor/messages"), fetch("/api/vendor/chat")]);
    if (a.ok) setConvs(((await a.json()).conversations) || []);
    if (b.ok) { const d = await b.json(); setBoard(d.messages || []); setMe(d.me || ""); }
  }, []);
  const loadThread = useCallback(async (id: string) => {
    if (!id || id === BOARD) { setThread(null); return; }
    const r = await fetch(`/api/vendor/messages?id=${encodeURIComponent(id)}`);
    if (r.ok) setThread(await r.json());
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadThread(openId).then(() => { if (openId && openId !== BOARD) void load(); }); }, [openId, loadThread, load]);
  usePulse(() => { void load(); if (openId && openId !== BOARD) void loadThread(openId); });

  useEffect(() => {
    if (focus) { setOpenId(focus); onFocused?.(); }
  }, [focus, onFocused]);

  /* While the board is open, everything on it counts as seen. */
  useEffect(() => { if (openId === BOARD) markBoardSeen(); }, [openId, board.length, markBoardSeen]);

  const boardUnread = board.filter((m) => m.vendorId !== me && new Date(m.createdAt).getTime() > boardSeen).length;
  const total = convs.reduce((n, c) => n + c.unread, 0) + (boardSeen ? boardUnread : 0);
  useEffect(() => { onUnread?.(total); }, [total, onUnread]);

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [openId, thread?.messages.length, board.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy || !openId) return;
    setBusy(true);
    try {
      const r = openId === BOARD
        ? await fetch("/api/vendor/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) })
        : await fetch("/api/vendor/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reply", conversationId: openId, body }) });
      if (!r.ok) { toast.error("Didn't send", "Try again in a moment."); return; }
      setText("");
      if (openId === BOARD) await load(); else await loadThread(openId);
    } finally { setBusy(false); }
  };

  const start = async (payload: object) => {
    const r = await fetch("/api/vendor/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.conversationId) { toast.error("Couldn't open that", String(d.error || "Try again in a moment.")); return; }
    setPicker(false);
    await load();
    setOpenId(d.conversationId);
  };

  const lastBoard = board[board.length - 1];
  const office = convs.find((c) => c.kind === "DIRECT");

  /* The open conversation's messages, in one shape for both kinds. */
  const shown: Msg[] = openId === BOARD
    ? board.map((m) => ({ id: m.id, fromOffice: m.vendorId === "MARKET", mine: m.vendorId === me, name: m.name, body: m.body, createdAt: m.createdAt }))
    : thread?.messages || [];
  const title = openId === BOARD ? "Vendor chat" : thread?.conversation.title || "";
  const sub = openId === BOARD ? "Everyone at the market reads this. Nobody gets notified." : thread ? KIND[thread.conversation.kind] || "" : "";

  return (
    <div className={`vm-shell${openId ? " has-open" : ""}`}>
      <style>{CSS}</style>
      <aside className="vm-list">
        <div className="vm-list-head">
          <b>Messages</b>
          <Button size="sm" variant="primary" icon="plus" onClick={() => setPicker(true)}>New</Button>
        </div>
        <button type="button" className={`vm-item${openId === BOARD ? " on" : ""}`} onClick={() => setOpenId(BOARD)}>
          <span className="row between g-2" style={{ alignItems: "baseline" }}>
            <b>Vendor chat</b>
            {boardSeen && boardUnread ? <span className="vm-unread">{boardUnread}</span> : null}
          </span>
          <span className="t-xs t-muted">Everyone at the market</span>
          <span className="t-sm t-muted truncate">{lastBoard ? `${lastBoard.name}: ${lastBoard.body}` : "No messages yet"}</span>
        </button>
        {!office ? (
          <button type="button" className="vm-item" onClick={() => void start({ action: "start" })}>
            <b>Community Harvest office</b>
            <span className="t-sm t-muted">Tap to message the office</span>
          </button>
        ) : null}
        {convs.map((c) => (
          <button key={c.id} type="button" className={`vm-item${c.id === openId ? " on" : ""}`} onClick={() => setOpenId(c.id)}>
            <span className="row between g-2" style={{ alignItems: "baseline" }}>
              <b className="truncate">{c.title}</b>
              {c.unread ? <span className="vm-unread">{c.unread}</span> : <span className="t-xs t-muted">{fmtDateTime(c.lastAt)}</span>}
            </span>
            <span className="t-xs t-muted">{KIND[c.kind] || ""}</span>
            <span className="t-sm t-muted truncate">{c.lastBody}</span>
          </button>
        ))}
      </aside>

      <section className="vm-thread">
        {!openId ? (
          <div className="vm-empty">
            <Icon name="message" size={36} />
            <b>Pick a conversation</b>
            <span className="t-sm">Or tap New to message the office or another vendor.</span>
          </div>
        ) : (
          <>
            <header className="vm-head">
              <button type="button" className="vm-back" onClick={() => setOpenId("")} aria-label="Back to messages">
                <Icon name="arrowLeft" size={18} />
              </button>
              <div className="stack" style={{ minWidth: 0 }}>
                <b className="truncate">{title}</b>
                <span className="t-xs t-muted truncate">{sub}</span>
              </div>
            </header>
            <div className="vm-body">
              {shown.length === 0 ? (
                <div className="vm-empty"><span className="t-sm">No messages yet. Say hello below.</span></div>
              ) : (
                shown.map((m) => (
                  <div key={m.id} className={`vm-row${m.mine ? " mine" : ""}${m.fromOffice ? " office" : ""}`}>
                    <div className="t-xs t-muted">{m.fromOffice ? "📣 Community Harvest" : m.mine ? "You" : m.name} · {fmtDateTime(m.createdAt)}</div>
                    <div className="vm-bubble">{m.body}</div>
                  </div>
                ))
              )}
              <div ref={endRef} />
            </div>
            <footer className="vm-compose">
              <textarea
                className="textarea"
                rows={2}
                maxLength={openId === BOARD ? 1000 : 2000}
                value={text}
                placeholder={openId === BOARD ? "Message everyone…" : "Message…"}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              />
              <Button variant="primary" icon="message" loading={busy} disabled={busy || !text.trim()} onClick={() => void send()}>Send</Button>
            </footer>
          </>
        )}
      </section>

      {picker ? <NewChat onClose={() => setPicker(false)} onOffice={() => void start({ action: "start" })} onVendor={(id) => void start({ action: "dm", vendorId: id })} /> : null}
    </div>
  );
}

function NewChat({ onClose, onOffice, onVendor }: { onClose: () => void; onOffice: () => void; onVendor: (id: string) => void }) {
  const [vendors, setVendors] = useState<{ id: string; businessName: string; code: string }[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    void fetch("/api/vendor/messages?vendors=1").then(async (r) => setVendors(r.ok ? (await r.json()).vendors || [] : []));
  }, []);
  const shown = useMemo(
    () => (vendors || []).filter((v) => !q.trim() || v.businessName.toLowerCase().includes(q.trim().toLowerCase())),
    [vendors, q]
  );
  return (
    <Modal open onClose={onClose} title="New message">
      <div className="stack g-3">
        <Button variant="primary" block icon="mail" onClick={onOffice}>Message the Community Harvest office</Button>
        <div className="stack g-2">
          <b className="t-sm">Or a private message to another vendor</b>
          <SearchInput value={q} onValueChange={setQ} placeholder="Find a vendor" aria-label="Find a vendor" />
          <div className="stack g-1" style={{ maxHeight: 300, overflowY: "auto" }}>
            {vendors === null ? (
              <span className="t-sm t-muted">Loading…</span>
            ) : shown.length === 0 ? (
              <EmptyState icon="search" title="No vendors match" body="Try part of their business name." />
            ) : (
              shown.map((v) => (
                <button key={v.id} type="button" className="vm-item" onClick={() => onVendor(v.id)}>
                  <span className="row between g-2"><b>{v.businessName}</b><Badge tone="neutral">{v.code}</Badge></span>
                </button>
              ))
            )}
          </div>
          <span className="t-xs t-muted">Private messages between vendors are only seen by the two of you.</span>
        </div>
      </div>
    </Modal>
  );
}

const CSS = `
.vm-shell { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 12px; height: calc(100dvh - 190px); min-height: 460px; }
.vm-list { min-height: 0; overflow-y: auto; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
.vm-list-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--surface); border-bottom: 1px solid var(--border-subtle); }
.vm-item { width: 100%; display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; text-align: left; border: 0; border-bottom: 1px solid var(--border-subtle); background: transparent; color: var(--text); cursor: pointer; }
.vm-item:hover { background: var(--surface-hover); }
.vm-item.on { background: var(--accent-soft); }
.vm-unread { min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.vm-thread { min-width: 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); overflow: hidden; }
.vm-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border-subtle); }
.vm-back { display: none; border: 0; background: none; color: var(--text); padding: 4px; }
.vm-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; background: var(--bg-sunken); display: flex; flex-direction: column; gap: 12px; }
.vm-row { max-width: 80%; display: flex; flex-direction: column; gap: 3px; align-self: flex-start; }
.vm-row.mine { align-self: flex-end; align-items: flex-end; }
.vm-bubble { padding: 9px 12px; border-radius: 14px; border: 1px solid var(--border); background: var(--surface); white-space: pre-wrap; word-break: break-word; font-size: var(--fs-md); }
.vm-row.mine .vm-bubble { background: var(--accent); border-color: var(--accent); color: #fff; }
.vm-row.office .vm-bubble { border-color: var(--accent); background: var(--accent-soft); }
.vm-compose { flex: 0 0 auto; display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.vm-compose textarea { flex: 1 1 auto; min-height: 44px; max-height: 140px; resize: vertical; }
.vm-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); padding: 24px; text-align: center; }
@media (max-width: 820px) {
  .vm-shell { grid-template-columns: 1fr; height: calc(100dvh - 170px); }
  .vm-shell.has-open .vm-list { display: none; }
  .vm-shell:not(.has-open) .vm-thread { display: none; }
  .vm-back { display: inline-flex; }
}
`;

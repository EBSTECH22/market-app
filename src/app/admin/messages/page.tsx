"use client";

/**
 * The office's messages, as one texting app — the same screen vendors have.
 *
 *   Vendor chat          the whole market's board
 *   Everyone / groups    the office to everyone, a group, or picked vendors
 *   Each vendor          the office's private line with them
 *   Between vendors      vendor-to-vendor chats (read only for the office)
 *
 * Every message notifies the people it's for. Email is an extra, per message.
 * Group texts go from the owner's own phone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button, LinkButton, Input, Checkbox, Note, Modal, Segmented,
  SearchInput, EmptyState, Icon, useToast, useDialog,
} from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { usePulse } from "@/lib/usePulse";

type Conv = {
  id: string; kind: "ALL" | "TAG" | "DIRECT" | "CUSTOM" | "VENDOR"; title: string; tagId: string; lastAt: string;
  lastBody: string; lastFromOffice: boolean; unread: number; memberCount: number; hasMessages: boolean;
};
type Tag = { id: string; name: string; count: number };
type Vendor = { id: string; businessName: string; code: string; email: boolean; phone: string; push: boolean; tagIds: string[] };
type Thread = {
  conversation: { id: string; kind: string; title: string; tagId: string };
  members: { vendorId: string; name: string; joinedAt: string; lastReadAt: string | null }[];
  messages: { id: string; fromOffice: boolean; vendorId: string; name: string; body: string; createdAt: string }[];
  phones: string[];
};
type BoardMsg = { id: string; fromOffice: boolean; name: string; body: string; createdAt: string };

const KIND_LABEL: Record<string, string> = { ALL: "Everyone", TAG: "Group", DIRECT: "Private", CUSTOM: "Picked vendors", VENDOR: "Between vendors · read only" };
const BOARD = "__board__";
const SEEN_KEY = "ch_admin_board_seen";

/** A Messages link with every number and the text filled in, for this phone. */
function smsLink(phones: string[], text: string): string {
  const body = encodeURIComponent(text);
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iPhone|iPad|iPod/i.test(ua)) return `sms:/open?addresses=${phones.join(",")}&body=${body}`;
  return `sms:${phones.join(",")}?body=${body}`;
}

export default function MessagesPage() {
  const toast = useToast();
  const dialog = useDialog();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [board, setBoard] = useState<BoardMsg[]>([]);
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState<string>("");
  const [thread, setThread] = useState<Thread | null>(null);
  const [receiptsFor, setReceiptsFor] = useState<string>("");

  const [text, setText] = useState("");
  const [email, setEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastText, setLastText] = useState<{ phones: string[]; text: string } | null>(null);

  const [newOpen, setNewOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);

  /* Board unread, remembered on this device. */
  const [boardSeen, setBoardSeen] = useState(0);
  useEffect(() => { try { setBoardSeen(Number(window.localStorage.getItem(SEEN_KEY) || 0)); } catch { /* storage blocked */ } }, []);
  const markBoardSeen = useCallback(() => {
    const now = Date.now();
    setBoardSeen(now);
    try { window.localStorage.setItem(SEEN_KEY, String(now)); } catch { /* storage blocked */ }
  }, []);

  const load = useCallback(async () => {
    const [r, rb] = await Promise.all([fetch("/api/admin/messages"), fetch("/api/admin/messages?board=1")]);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(String(d.error || "Couldn't load messages.")); return; }
    setErr("");
    setConvs(d.conversations || []);
    setTags(d.tags || []);
    setVendors(d.vendors || []);
    if (rb.ok) setBoard(((await rb.json().catch(() => ({}))).messages) || []);
  }, []);

  const loadThread = useCallback(async (id: string) => {
    if (!id || id === BOARD) { setThread(null); return; }
    const r = await fetch(`/api/admin/messages?id=${encodeURIComponent(id)}`);
    const d = await r.json().catch(() => ({}));
    if (r.ok) setThread(d as Thread);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadThread(openId).then(() => { if (openId && openId !== BOARD) void load(); }); }, [openId, loadThread, load]);
  usePulse(() => { void load(); if (openId && openId !== BOARD) void loadThread(openId); });
  useEffect(() => { if (openId === BOARD) markBoardSeen(); }, [openId, board.length, markBoardSeen]);

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [thread?.messages.length, board.length, openId]);

  const open = (id: string) => {
    if (id !== openId) setThread(null);
    setOpenId(id);
    setText(""); setLastText(null); setReceiptsFor("");
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy || !openId) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(openId === BOARD
          ? { action: "board-post", body }
          : { action: "send", conversationId: openId, body, push: true, email }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Didn't send", String(d.error || "Try again in a moment.")); return; }
      setText("");
      if (openId !== BOARD) {
        if (email) toast.success("Sent", `${d.emailed} email${d.emailed === 1 ? "" : "s"}${d.emailFailed?.length ? ` — email failed for ${d.emailFailed.join(", ")}` : ""}.`);
        setLastText({ phones: d.phones || [], text: `Community Harvest: ${body}` });
        setEmail(false);
        await loadThread(openId);
      }
      await load();
    } finally { setBusy(false); }
  };

  /* Read receipts for one office message: who had joined by then, and who has looked since. */
  const receipts = (m: Thread["messages"][number]) => {
    if (!thread) return { read: [] as string[], unread: [] as string[] };
    const at = new Date(m.createdAt).getTime();
    const eligible = thread.members.filter((x) => new Date(x.joinedAt).getTime() <= at + 1000);
    const read = eligible.filter((x) => x.lastReadAt && new Date(x.lastReadAt).getTime() >= at).map((x) => x.name);
    const unread = eligible.filter((x) => !(x.lastReadAt && new Date(x.lastReadAt).getTime() >= at)).map((x) => x.name);
    return { read, unread };
  };

  const boardUnread = boardSeen ? board.filter((m) => !m.fromOffice && new Date(m.createdAt).getTime() > boardSeen).length : 0;
  const lastBoard = board[board.length - 1];
  const readOnly = thread?.conversation.kind === "VENDOR";
  const title = openId === BOARD ? "Vendor chat" : thread?.conversation.title || "";
  const sub = openId === BOARD
    ? "Every vendor reads this. You post as Community Harvest."
    : thread ? `${KIND_LABEL[thread.conversation.kind] || ""} · ${thread.members.map((m) => m.name).join(", ") || "Nobody yet"}` : "";

  return (
    <main className="content" style={{ maxWidth: 1180 }}>
      <style>{CSS}</style>
      <div className="row between wrap g-2 mb-3" style={{ alignItems: "center" }}>
        <LinkButton href="/admin" variant="ghost" size="sm" icon="arrowLeft">Admin</LinkButton>
        <Button variant="secondary" size="sm" icon="users" onClick={() => setGroupsOpen(true)}>Groups</Button>
      </div>
      {err ? <Note tone="error">{err}</Note> : null}

      <div className={`msg-shell${openId ? " has-open" : ""}`}>
        <aside className="msg-list">
          <div className="msg-list-head">
            <b>Messages</b>
            <Button size="sm" variant="primary" icon="plus" onClick={() => setNewOpen(true)}>New</Button>
          </div>
          <button type="button" className={`msg-item${openId === BOARD ? " on" : ""}`} onClick={() => open(BOARD)}>
            <span className="row between g-2" style={{ alignItems: "baseline" }}>
              <b>Vendor chat</b>
              {boardUnread ? <span className="msg-unread">{boardUnread}</span> : lastBoard ? <span className="t-xs t-muted">{fmtDateTime(lastBoard.createdAt)}</span> : null}
            </span>
            <span className="t-xs t-muted">Everyone at the market</span>
            <span className="t-sm t-muted truncate">{lastBoard ? `${lastBoard.fromOffice ? "You" : lastBoard.name}: ${lastBoard.body}` : "No messages yet"}</span>
          </button>
          {convs.map((c) => (
            <button key={c.id} type="button" className={`msg-item${c.id === openId ? " on" : ""}`} onClick={() => open(c.id)}>
              <span className="row between g-2" style={{ alignItems: "baseline" }}>
                <b className="truncate">{c.title}</b>
                {c.unread ? <span className="msg-unread">{c.unread}</span> : c.hasMessages ? <span className="t-xs t-muted">{fmtDateTime(c.lastAt)}</span> : null}
              </span>
              <span className="t-xs t-muted">{KIND_LABEL[c.kind]}{c.kind === "VENDOR" || c.kind === "DIRECT" ? "" : ` · ${c.memberCount} vendor${c.memberCount === 1 ? "" : "s"}`}</span>
              <span className="t-sm t-muted truncate">{c.hasMessages ? `${c.lastFromOffice ? "You: " : ""}${c.lastBody}` : "No messages yet"}</span>
            </button>
          ))}
        </aside>

        <section className="msg-thread">
          {!openId ? (
            <div className="msg-empty">
              <Icon name="message" size={36} />
              <b>Pick a conversation</b>
              <span className="t-sm">Or tap New to message everyone, a group, or any vendor.</span>
            </div>
          ) : (
            <>
              <header className="msg-head">
                <button type="button" className="msg-back" onClick={() => open("")} aria-label="Back to messages">
                  <Icon name="arrowLeft" size={18} />
                </button>
                <div className="stack" style={{ minWidth: 0 }}>
                  <b className="truncate">{title}</b>
                  <span className="t-xs t-muted truncate">{sub}</span>
                </div>
              </header>

              <div className="msg-body">
                {openId === BOARD ? (
                  board.length === 0 ? (
                    <div className="msg-empty"><span className="t-sm">No messages yet. Say hello below.</span></div>
                  ) : board.map((m) => (
                    <div key={m.id} className={`msg-row${m.fromOffice ? " mine" : ""}`}>
                      <div className="t-xs t-muted">{m.fromOffice ? "You" : m.name} · {fmtDateTime(m.createdAt)}</div>
                      <div className="msg-bubble">{m.body}</div>
                    </div>
                  ))
                ) : !thread ? (
                  <div className="msg-empty"><span className="t-sm">Loading…</span></div>
                ) : thread.messages.length === 0 ? (
                  <div className="msg-empty"><span className="t-sm">No messages yet. Write the first one below.</span></div>
                ) : (
                  thread.messages.map((m) => {
                    const r = m.fromOffice ? receipts(m) : null;
                    return (
                      <div key={m.id} className={`msg-row${m.fromOffice ? " mine" : ""}`}>
                        <div className="t-xs t-muted">{m.fromOffice ? `You (${m.name})` : m.name} · {fmtDateTime(m.createdAt)}</div>
                        <div className="msg-bubble">{m.body}</div>
                        {r ? (
                          <button type="button" className="msg-receipt" onClick={() => setReceiptsFor(receiptsFor === m.id ? "" : m.id)}>
                            {r.unread.length === 0 ? "Read by everyone" : `Read by ${r.read.length} of ${r.read.length + r.unread.length}`}
                          </button>
                        ) : null}
                        {r && receiptsFor === m.id ? (
                          <div className="msg-receipts">
                            {r.read.length ? <div><b>Read:</b> {r.read.join(", ")}</div> : null}
                            {r.unread.length ? <div><b>Not yet:</b> {r.unread.join(", ")}</div> : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
                <div ref={endRef} />
              </div>

              {readOnly ? (
                <footer className="msg-compose">
                  <span className="t-sm t-muted">A chat between these two vendors. You can read it; only they can write in it.</span>
                </footer>
              ) : (
                <footer className="msg-compose">
                  <div className="msg-compose-row">
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
                  </div>
                  {openId !== BOARD ? (
                    <div className="row wrap g-3" style={{ alignItems: "center" }}>
                      <Checkbox checked={email} onCheckedChange={setEmail} label="Email it too" />
                      {lastText && lastText.phones.length ? (
                        <a className="t-sm" href={smsLink(lastText.phones, lastText.text)}>Text that to {lastText.phones.length} vendor{lastText.phones.length === 1 ? "" : "s"} from this phone</a>
                      ) : null}
                    </div>
                  ) : null}
                </footer>
              )}
            </>
          )}
        </section>
      </div>

      {newOpen ? (
        <NewMessage
          tags={tags}
          vendors={vendors}
          onClose={() => setNewOpen(false)}
          onOpened={(conversationId) => { setNewOpen(false); open(conversationId); void load(); }}
        />
      ) : null}

      {groupsOpen ? (
        <Groups
          tags={tags}
          vendors={vendors}
          onClose={() => setGroupsOpen(false)}
          onChanged={() => void load()}
          confirm={(t) => dialog.confirm({ title: `Delete the ${t} group?`, body: "Its conversation is kept, but you won't be able to message the group in one tap any more.", confirmLabel: "Delete group", tone: "danger" })}
        />
      ) : null}
    </main>
  );
}

/* --------------------------------------------------------- new message -- */

function NewMessage({ tags, vendors, onClose, onOpened }: {
  tags: Tag[];
  vendors: Vendor[];
  onClose: () => void;
  onOpened: (conversationId: string) => void;
}) {
  const toast = useToast();
  const [to, setTo] = useState<"ALL" | "TAG" | "VENDORS">("VENDORS");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const pickedIds = Object.keys(picked).filter((k) => picked[k]);
  const shown = useMemo(
    () => vendors.filter((v) => !q.trim() || v.businessName.toLowerCase().includes(q.trim().toLowerCase()) || v.code.toLowerCase().includes(q.trim().toLowerCase())),
    [vendors, q]
  );

  const go = async (target: object) => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "open", to: target }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.conversationId) { toast.error("Couldn't open that", String(d.error || "")); return; }
      onOpened(d.conversationId);
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title="New message"
      footer={to === "VENDORS" ? (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="message" loading={busy} disabled={busy || pickedIds.length === 0} onClick={() => void go({ kind: "VENDORS", vendorIds: pickedIds })}>
            {pickedIds.length > 1 ? `Message these ${pickedIds.length}` : "Message"}
          </Button>
        </>
      ) : <Button variant="ghost" onClick={onClose}>Cancel</Button>}
    >
      <div className="stack g-4">
        <Segmented<"ALL" | "TAG" | "VENDORS">
          label="Who it goes to"
          value={to}
          onChange={setTo}
          options={[{ value: "VENDORS", label: "Pick vendors" }, { value: "TAG", label: "A group" }, { value: "ALL", label: "Everyone" }]}
        />

        {to === "ALL" ? (
          <Button variant="primary" block icon="message" loading={busy} onClick={() => void go({ kind: "ALL" })}>Message all {vendors.length} vendors</Button>
        ) : null}

        {to === "TAG" ? (
          tags.length === 0 ? (
            <Note tone="info">No groups yet — make one under Groups first.</Note>
          ) : (
            <div className="stack g-1">
              {tags.map((t) => (
                <button key={t.id} type="button" className="msg-item" disabled={busy} onClick={() => void go({ kind: "TAG", tagId: t.id })}>
                  <b>{t.name}</b>
                  <span className="t-xs t-muted">{t.count} vendor{t.count === 1 ? "" : "s"}</span>
                </button>
              ))}
            </div>
          )
        ) : null}

        {to === "VENDORS" ? (
          <div className="stack g-2">
            <SearchInput value={q} onValueChange={setQ} placeholder="Find a vendor" aria-label="Find a vendor" />
            <div className="msg-pick">
              {shown.map((v) => (
                <Checkbox
                  key={v.id}
                  checked={!!picked[v.id]}
                  onCheckedChange={(on) => setPicked((p) => ({ ...p, [v.id]: on }))}
                  label={v.businessName}
                  hint={`${v.code}${v.tagIds.length ? ` · ${v.tagIds.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean).join(", ")}` : ""}`}
                />
              ))}
            </div>
            <span className="t-xs t-muted">One vendor opens your private chat with them. Several make a group chat.</span>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- groups -- */

function Groups({ tags, vendors, onClose, onChanged, confirm }: {
  tags: Tag[];
  vendors: Vendor[];
  onClose: () => void;
  onChanged: () => void;
  confirm: (name: string) => Promise<boolean>;
}) {
  const toast = useToast();
  const [sel, setSel] = useState(tags[0]?.id || "");
  const [newName, setNewName] = useState("");
  const [local, setLocal] = useState<Vendor[]>(vendors);
  useEffect(() => setLocal(vendors), [vendors]);
  useEffect(() => { if (!sel && tags[0]) setSel(tags[0].id); }, [tags, sel]);

  const post = async (payload: object) => {
    const r = await fetch("/api/admin/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error("Couldn't save that", String(d.error || "")); return false; }
    return true;
  };

  const create = async () => {
    if (!newName.trim()) return;
    if (await post({ action: "tag-create", name: newName.trim() })) { setNewName(""); onChanged(); }
  };

  const toggle = async (vendorId: string, on: boolean) => {
    setLocal((l) => l.map((v) => (v.id === vendorId ? { ...v, tagIds: on ? [...v.tagIds, sel] : v.tagIds.filter((t) => t !== sel) } : v)));
    if (!(await post({ action: "tag-toggle", tagId: sel, vendorId, on }))) onChanged();
    else onChanged();
  };

  const remove = async () => {
    const t = tags.find((x) => x.id === sel);
    if (!t || !(await confirm(t.name))) return;
    if (await post({ action: "tag-delete", tagId: sel })) { setSel(""); onChanged(); }
  };

  const tag = tags.find((t) => t.id === sel);

  return (
    <Modal open onClose={onClose} width="lg" title="Groups" description="Put vendors in groups so you can message them all in one tap. A vendor can be in as many groups as fit." footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="stack g-4">
        <div className="row wrap g-2">
          {tags.map((t) => (
            <Button key={t.id} size="sm" variant={t.id === sel ? "primary" : "secondary"} onClick={() => setSel(t.id)}>
              {t.name} ({t.count})
            </Button>
          ))}
        </div>
        <div className="row g-2">
          <Input className="grow" value={newName} maxLength={30} placeholder="New group, e.g. Food trucks" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
          <Button variant="secondary" icon="plus" disabled={!newName.trim()} onClick={() => void create()}>Add group</Button>
        </div>
        {tag ? (
          <div className="stack g-2">
            <div className="row between g-2" style={{ alignItems: "center" }}>
              <b>Who&rsquo;s in {tag.name}</b>
              <Button size="sm" variant="dangerSoft" icon="trash" onClick={() => void remove()}>Delete group</Button>
            </div>
            <div className="msg-pick">
              {local.map((v) => (
                <Checkbox key={v.id} checked={v.tagIds.includes(sel)} onCheckedChange={(on) => void toggle(v.id, on)} label={v.businessName} hint={v.code} />
              ))}
            </div>
          </div>
        ) : (
          <Note tone="info">Make a group above, then tick who belongs in it.</Note>
        )}
      </div>
    </Modal>
  );
}

const CSS = `
.msg-shell { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 12px; height: calc(100dvh - 140px); min-height: 480px; }
.msg-list { min-height: 0; overflow-y: auto; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
.msg-list-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--surface); border-bottom: 1px solid var(--border-subtle); }
.msg-item { width: 100%; display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; text-align: left; border: 0; border-bottom: 1px solid var(--border-subtle); background: transparent; color: var(--text); cursor: pointer; }
.msg-item:hover { background: var(--surface-hover); }
.msg-item.on { background: var(--accent-soft); }
.msg-unread { min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.msg-thread { min-width: 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); overflow: hidden; }
.msg-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border-subtle); }
.msg-back { display: none; border: 0; background: none; color: var(--text); padding: 4px; }
.msg-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; background: var(--bg-sunken); display: flex; flex-direction: column; gap: 12px; }
.msg-row { max-width: 80%; display: flex; flex-direction: column; gap: 3px; align-self: flex-start; }
.msg-row.mine { align-self: flex-end; align-items: flex-end; }
.msg-bubble { padding: 9px 12px; border-radius: 14px; border: 1px solid var(--border); background: var(--surface); white-space: pre-wrap; word-break: break-word; font-size: var(--fs-md); }
.msg-row.mine .msg-bubble { background: var(--accent); border-color: var(--accent); color: #fff; }
.msg-receipt { border: 0; background: none; padding: 0; font-size: var(--fs-xs); color: var(--text-secondary); text-decoration: underline; cursor: pointer; }
.msg-receipts { font-size: var(--fs-xs); color: var(--text-secondary); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; max-width: 100%; }
.msg-compose { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.msg-compose-row { display: flex; gap: 8px; align-items: flex-end; }
.msg-compose textarea { flex: 1 1 auto; min-height: 44px; max-height: 140px; resize: vertical; }
.msg-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); padding: 24px; text-align: center; }
.msg-pick { max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
@media (max-width: 820px) {
  .msg-shell { grid-template-columns: 1fr; height: calc(100dvh - 120px); }
  .msg-shell.has-open .msg-list { display: none; }
  .msg-shell:not(.has-open) .msg-thread { display: none; }
  .msg-back { display: inline-flex; }
}
`;

"use client";

/**
 * The office's messages to vendors, laid out like a texting app.
 *
 * Left: every conversation — Everyone, each group (tag), hand-picked groups
 * and one-to-one chats — with unread counts for vendor replies. Right: the open
 * conversation, read receipts on every office message, and the reply box.
 *
 * Only the office's messages notify vendors (app notification, email, and a
 * Home banner they can dismiss). Group texts go from the owner's own phone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button, LinkButton, Input, Textarea, Checkbox, Note, Badge, Modal, Segmented,
  SearchInput, EmptyState, Icon, useToast, useDialog,
} from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { usePulse } from "@/lib/usePulse";

type Conv = {
  id: string; kind: "ALL" | "TAG" | "DIRECT" | "CUSTOM"; title: string; tagId: string; lastAt: string;
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

const KIND_LABEL: Record<string, string> = { ALL: "Everyone", TAG: "Group", DIRECT: "Private", CUSTOM: "Picked vendors" };

/* The vendors' own chat board, shown as a pinned item at the top of the list.
   The office can read it and post in it; posts there never notify anyone. */
const BOARD = "__board__";
type BoardMsg = { id: string; fromOffice: boolean; name: string; body: string; createdAt: string };

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
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState<string>("");
  const [thread, setThread] = useState<Thread | null>(null);
  const [receiptsFor, setReceiptsFor] = useState<string>("");
  const [board, setBoard] = useState<BoardMsg[] | null>(null);

  /* Composer for the open conversation. */
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [push, setPush] = useState(true);
  const [email, setEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastText, setLastText] = useState<{ phones: string[]; text: string } | null>(null);

  /* New message / groups dialogs. */
  const [newOpen, setNewOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/messages");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(String(d.error || "Couldn't load messages.")); return; }
    setErr("");
    setConvs(d.conversations || []);
    setTags(d.tags || []);
    setVendors(d.vendors || []);
  }, []);

  const loadThread = useCallback(async (id: string) => {
    if (!id) { setThread(null); return; }
    if (id === BOARD) {
      const r = await fetch("/api/admin/messages?board=1");
      const d = await r.json().catch(() => ({}));
      if (r.ok) setBoard(d.messages || []);
      return;
    }
    const r = await fetch(`/api/admin/messages?id=${encodeURIComponent(id)}`);
    const d = await r.json().catch(() => ({}));
    if (r.ok) setThread(d as Thread);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadThread(openId); }, [openId, loadThread]);
  /* Replies land without a refresh. */
  usePulse(() => { void load(); if (openId) void loadThread(openId); });

  /* Keep the thread scrolled to the newest message. */
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [thread?.messages.length, board?.length, openId]);

  const open = (id: string) => {
    if (id !== BOARD) setBoard(null);
    setOpenId(id);
    setSubject(""); setBody(""); setLastText(null); setReceiptsFor("");
  };

  const sendHere = async () => {
    if (!body.trim() || !openId) return;
    setBusy(true);
    if (openId === BOARD) {
      try {
        const r = await fetch("/api/admin/messages", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "board-post", body: body.trim() }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast.error("Didn't post", String(d.error || "")); return; }
        setBody("");
        void loadThread(BOARD);
      } finally { setBusy(false); }
      return;
    }
    try {
      const r = await fetch("/api/admin/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", conversationId: openId, subject: subject.trim(), body: body.trim(), push, email }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Didn't send", String(d.error || "")); return; }
      toast.success("Sent", `${d.pushed} notification${d.pushed === 1 ? "" : "s"}, ${d.emailed} email${d.emailed === 1 ? "" : "s"}${d.emailFailed?.length ? ` — email failed for ${d.emailFailed.join(", ")}` : ""}.`);
      setLastText({ phones: d.phones || [], text: `Community Harvest: ${subject.trim() ? `${subject.trim()} — ` : ""}${body.trim()}` });
      setSubject(""); setBody("");
      void loadThread(openId); void load();
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

  const current = convs.find((c) => c.id === openId);

  return (
    <main className="content" style={{ maxWidth: 1180 }}>
      <style>{CSS}</style>
      <div className="row between wrap g-2 mb-3" style={{ alignItems: "center" }}>
        <LinkButton href="/admin" variant="ghost" size="sm" icon="arrowLeft">Admin</LinkButton>
        <div className="row g-2">
          <Button variant="secondary" icon="users" onClick={() => setGroupsOpen(true)}>Groups</Button>
          <Button variant="primary" icon="plus" onClick={() => setNewOpen(true)}>New message</Button>
        </div>
      </div>
      {err ? <Note tone="error">{err}</Note> : null}

      <div className={`msg-shell${openId ? " has-open" : ""}`}>
        {/* ------------------------------------------------ conversation list */}
        <aside className="msg-list">
          <button type="button" className={`msg-item msg-board${openId === BOARD ? " on" : ""}`} onClick={() => open(BOARD)}>
            <b>Vendor chat</b>
            <span className="t-xs t-muted">The vendors&rsquo; own board · no notifications</span>
          </button>
          {convs.length === 0 ? (
            <EmptyState icon="message" title="No conversations yet" body="Tap New message to write to everyone, a group, or one vendor." />
          ) : (
            convs.map((c) => (
              <button key={c.id} type="button" className={`msg-item${c.id === openId ? " on" : ""}`} onClick={() => open(c.id)}>
                <span className="row between g-2" style={{ alignItems: "baseline" }}>
                  <b className="truncate">{c.title}</b>
                  {c.unread ? <span className="msg-unread">{c.unread}</span> : null}
                </span>
                <span className="t-xs t-muted">{KIND_LABEL[c.kind]} · {c.memberCount} vendor{c.memberCount === 1 ? "" : "s"}{c.hasMessages ? ` · ${fmtDateTime(c.lastAt)}` : ""}</span>
                <span className="t-sm t-muted truncate">{c.hasMessages ? `${c.lastFromOffice ? "You: " : ""}${c.lastBody}` : "No messages yet"}</span>
              </button>
            ))
          )}
        </aside>

        {/* ------------------------------------------------ open conversation */}
        <section className="msg-thread">
          {openId === BOARD ? (
            <>
              <header className="msg-head">
                <button type="button" className="msg-back" onClick={() => setOpenId("")} aria-label="Back to conversations">
                  <Icon name="arrowLeft" size={18} />
                </button>
                <div className="stack" style={{ minWidth: 0 }}>
                  <b>Vendor chat</b>
                  <span className="t-xs t-muted">Every vendor reads this. You post as Community Harvest. Nobody gets notified.</span>
                </div>
              </header>
              <div className="msg-body">
                {!board ? (
                  <div className="msg-empty"><span className="t-sm">Loading…</span></div>
                ) : board.length === 0 ? (
                  <div className="msg-empty"><span className="t-sm">Nobody has posted yet.</span></div>
                ) : (
                  board.map((m) => (
                    <div key={m.id} className={`msg-row${m.fromOffice ? " mine" : ""}`}>
                      <div className="t-xs t-muted">{m.fromOffice ? "You (Community Harvest)" : m.name} · {fmtDateTime(m.createdAt)}</div>
                      <div className="msg-bubble">{m.body}</div>
                    </div>
                  ))
                )}
                <div ref={endRef} />
              </div>
              <footer className="msg-compose">
                <div className="row g-2" style={{ alignItems: "flex-end" }}>
                  <Textarea className="grow" rows={2} maxLength={1000} value={body} placeholder="Post in vendor chat…" onChange={(e) => setBody(e.target.value)} />
                  <Button variant="primary" icon="message" loading={busy} disabled={busy || !body.trim()} onClick={() => void sendHere()}>Post</Button>
                </div>
              </footer>
            </>
          ) : !openId || !thread ? (
            <div className="msg-empty">
              <Icon name="message" size={36} />
              <b>Pick a conversation, or start a new one.</b>
            </div>
          ) : (
            <>
              <header className="msg-head">
                <button type="button" className="msg-back" onClick={() => setOpenId("")} aria-label="Back to conversations">
                  <Icon name="arrowLeft" size={18} />
                </button>
                <div className="stack" style={{ minWidth: 0 }}>
                  <b className="truncate">{thread.conversation.title}</b>
                  <span className="t-xs t-muted truncate">
                    {KIND_LABEL[thread.conversation.kind]} · {thread.members.map((m) => m.name).join(", ") || "Nobody yet"}
                  </span>
                </div>
              </header>

              <div className="msg-body">
                {thread.messages.length === 0 ? (
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

              <footer className="msg-compose">
                <Input value={subject} maxLength={120} placeholder="Subject (optional — email subject and notification title)" onChange={(e) => setSubject(e.target.value)} />
                <Textarea rows={3} maxLength={2000} value={body} placeholder={`Message ${thread.conversation.title}…`} onChange={(e) => setBody(e.target.value)} />
                <div className="row wrap g-3" style={{ alignItems: "center" }}>
                  <Checkbox checked={push} onCheckedChange={setPush} label="App notification" />
                  <Checkbox checked={email} onCheckedChange={setEmail} label="Email" />
                  <span className="grow" />
                  <Button variant="primary" icon="message" loading={busy} disabled={busy || !body.trim()} onClick={() => void sendHere()}>
                    Send{current ? ` to ${current.memberCount}` : ""}
                  </Button>
                </div>
                {lastText && lastText.phones.length ? (
                  <Note tone="info" title="Also send it as a text?">
                    <span className="row wrap g-2" style={{ alignItems: "center" }}>
                      <a className="btn btn-secondary btn-sm" href={smsLink(lastText.phones, lastText.text)}>Text {lastText.phones.length} vendor{lastText.phones.length === 1 ? "" : "s"} from this phone</a>
                      <span className="t-xs t-muted">Opens Messages with the numbers and text filled in. Works from your phone, not the PC.</span>
                    </span>
                  </Note>
                ) : null}
              </footer>
            </>
          )}
        </section>
      </div>

      {newOpen ? (
        <NewMessage
          tags={tags}
          vendors={vendors}
          onClose={() => setNewOpen(false)}
          onSent={(conversationId, phones, text) => {
            setNewOpen(false);
            void load().then(() => { open(conversationId); setLastText({ phones, text }); });
          }}
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

function NewMessage({ tags, vendors, onClose, onSent }: {
  tags: Tag[];
  vendors: Vendor[];
  onClose: () => void;
  onSent: (conversationId: string, phones: string[], text: string) => void;
}) {
  const toast = useToast();
  const [to, setTo] = useState<"ALL" | "TAG" | "VENDORS">("ALL");
  const [tagId, setTagId] = useState(tags[0]?.id || "");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [push, setPush] = useState(true);
  const [email, setEmail] = useState(true);
  const [busy, setBusy] = useState(false);

  const pickedIds = Object.keys(picked).filter((k) => picked[k]);
  const shown = useMemo(
    () => vendors.filter((v) => !q.trim() || v.businessName.toLowerCase().includes(q.trim().toLowerCase()) || v.code.toLowerCase().includes(q.trim().toLowerCase())),
    [vendors, q]
  );
  const count = to === "ALL" ? vendors.length : to === "TAG" ? tags.find((t) => t.id === tagId)?.count || 0 : pickedIds.length;

  const send = async () => {
    if (!body.trim() || count === 0) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send",
          to: to === "ALL" ? { kind: "ALL" } : to === "TAG" ? { kind: "TAG", tagId } : { kind: "VENDORS", vendorIds: pickedIds },
          subject: subject.trim(), body: body.trim(), push, email,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Didn't send", String(d.error || "")); return; }
      toast.success("Sent", `${d.pushed} notification${d.pushed === 1 ? "" : "s"}, ${d.emailed} email${d.emailed === 1 ? "" : "s"}${d.emailFailed?.length ? ` — email failed for ${d.emailFailed.join(", ")}` : ""}.`);
      onSent(d.conversationId, d.phones || [], `Community Harvest: ${subject.trim() ? `${subject.trim()} — ` : ""}${body.trim()}`);
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title="New message"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="message" loading={busy} disabled={busy || !body.trim() || count === 0} onClick={() => void send()}>
            Send to {count} vendor{count === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="stack g-4">
        <Segmented<"ALL" | "TAG" | "VENDORS">
          label="Who it goes to"
          value={to}
          onChange={setTo}
          options={[{ value: "ALL", label: "Everyone" }, { value: "TAG", label: "A group" }, { value: "VENDORS", label: "Pick vendors" }]}
        />

        {to === "TAG" ? (
          tags.length === 0 ? (
            <Note tone="info">No groups yet — make one under Groups first.</Note>
          ) : (
            <div className="row wrap g-2">
              {tags.map((t) => (
                <Button key={t.id} size="sm" variant={t.id === tagId ? "primary" : "secondary"} onClick={() => setTagId(t.id)}>
                  {t.name} ({t.count})
                </Button>
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
            <span className="t-xs t-muted">One vendor opens your private conversation with them. Several start a new group conversation.</span>
          </div>
        ) : null}

        <Input value={subject} maxLength={120} placeholder="Subject (optional)" onChange={(e) => setSubject(e.target.value)} />
        <Textarea rows={5} maxLength={2000} value={body} placeholder="Write it the way you'd say it at the counter." onChange={(e) => setBody(e.target.value)} />
        <div className="row wrap g-3">
          <Checkbox checked={push} onCheckedChange={setPush} label="App notification" />
          <Checkbox checked={email} onCheckedChange={setEmail} label="Email" />
        </div>
        <span className="t-xs t-muted">After it sends you can also text it from your phone. Vendors see it in Messages and as a banner on Home until they tap Got it.</span>
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
.msg-item { width: 100%; display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; text-align: left; border: 0; border-bottom: 1px solid var(--border-subtle); background: transparent; color: var(--text); cursor: pointer; }
.msg-item:hover { background: var(--surface-hover); }
.msg-item.on { background: var(--accent-soft); }
.msg-unread { min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.msg-thread { min-width: 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); overflow: hidden; }
.msg-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border-subtle); }
.msg-back { display: none; border: 0; background: none; color: var(--text); padding: 4px; }
.msg-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; background: var(--bg-sunken); display: flex; flex-direction: column; gap: 12px; }
.msg-row { max-width: 78%; display: flex; flex-direction: column; gap: 3px; align-self: flex-start; }
.msg-row.mine { align-self: flex-end; align-items: flex-end; }
.msg-bubble { padding: 9px 12px; border-radius: 14px; border: 1px solid var(--border); background: var(--surface); white-space: pre-wrap; word-break: break-word; font-size: var(--fs-md); }
.msg-row.mine .msg-bubble { background: var(--accent); border-color: var(--accent); color: #fff; }
.msg-receipt { border: 0; background: none; padding: 0; font-size: var(--fs-xs); color: var(--text-secondary); text-decoration: underline; cursor: pointer; }
.msg-receipts { font-size: var(--fs-xs); color: var(--text-secondary); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; max-width: 100%; }
.msg-compose { flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--border); background: var(--surface); }
.msg-board { background: var(--bg-sunken); }
.msg-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); padding: 24px; text-align: center; }
.msg-pick { max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
@media (max-width: 820px) {
  .msg-shell { grid-template-columns: 1fr; height: auto; }
  .msg-shell.has-open .msg-list { display: none; }
  .msg-shell:not(.has-open) .msg-thread { display: none; }
  .msg-thread { height: calc(100dvh - 120px); }
  .msg-back { display: inline-flex; }
}
`;

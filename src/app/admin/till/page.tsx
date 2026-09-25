"use client";

// The till's hardware, in one place: the card reader, the receipt printer and
// the drawer that hangs off it. Setup lives here rather than in the general
// settings page because it is a job you do once, standing at the counter with
// the machines in front of you, and it wants room to explain itself.
import { useCallback, useEffect, useState } from "react";
import {
  Icon, Button, LinkButton, Field, Input, Textarea, Badge, Card, Note,
  PageHeader, useDialog, useToast, type BadgeTone,
} from "@/components/ui";
import { relTime } from "@/lib/format";
import { PrintAgent } from "@/components/PrintAgent";

type Reader = {
  id: string; label: string; status: string; deviceType: string;
  serial: string; lastSeen: string | null; action: string; actionStatus: string;
};

type PrintState = {
  online: boolean;
  lastSeen: string | null;
  queued: number;
  failed: number;
  configured: boolean;
  autoPrint: boolean;
  sdpVersion: "1.00" | "2.00";
  sdpStyle: "pretty" | "compact" | "bare";
  lastEvent: { at: string; what: string } | null;
  lastResponse: string;
  deviceId: string;
  printerHost: string;
  printMode: "direct" | "collect";
  receiptColumns: number;
  receiptLogo: boolean;
  logoSize: number;
  log: { at: string; what: string }[];
  recent: { id: string; kind: string; label: string; status: string; error: string; createdAt: string; attempts: number }[];
};

const STATUS_TONE: Record<string, BadgeTone> = {
  DONE: "success", QUEUED: "warn", SENT: "warn", FAILED: "danger",
};

export default function TillHardware() {
  const toast = useToast();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);

  const [readers, setReaders] = useState<Reader[]>([]);
  const [selected, setSelected] = useState("");
  const [readerErr, setReaderErr] = useState("");

  const [print, setPrint] = useState<PrintState | null>(null);
  const [printerKey, setPrinterKey] = useState("");
  const [header, setHeader] = useState("");
  const [deviceId, setDeviceId] = useState("local_printer");
  const [host, setHost] = useState("");
  const [cols, setCols] = useState("42");
  const [footer, setFooter] = useState("");

  const loadReaders = useCallback(async () => {
    const r = await fetch("/api/admin/terminal/readers");
    const d = await r.json().catch(() => ({}));
    if (d.error) setReaderErr(String(d.error));
    else setReaderErr("");
    setReaders(d.readers || []);
    setSelected(String(d.selected || ""));
  }, []);

  const loadPrint = useCallback(async () => {
    const r = await fetch("/api/admin/print");
    if (!r.ok) return;
    setPrint(await r.json());
  }, []);

  const loadSetup = useCallback(async () => {
    /* PATCH with nothing to change is how the page reads the current values:
       the address, the header and the footer all live behind the same owner
       check, and one round trip beats three endpoints. */
    const r = await fetch("/api/admin/print", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!r.ok) return;
    const d = await r.json();
    setPrinterKey(String(d.key || ""));
    setDeviceId(String(d.deviceId || "local_printer"));
    setHost(String(d.printerHost || ""));
    setCols(String(d.receiptColumns || 42));
    setHeader(String(d.header || ""));
    setFooter(String(d.footer || ""));
  }, []);

  useEffect(() => { void loadReaders(); void loadPrint(); void loadSetup(); }, [loadReaders, loadPrint, loadSetup]);

  /* The printer's own status is the only thing on this page that changes by
     itself, and it is exactly what somebody plugging one in is staring at. */
  useEffect(() => {
    const t = setInterval(() => { void loadPrint(); }, 6000);
    return () => clearInterval(t);
  }, [loadPrint]);

  /* ------------------------------------------------------------- reader -- */

  const pairReader = async () => {
    const code = await dialog.prompt({
      title: "Pair the card reader",
      body: (
        <p>
          On the reader: swipe in from the left edge of its screen, tap <b>Settings</b>, and read off the
          three-word pairing code. It expires after a few minutes, so type it now.
        </p>
      ),
      label: "Pairing code",
      placeholder: "violet-pine-ladder",
      confirmLabel: "Pair it",
    });
    if (code === null || !code.trim()) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/terminal/readers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationCode: code.trim(), label: "Front till" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't pair that", String(d.error || "")); return; }
      toast.success("Reader paired", "The till will send card payments to it.");
      await loadReaders();
    } finally { setBusy(false); }
  };

  const useReader = async (id: string) => {
    setBusy(true);
    try {
      await fetch("/api/admin/terminal/readers", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readerId: id }),
      });
      toast.success("The till will use that reader");
      await loadReaders();
    } finally { setBusy(false); }
  };

  const dropReader = async (r: Reader) => {
    const yes = await dialog.confirm({
      title: `Unpair ${r.label || "this reader"}?`,
      body: <p>It stops taking payments for the market straight away. Pairing it again needs a new code off its screen.</p>,
      confirmLabel: "Unpair it",
      tone: "danger",
    });
    if (!yes) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/terminal/readers?id=${encodeURIComponent(r.id)}`, { method: "DELETE" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error("Couldn't unpair it", String(d.error || "")); return; }
      toast.success("Unpaired");
      await loadReaders();
    } finally { setBusy(false); }
  };

  /* ------------------------------------------------------------ printer -- */

  const newKey = async () => {
    const yes = await dialog.confirm({
      title: printerKey ? "Make a new printer address?" : "Set the printer up",
      body: printerKey
        ? <p>The old address stops working the moment you do this, and the printer won&rsquo;t print again until you type the new one into it.</p>
        : <p>This makes the address you&rsquo;ll type into the printer&rsquo;s own settings page.</p>,
      confirmLabel: printerKey ? "Make a new one" : "Set it up",
      tone: printerKey ? "danger" : "default",
    });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/print", { method: "PUT" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't do that", String(d.error || "")); return; }
      setPrinterKey(String(d.key || ""));
      toast.success("Address made", "Type it into the printer next.");
      await loadPrint();
    } finally { setBusy(false); }
  };

  const setLogo = async (logoSize: number) => {
    setBusy(true);
    try {
      await fetch("/api/admin/print", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logoSize, receiptLogo: true }),
      });
      await loadPrint();
      toast.success(`Logo set to ${logoSize} dots`, "Send a test print to see if it takes.");
    } finally { setBusy(false); }
  };

  const toggleLogo = async () => {
    setBusy(true);
    try {
      await fetch("/api/admin/print", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptLogo: !print?.receiptLogo }),
      });
      await loadPrint();
    } finally { setBusy(false); }
  };

  const saveReceipt = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/print", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ header, footer, receiptColumns: Number(cols) }),
      });
      if (!r.ok) { toast.error("Couldn't save that"); return; }
      toast.success("Receipt wording saved");
    } finally { setBusy(false); }
  };

  const saveHost = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/print", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printerHost: host, printMode: "direct" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't save that", String(d.error || "")); return; }
      setHost(String(d.printerHost || ""));
      await loadPrint();
      toast.success("Saved", "Now open the printer once to trust it, then print a test.");
    } finally { setBusy(false); }
  };

  const saveDeviceId = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/print", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't save that", String(d.error || "")); return; }
      setDeviceId(String(d.deviceId || "local_printer"));
      await loadPrint();
      toast.success("Saved", "Send a plain test.");
    } finally { setBusy(false); }
  };

  const STYLE_LABEL: Record<string, string> = {
    pretty: "Across lines",
    compact: "One line",
    bare: "No XML header",
  };

  const nextStyle = async () => {
    const order = ["pretty", "compact", "bare"] as const;
    const at = order.indexOf((print?.sdpStyle || "pretty") as typeof order[number]);
    const sdpStyle = order[(at + 1) % order.length];
    setBusy(true);
    try {
      await fetch("/api/admin/print", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdpStyle }),
      });
      await loadPrint();
      toast.success(`Layout: ${STYLE_LABEL[sdpStyle]}`, "Clear, then send another test.");
    } finally { setBusy(false); }
  };

  const setVersion = async (sdpVersion: "1.00" | "2.00") => {
    setBusy(true);
    try {
      await fetch("/api/admin/print", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdpVersion }),
      });
      await loadPrint();
      toast.success(`Talking to the printer in ${sdpVersion}`, "Send another test print.");
    } finally { setBusy(false); }
  };

  const toggleAuto = async () => {
    setBusy(true);
    try {
      await fetch("/api/admin/print", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoPrint: !print?.autoPrint }),
      });
      await loadPrint();
    } finally { setBusy(false); }
  };

  const send = async (action: "test" | "drawer" | "plain") => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/print", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't send that", String(d.error || "")); return; }
      toast.success(
        action === "test" ? "Test sent" : action === "plain" ? "Plain test sent" : "Drawer sent",
        "It goes out next time the printer checks in — a few seconds."
      );
      await loadPrint();
    } finally { setBusy(false); }
  };

  const clearJobs = async (which: "failed" | "waiting") => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/print?id=${which}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      await loadPrint();
      toast.success(d.cleared ? `Cleared ${d.cleared}` : "Nothing to clear");
    } finally { setBusy(false); }
  };

  const clearOne = async (id: string) => {
    setBusy(true);
    try {
      await fetch(`/api/admin/print?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadPrint();
    } finally { setBusy(false); }
  };

  const pollUrl = printerKey
    ? `${typeof window === "undefined" ? "" : window.location.origin}/api/print/${printerKey}`
    : "";

  const copyUrl = async () => {
    if (!pollUrl) return;
    try {
      await navigator.clipboard.writeText(pollUrl);
      toast.success("Copied");
    } catch {
      /* Clipboard access is blocked in plenty of places. The address is on the
         screen anyway, so say so rather than failing silently. */
      toast.error("Couldn't copy it", "Select the address and copy it by hand.");
    }
  };

  return (
    <main className="content content-narrow">
      {/* So the test buttons on this page actually print when this device is
          the one on the market wifi. */}
      <PrintAgent active={print?.printMode === "direct" && !!print?.printerHost} />
      <div className="mb-3">
        <LinkButton href="/admin" variant="ghost" size="sm" icon="arrowLeft">Admin</LinkButton>
      </div>

      <PageHeader
        title="Till hardware"
        subtitle="The card reader, the receipt printer and the cash drawer. Set each one up once; the register uses them by itself after that."
      />

      {/* ------------------------------------------------------- reader -- */}
      <div className="mb-4">
        <Card
          title="Card reader"
          subtitle="Card payments go from the register to the reader through Stripe. No card details ever touch this app or the tablet."
          actions={
            <Button size="sm" variant="primary" icon="card" disabled={busy} onClick={() => void pairReader()}>
              Pair a reader
            </Button>
          }
        >
          {readerErr ? (
            <Note tone="error" title="Stripe isn't answering">{readerErr}</Note>
          ) : readers.length === 0 ? (
            <Note tone="info" title="No reader paired yet">
              Until one is, the register keeps asking for an approval code typed by hand, which still works —
              it just means running the card somewhere else first.
            </Note>
          ) : (
            <div className="stack g-3">
              {readers.map((r) => (
                <div key={r.id} className="row between wrap g-2" style={{ alignItems: "center" }}>
                  <span className="stack g-1" style={{ minWidth: 0 }}>
                    <span className="row g-2 wrap" style={{ alignItems: "center" }}>
                      <b>{r.label || "Reader"}</b>
                      <Badge tone={r.status === "online" ? "success" : "neutral"} dot>
                        {r.status === "online" ? "Online" : "Offline"}
                      </Badge>
                      {selected === r.id ? <Badge tone="info">The till uses this one</Badge> : null}
                      {r.actionStatus === "in_progress" ? <Badge tone="warn">Taking a payment</Badge> : null}
                    </span>
                    <span className="t-xs t-muted">
                      {r.deviceType || "reader"}
                      {r.serial ? ` · ${r.serial}` : ""}
                      {r.lastSeen ? ` · last seen ${relTime(r.lastSeen)}` : ""}
                    </span>
                  </span>
                  <span className="row wrap g-2">
                    {selected === r.id ? null : (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void useReader(r.id)}>
                        Use this one
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" icon="trash" disabled={busy} onClick={() => void dropReader(r)}>
                      Unpair
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ------------------------------------------------------ printer -- */}
      <div className="mb-4">
        <Card
          title="Receipt printer and cash drawer"
          subtitle="The drawer opens through the printer, so both of these are really one machine."
          actions={
            print ? (
              <Badge tone={print.online ? "success" : print.configured ? "warn" : "neutral"} dot>
                {print.online ? "Printer online" : print.configured ? "Not checking in" : "Not set up"}
              </Badge>
            ) : null
          }
        >
          <div className="stack g-4">
            {/* Direct is the way this printer actually works. Its own Server
                Direct Print takes a job and never hands it to its print
                engine, so the till carries receipts itself. */}
            <Field
              label="Printer address on the market wifi"
              hint="The same address you type into a browser to reach the printer's settings."
            >
              {(p) => (
                <div className="row g-2 wrap" style={{ alignItems: "center" }}>
                  <Input {...p} className="mono" value={host} placeholder="192.168.1.9"
                    style={{ maxWidth: 220 }} onChange={(e) => setHost(e.target.value)} />
                  <Button size="sm" variant="primary" icon="check" disabled={busy || !host.trim()} onClick={() => void saveHost()}>
                    Save
                  </Button>
                  {host.trim() ? (
                    <a className="btn btn-secondary btn-sm" href={`https://${host.trim()}/`} target="_blank" rel="noopener">
                      <Icon name="external" size={14} /> Trust the printer
                    </a>
                  ) : null}
                </div>
              )}
            </Field>

            {print?.printMode === "direct" && print?.printerHost ? (
              <Note tone="info" title="One thing on each device that runs the till">
                Tap <b>Trust the printer</b> above, once, on that device. It opens the printer&rsquo;s own
                page and warns you the connection isn&rsquo;t private — that&rsquo;s its own certificate, which is
                expected. Choose <b>Advanced</b>, then <b>Proceed</b>. After that the till can send it
                receipts. If printing stops later with a &ldquo;can&rsquo;t reach the printer&rdquo; warning, do it again.
              </Note>
            ) : null}

            {!printerKey ? (
              <div className="stack g-2">
                <Note tone="info" title="The other way — only if direct printing can't be used">
                  The printer sits on the market&rsquo;s wifi where nothing on the internet can reach it, so it
                  fetches its own work instead. Make the address here, type it into the printer once, and it
                  prints from anywhere you ring a sale.
                </Note>
                <div>
                  <Button variant="primary" icon="print" disabled={busy} onClick={() => void newKey()}>
                    Set the printer up
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Field label="Type this into the printer" hint="Its own settings page — Server Direct Print, under Web Service Settings.">
                  {(p) => (
                    <div className="row g-2" style={{ alignItems: "center" }}>
                      <Input {...p} className="mono" readOnly value={pollUrl} onFocus={(e) => e.currentTarget.select()} />
                      <Button size="sm" variant="secondary" icon="copy" onClick={() => void copyUrl()}>Copy</Button>
                    </div>
                  )}
                </Field>

                <Note tone="neutral" title="How to get there on the printer">
                  Print the printer&rsquo;s status sheet to find its IP address — hold the Feed button as you
                  switch it on. Type that address into a browser on the same wifi, sign in, then:
                  <b> Web Service Settings → Server Direct Print</b>. Switch it on, paste the address above
                  into the URL box, and set the interval to the smallest number it will take. Save and reboot it.
                </Note>

                <div className="row wrap g-2">
                  <Button variant="secondary" icon="print" disabled={busy} onClick={() => void send("test")}>
                    Print a test
                  </Button>
                  <Button variant="secondary" icon="cash" disabled={busy} onClick={() => void send("drawer")}>
                    Open the drawer
                  </Button>
                  {/* Text and a cut, nothing else. Whether this prints when a
                      receipt won't is the fastest way to tell a broken link
                      from a receipt the printer doesn't like. */}
                  <Button variant="ghost" icon="print" disabled={busy} onClick={() => void send("plain")}>
                    Plain test
                  </Button>
                  <Button variant="ghost" icon="refresh" disabled={busy} onClick={() => void newKey()}>
                    New address
                  </Button>
                </div>

                {print ? (
                  <div className="stack g-2">
                    <div className="row wrap g-3" style={{ alignItems: "center" }}>
                      <span className="t-xs t-muted">
                        {print.lastSeen ? `Last checked in ${relTime(print.lastSeen)}` : "Never checked in"}
                        {print.queued ? ` · ${print.queued} waiting` : ""}
                      </span>
                      <Button size="sm" variant={print.autoPrint ? "primary" : "secondary"} disabled={busy} onClick={() => void toggleAuto()}>
                        {print.autoPrint ? "Printing every sale" : "Only when asked"}
                      </Button>
                    </div>
                    {/* The last thing the printer actually did. When paper
                        isn't coming out, this one line is the difference
                        between a printer that isn't listening and one that is
                        listening and refusing. */}
                    {print.lastEvent ? (
                      <span className="t-xs t-muted">
                        It last {print.lastEvent.what} · {relTime(print.lastEvent.at)}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {/* Which station on the printer the paper comes out of. It
                    is a setting on the printer, not a constant, and a name it
                    doesn't have makes it run nothing and say nothing. */}
                <Field
                  label="Device ID"
                  hint="On the printer: Device Admin \u2192 Printer. Almost always local_printer."
                >
                  {(p) => (
                    <div className="row g-2" style={{ alignItems: "center" }}>
                      <Input
                        {...p}
                        className="mono"
                        value={deviceId}
                        style={{ maxWidth: 260 }}
                        onChange={(e) => setDeviceId(e.target.value)}
                      />
                      <Button size="sm" variant="secondary" icon="check" disabled={busy} onClick={() => void saveDeviceId()}>
                        Save
                      </Button>
                    </div>
                  )}
                </Field>

                {/* Two dialects of the same protocol, and which one a printer
                    understands is down to its firmware. Firmware that doesn't
                    know the newer one ignores the job in silence rather than
                    complaining, so when the printer is plainly online and the
                    paper still isn't moving, this is the switch to try. */}
                {print ? (
                  <div className="row wrap g-2" style={{ alignItems: "center" }}>
                    <span className="t-xs t-muted">Printer language</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void setVersion(print.sdpVersion === "2.00" ? "1.00" : "2.00")}
                    >
                      {print.sdpVersion === "2.00" ? "Newer (2.00)" : "Older (1.00)"} — switch
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void nextStyle()}>
                      Layout: {STYLE_LABEL[print.sdpStyle] || print.sdpStyle} — change
                    </Button>
                    <span className="t-xs t-muted">
                      Only worth touching if it&rsquo;s online and nothing prints.
                    </span>
                  </div>
                ) : null}

                {print && !print.online && print.configured ? (
                  <Note tone="warn" title="The printer hasn't checked in">
                    It&rsquo;s either switched off, off the wifi, or Server Direct Print isn&rsquo;t on yet.
                    Anything rung meanwhile is kept and prints the moment it comes back.
                  </Note>
                ) : null}
              </>
            )}
          </div>
        </Card>
      </div>

      {/* ------------------------------------------------------ wording -- */}
      {/* Shown whenever the printer is set up EITHER way. This used to hang off
          the Server Direct Print address alone, which hid the receipt wording —
          and the logo switch with it — from anyone using direct printing, which
          is everyone. */}
      {printerKey || print?.printerHost ? (
        <div className="mb-4">
          <Card title="What the receipt says" subtitle="One line each. Leave them empty for the market's usual wording.">
            <div className="stack g-3">
              <div className="row wrap g-3" style={{ alignItems: "flex-end" }}>
                <Field label="Characters across" hint="42 on this printer. Wrong and every total wraps.">
                  {(p) => (
                    <Input {...p} type="number" min="24" max="96" step="1" className="mono"
                      value={cols} style={{ width: 110 }} onChange={(e) => setCols(e.target.value)} />
                  )}
                </Field>
                <Button size="sm" variant={print?.receiptLogo ? "primary" : "secondary"} icon="image"
                  disabled={busy} onClick={() => void toggleLogo()}>
                  {print?.receiptLogo ? "Logo on the receipt" : "No logo"}
                </Button>
              </div>

              {/* The printer refuses a job whose image is too big and Epson
                  don't publish the limit, so this is stepped down until a test
                  print comes out rather than guessed at. */}
              {print?.receiptLogo ? (
                <div className="stack g-2">
                  <span className="t-label">Logo size</span>
                  <div className="row wrap g-2">
                    {[128, 192, 256, 320, 384].map((n) => (
                      <Button
                        key={n}
                        size="sm"
                        variant={print.logoSize === n ? "primary" : "secondary"}
                        disabled={busy}
                        onClick={() => void setLogo(n)}
                      >
                        {n} dots
                      </Button>
                    ))}
                  </div>
                  <span className="t-xs t-muted">
                    Roughly {Math.round((print.logoSize / 504) * 100)}% of the paper width. Pick one, then
                    <b> Print a test</b> — the test page carries the logo. If nothing comes out, step down a size.
                  </span>
                </div>
              ) : null}

              <Field
                label="Top of the receipt"
                hint={print?.receiptLogo
                  ? "The logo stands in for the first line, so start with the address."
                  : "First line prints big — it's the shop's name."}
              >
                {(p) => <Textarea {...p} rows={3} value={header} onChange={(e) => setHeader(e.target.value)} placeholder={"COMMUNITY HARVEST\n510 N Main St\nNoble, Oklahoma"} />}
              </Field>
              <Field label="Bottom of the receipt">
                {(p) => <Textarea {...p} rows={4} value={footer} onChange={(e) => setFooter(e.target.value)} placeholder={"THANK YOU!\nhomegrown + homemade\n\nALL SALES FINAL"} />}
              </Field>
              <div>
                <Button variant="primary" icon="check" disabled={busy} onClick={() => void saveReceipt()}>Save the wording</Button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {/* --------------------------------------------------------- jobs -- */}
      {print && print.recent.length > 0 ? (
        <Card
          title="Last few print jobs"
          actions={
            print.failed || print.queued ? (
              <Button size="sm" variant="ghost" icon="trash" disabled={busy} onClick={() => void clearJobs("waiting")}>
                Clear {print.failed + print.queued} not printed
              </Button>
            ) : null
          }
        >
          <div className="stack g-2">
            {print.recent.map((j) => (
              <div key={j.id} className="row between wrap g-2" style={{ alignItems: "center" }}>
                <span className="stack g-1" style={{ minWidth: 0 }}>
                  <span className="row g-2" style={{ alignItems: "center" }}>
                    <Icon name={j.kind === "DRAWER" ? "cash" : "receipt"} size={14} />
                    <span>{j.label}</span>
                    <Badge tone={STATUS_TONE[j.status] || "neutral"}>{j.status.toLowerCase()}</Badge>
                  </span>
                  {j.error ? <span className="t-xs" style={{ color: "var(--danger)" }}>{j.error}</span> : null}
                </span>
                <span className="row g-2" style={{ alignItems: "center" }}>
                  <span className="t-xs t-muted">{relTime(j.createdAt)}</span>
                  {j.status === "DONE" ? null : (
                    <Button size="sm" variant="ghost" icon="close" disabled={busy} onClick={() => void clearOne(j.id)}>
                      Remove
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>

          {/* What the printer has actually been doing, newest first. The
              useful thing is never one exchange but the shape of several. */}
          {print.log?.length ? (
            <div className="stack g-1 mt-3">
              <span className="t-label">Printer trace</span>
              {print.log.map((l, i) => (
                <span key={`${l.at}${i}`} className="t-xs t-muted mono" style={{ wordBreak: "break-all" }}>
                  {relTime(l.at)} — {l.what}
                </span>
              ))}
            </div>
          ) : null}

          {/* The printer's own words, untouched. A tidied message is no help
              when the tidying is what's wrong. */}
          {print.lastResponse ? (
            <div className="stack g-1 mt-3">
              <span className="t-label">What the printer last sent back</span>
              <code
                className="mono t-xs"
                style={{
                  display: "block", whiteSpace: "pre-wrap", wordBreak: "break-all",
                  background: "var(--bg-sunken)", padding: "var(--sp-2)", borderRadius: "var(--radius-sm)",
                }}
              >
                {print.lastResponse}
              </code>
            </div>
          ) : null}
        </Card>
      ) : null}
    </main>
  );
}

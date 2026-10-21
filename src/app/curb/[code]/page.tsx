"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, EmptyState, Field, Input, Note, SkeletonCard, Textarea } from "@/components/ui";
import { money, plural } from "@/lib/format";

/**
 * Ordering from the parking lot.
 *
 * ONE PAGE, TWO MODES. Before ordering it is a menu; afterwards the SAME page
 * becomes the order's status screen, polling until it is handed over. That is
 * deliberate and it is the whole notification design: a curbside order is
 * placed minutes before collection, so the phone that placed it is still in
 * the customer's hand. Nothing to text, nothing to install, no message to
 * miss — and no SMS bill.
 *
 * The token lives in the URL, so a refresh, a locked screen or a return from
 * Stripe all come back to the same order.
 */

type Opt = { id: string; name: string; priceDeltaCents: number; soldOut: boolean };
type Group = { id: string; name: string; required: boolean; minChoices: number; maxChoices: number; options: Opt[] };
type MenuItem = {
  id: string; name: string; description: string; unitLabel: string;
  priceCents: number; soldOut: boolean; optionGroups: Group[];
};
type Menu = { vendor: { code: string; businessName: string }; open: boolean; reason: string; items: MenuItem[] };

type CartLine = { key: string; itemId: string; name: string; optionsText: string; options: Record<string, string[]>; quantity: number };

type Status = {
  number: number; vendorName: string; status: string; paid: boolean; arrived: boolean;
  totalCents: number; vehicleColor: string; ahead: number; message: string; canCheckIn: boolean;
  lines: { name: string; quantity: number; priceCents: number; optionsText: string }[];
};

export default function CurbsidePage({ params }: { params: { code: string } }) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [menuErr, setMenuErr] = useState("");

  const [token, setToken] = useState<string>("");
  const [status, setStatus] = useState<Status | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [picking, setPicking] = useState<{ item: MenuItem; picked: Record<string, string[]> } | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [vehicleColor, setVehicleColor] = useState("");
  const [note, setNote] = useState("");
  const [payMode, setPayMode] = useState<"NOW" | "INSIDE">("NOW");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  /* The token comes from the URL, so coming back from Stripe — or just
     reopening the tab — lands on the order rather than an empty menu. */
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t");
    if (t) setToken(t);
  }, []);

  const loadMenu = useCallback(async () => {
    try {
      const r = await fetch(`/api/public/curbside/${params.code}`);
      const d = await r.json();
      if (!r.ok) { setMenuErr(d.error || "Couldn't load the menu."); return; }
      setMenu(d);
    } catch {
      setMenuErr("Couldn't reach the market — check your signal.");
    }
  }, [params.code]);

  useEffect(() => { void loadMenu(); }, [loadMenu]);

  /* ---------------------------------------------------------- polling ----
     Only while there is something to watch. A handed-over order stops the
     timer rather than quietly burning somebody's battery in a parking lot. */
  const stop = useRef(false);
  useEffect(() => {
    if (!token) return;
    stop.current = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const r = await fetch(`/api/public/curbside/order/${token}`);
        const d = await r.json();
        if (r.ok) {
          setStatus(d);
          if (["COLLECTED", "CANCELLED", "NO_SHOW"].includes(d.status)) stop.current = true;
        }
      } catch { /* a dropped poll is not worth telling anybody about */ }
      if (!stop.current) timer = setTimeout(tick, 5000);
    };

    void tick();
    return () => { stop.current = true; clearTimeout(timer); };
  }, [token]);

  const addLine = (item: MenuItem, picked: Record<string, string[]>, optionsText: string) => {
    const ids = Object.values(picked).flat().sort();
    const key = ids.length ? `${item.id}|${ids.join(",")}` : item.id;
    setCart((c) => {
      const found = c.find((l) => l.key === key);
      if (found) return c.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { key, itemId: item.id, name: item.name, optionsText, options: picked, quantity: 1 }];
    });
  };

  const tapItem = (item: MenuItem) => {
    setErr("");
    if (item.optionGroups.length === 0) { addLine(item, {}, ""); return; }
    setPicking({ item, picked: {} });
  };

  /* The basket's total comes from the server, for the same reason the till's
     does: the page adding deltas itself would have to know the market fee and
     repeat the rounding, and the first disagreement is a price that changes
     when they press Order. */
  const [quote, setQuote] = useState<{ subtotalCents: number; taxCents: number; totalCents: number } | null>(null);
  useEffect(() => {
    if (cart.length === 0) { setQuote(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/public/curbside/${params.code}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "quote", lines: cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity, options: l.options })) }),
        });
        const d = await r.json();
        if (!cancelled && r.ok) setQuote(d);
      } catch { /* the Order button will say so */ }
    })();
    return () => { cancelled = true; };
  }, [cart, params.code]);

  const place = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/public/curbside/${params.code}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "place", payMode, name, phone, email, vehicleColor, note,
          lines: cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity, options: l.options })),
        }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || "That didn't go through."); return; }
      if (d.checkoutUrl) { window.location.href = d.checkoutUrl; return; }
      /* Paying inside: straight to the status screen, token in the URL so a
         refresh doesn't lose it. */
      window.history.replaceState(null, "", `/curb/${params.code}?t=${d.token}`);
      setCart([]);
      setToken(d.token);
    } catch {
      setErr("That didn't reach the market — check your signal and try again.");
    } finally { setBusy(false); }
  };

  const checkIn = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/public/curbside/order/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "arrived" }),
      });
      const d = await r.json();
      if (r.ok) setStatus(d);
    } finally { setBusy(false); }
  };

  // ------------------------------------------------------------ status --
  if (token) {
    if (!status) return <div className="page"><SkeletonCard /></div>;
    const done = ["COLLECTED", "CANCELLED", "NO_SHOW"].includes(status.status);
    return (
      <div className="page stack g-4" style={{ maxWidth: 560, margin: "0 auto", padding: "var(--sp-4)" }}>
        <Card
          title={`Order #${status.number}`}
          subtitle={status.vendorName}
          actions={status.paid ? <Badge tone="success" dot>Paid</Badge> : <Badge tone="warn" dot>Pay inside</Badge>}
        >
          <div className="card-body stack g-4">
            <p className="t-lead">{status.message}</p>

            {status.canCheckIn ? (
              <Button
                variant="primary"
                size="lg"
                loading={busy}
                onClick={checkIn}
                style={{ width: "100%", minHeight: 72, fontSize: "1.25rem" }}
              >
                I&rsquo;m here
              </Button>
            ) : null}

            {status.arrived && !done ? (
              <Note tone="success">
                They know you&rsquo;re outside — watching for the {status.vehicleColor.toLowerCase()} car.
              </Note>
            ) : null}

            {!status.paid && !done ? (
              <Note tone="warn" title="Pay at the counter">
                Come in to pay when you arrive, or send someone in — they can&rsquo;t hand it over until
                it&rsquo;s paid for.
              </Note>
            ) : null}

            <div className="stack g-1">
              {status.lines.map((l, i) => (
                <div key={i} className="row between g-3">
                  <span>
                    {l.quantity}× {l.name}
                    {l.optionsText ? <span className="t-muted"> · {l.optionsText}</span> : null}
                  </span>
                  <b className="num">{money(l.priceCents * l.quantity)}</b>
                </div>
              ))}
              <hr className="divider" />
              <div className="row between g-3">
                <b>Total</b>
                <b className="num">{money(status.totalCents)}</b>
              </div>
            </div>
          </div>
        </Card>

        {done ? (
          <Button variant="secondary" onClick={() => { window.history.replaceState(null, "", `/curb/${params.code}`); setToken(""); setStatus(null); void loadMenu(); }}>
            Order something else
          </Button>
        ) : null}
      </div>
    );
  }

  // -------------------------------------------------------------- menu --
  if (menuErr) return <div className="page"><Note tone="error">{menuErr}</Note></div>;
  if (!menu) return <div className="page"><SkeletonCard /></div>;

  const count = cart.reduce((n, l) => n + l.quantity, 0);
  const ready = cart.length > 0 && phone.trim() && vehicleColor.trim() && (payMode === "INSIDE" || email.trim());

  return (
    <div className="page stack g-4" style={{ maxWidth: 560, margin: "0 auto", padding: "var(--sp-4)" }}>
      <Card title={menu.vendor.businessName} subtitle="Order ahead — we'll bring it out to your car">
        {!menu.open ? (
          <div className="card-body"><Note tone="warn">{menu.reason}</Note></div>
        ) : null}

        <div className="card-body stack g-3">
          {menu.items.length === 0 ? (
            <EmptyState icon="box" title="Nothing on the menu yet" body="Check back shortly." />
          ) : (
            menu.items.map((i) => (
              <button
                key={i.id}
                type="button"
                className="row between g-3"
                disabled={!menu.open || i.soldOut}
                onClick={() => tapItem(i)}
                style={{
                  width: "100%", textAlign: "left", padding: "var(--sp-3)",
                  border: "1px solid var(--border)", borderRadius: "var(--radius)",
                  background: "transparent", opacity: !menu.open || i.soldOut ? 0.5 : 1,
                }}
              >
                <span className="stack g-1" style={{ minWidth: 0 }}>
                  <b className="truncate">{i.name}</b>
                  {i.description ? <span className="t-xs t-muted truncate">{i.description}</span> : null}
                  {i.soldOut ? <Badge tone="danger" dot>Sold out</Badge> : null}
                </span>
                <b className="num shrink0">{money(i.priceCents)}</b>
              </button>
            ))
          )}
        </div>
      </Card>

      {/* ---- choosing size and flavour ---- */}
      {picking ? (
        <Card title={picking.item.name} subtitle="Pick what you'd like">
          <div className="card-body stack g-4">
            {picking.item.optionGroups.map((g) => {
              const picked = picking.picked[g.id] || [];
              const single = Math.max(1, g.maxChoices) === 1;
              return (
                <div key={g.id} className="stack g-2">
                  <div className="row g-2" style={{ alignItems: "center" }}>
                    <span className="t-label">{g.name}</span>
                    {g.required ? null : <Badge tone="neutral">Optional</Badge>}
                  </div>
                  <div className="row wrap g-2">
                    {g.options.map((o) => {
                      const on = picked.includes(o.id);
                      return (
                        <Button
                          key={o.id}
                          size="sm"
                          variant={on ? "primary" : "secondary"}
                          disabled={o.soldOut}
                          onClick={() =>
                            setPicking((f) => {
                              if (!f) return f;
                              const cur = f.picked[g.id] || [];
                              const next = single
                                ? (on ? [] : [o.id])
                                : on ? cur.filter((x) => x !== o.id)
                                  : cur.length >= Math.max(1, g.maxChoices) ? cur : [...cur, o.id];
                              return { ...f, picked: { ...f.picked, [g.id]: next } };
                            })
                          }
                        >
                          {o.name}
                          {o.soldOut ? " — sold out" : o.priceDeltaCents > 0 ? ` +${money(o.priceDeltaCents)}` : o.priceDeltaCents < 0 ? ` −${money(Math.abs(o.priceDeltaCents))}` : ""}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <div className="row g-2">
              <Button
                variant="primary"
                onClick={() => {
                  const text = picking.item.optionGroups
                    .flatMap((g) => g.options.filter((o) => (picking.picked[g.id] || []).includes(o.id)).map((o) => o.name))
                    .join(" · ");
                  addLine(picking.item, picking.picked, text);
                  setPicking(null);
                }}
              >
                Add
              </Button>
              <Button variant="ghost" onClick={() => setPicking(null)}>Cancel</Button>
            </div>
          </div>
        </Card>
      ) : null}

      {/* ---- the basket and who to look for ---- */}
      {count > 0 ? (
        <Card title={`Your order · ${plural(count, "item")}`}>
          <div className="card-body stack g-4">
            <div className="stack g-2">
              {cart.map((l) => (
                <div key={l.key} className="row between g-3" style={{ alignItems: "center" }}>
                  <span className="stack g-1" style={{ minWidth: 0 }}>
                    <b className="truncate">{l.quantity}× {l.name}</b>
                    {l.optionsText ? <span className="t-xs t-muted truncate">{l.optionsText}</span> : null}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setCart((c) => c.filter((x) => x.key !== l.key))}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>

            {quote ? (
              <div className="stack g-1">
                <div className="row between g-3"><span>Subtotal</span><span className="num">{money(quote.subtotalCents)}</span></div>
                <div className="row between g-3"><span>Tax</span><span className="num">{money(quote.taxCents)}</span></div>
                <div className="row between g-3"><b>Total</b><b className="num">{money(quote.totalCents)}</b></div>
              </div>
            ) : null}

            <Field label="Color of your car" hint="It's how they'll find you." required>
              {(p) => <Input {...p} value={vehicleColor} onChange={(e) => setVehicleColor(e.target.value)} placeholder="Blue" />}
            </Field>
            <Field label="Phone" hint="In case they need to reach you." required>
              {(p) => <Input {...p} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
            </Field>
            <Field label="Name">
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>

            <div className="stack g-2">
              <span className="t-label">How you&rsquo;ll pay</span>
              <div className="row wrap g-2">
                <Button variant={payMode === "NOW" ? "primary" : "secondary"} onClick={() => setPayMode("NOW")}>Pay now by card</Button>
                <Button variant={payMode === "INSIDE" ? "primary" : "secondary"} onClick={() => setPayMode("INSIDE")}>Pay inside</Button>
              </div>
              {payMode === "INSIDE" ? (
                <p className="t-xs t-muted">
                  Come in to pay when you arrive — they can&rsquo;t hand it over until it&rsquo;s paid for.
                </p>
              ) : null}
            </div>

            {payMode === "NOW" ? (
              <Field label="Email" hint="For the receipt." required>
                {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
              </Field>
            ) : null}

            <Field label="Anything else?">
              {(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Light ice please" />}
            </Field>

            {err ? <Note tone="error">{err}</Note> : null}

            <Button
              variant="primary"
              size="lg"
              loading={busy}
              disabled={!menu.open || !ready}
              onClick={place}
              style={{ width: "100%", minHeight: 56 }}
            >
              {payMode === "NOW" ? "Pay and order" : "Place order"}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Button, Card, EmptyState, Field, Icon, Input, LinkButton, Note, PageHeader,
  Select, Skeleton, Modal, useDialog, useToast,
} from "@/components/ui";
import { money, plural } from "@/lib/format";
import {
  parseLength, fmtLength, fmtSize, sqFt, wallPoints, roomPolygon, closureGapIn,
  roomAreaSqFt, bounds, footprint, overlaps, spaceInsideRoom, snap,
  wallSolids, openingPoints, overlapProblem, rentable,
  STATUS_LABEL, KIND_LABEL, KIND_PRESETS, OPENING_LABEL, OPENING_PRESETS, SPACE_KINDS,
  type Wall, type Space, type Opening, type SpaceKind,
} from "@/lib/floorplan";

/**
 * The site map.
 *
 * DRAWN IN INCHES, NOT PIXELS. The SVG's viewBox is the room's real dimensions,
 * so a 5×5 booth is 60 units square in a room that is 360 units wide, and the
 * browser does the scaling. That is what makes this measurement-accurate rather
 * than a picture that looks about right: there is no scale factor anywhere in
 * the drawing code to get wrong, and zooming is the viewBox changing size.
 *
 * Rooms are entered wall by wall because that is how a room is measured — walk
 * it with a tape, type what it says, turn the corner. The outline is derived
 * from those numbers, so it cannot flatter a bad measurement; when the walls
 * don't return to their starting corner the gap is reported in inches instead.
 */

type PlanSpace = Space & { kind: string; contractId: string; notes: string; vendorCode: string };
type Plan = {
  id: string; name: string; gridIn: number; notes: string;
  walls: Wall[]; gapIn: number; areaSqFt: number; spaces: PlanSpace[];
};
type ContractRow = {
  id: string; vendorId: string; vendorName: string; vendorCode: string;
  boothLabel: string; monthlyRentCents: number; status: string; placed: boolean;
};

const STATUS_FILL: Record<string, string> = {
  AVAILABLE: "var(--bg-elevated)",
  HELD: "var(--warn-soft)",
  TAKEN: "var(--accent-soft)",
};
const STATUS_STROKE: Record<string, string> = {
  AVAILABLE: "var(--border-strong)",
  HELD: "var(--warn)",
  TAKEN: "var(--accent)",
};

/* Fixtures aren't rented, so they don't take a status colour — a register desk
   shown as "available" would be nonsense. They read as part of the building. */
const KIND_FILL: Record<string, string> = {
  DESK: "var(--bg-sunken)",
  FIXTURE: "var(--bg-sunken)",
  TABLE: "var(--bg-elevated)",
  WALKWAY: "transparent",
};
const KIND_STROKE: Record<string, string> = {
  DESK: "var(--text-muted)",
  FIXTURE: "var(--text-muted)",
  TABLE: "var(--border-strong)",
  WALKWAY: "var(--info)",
};

function fillFor(s: PlanSpace): string {
  if (s.kind && s.kind !== "BOOTH" && KIND_FILL[s.kind] !== undefined) return KIND_FILL[s.kind];
  return STATUS_FILL[s.status] || STATUS_FILL.AVAILABLE;
}
function strokeFor(s: PlanSpace): string {
  if (s.kind && s.kind !== "BOOTH" && KIND_STROKE[s.kind]) return KIND_STROKE[s.kind];
  return STATUS_STROKE[s.status] || STATUS_STROKE.AVAILABLE;
}

export default function FloorPlanPage() {
  const toast = useToast();
  const dialog = useDialog();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [planId, setPlanId] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [wallsOpen, setWallsOpen] = useState(false);
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<SpaceKind>("BOOTH");
  const [newSize, setNewSize] = useState("60x60");

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch("/api/admin/floorplan");
      if (!r.ok) { setErr("Couldn't load the site map."); return; }
      const d = await r.json();
      setPlans(d.plans || []);
      setContracts(d.contracts || []);
      setPlanId((cur) => cur || (d.plans?.[0]?.id ?? ""));
    } catch {
      setErr("No connection.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const plan = plans.find((p) => p.id === planId) || null;
  const poly = useMemo(() => (plan ? roomPolygon(plan.walls) : []), [plan]);
  const box = useMemo(() => bounds(poly), [poly]);

  /* Problems, worked out once and shown in one place rather than as surprises
     while dragging: booths on top of each other, and booths outside the room. */
  const problems = useMemo(() => {
    const overlapping = new Set<string>();
    const blocking = new Set<string>();
    const outside = new Set<string>();
    if (!plan) return { overlapping, blocking, outside };
    for (let i = 0; i < plan.spaces.length; i++) {
      const a = plan.spaces[i];
      if (!spaceInsideRoom(a, poly)) outside.add(a.id);
      for (let j = i + 1; j < plan.spaces.length; j++) {
        const b = plan.spaces[j];
        if (!overlaps(a, b)) continue;
        /* Two walkways crossing is a junction. A booth in a walkway is the
           blocked aisle this map exists to catch, and it's a different warning
           from two booths on top of each other. */
        const kind = overlapProblem(a, b);
        if (kind === "COLLISION") { overlapping.add(a.id); overlapping.add(b.id); }
        else if (kind === "BLOCKS_WALKWAY") {
          blocking.add(a.kind === "WALKWAY" ? b.id : a.id);
        }
      }
    }
    return { overlapping, blocking, outside };
  }, [plan, poly]);

  /* ------------------------------------------------------------- saving -- */

  const patchSpace = async (id: string, body: Record<string, unknown>, optimistic = true) => {
    if (optimistic) {
      setPlans((ps) => ps.map((p) => ({
        ...p,
        spaces: p.spaces.map((s) => (s.id === id ? { ...s, ...(body as Partial<PlanSpace>) } : s)),
      })));
    }
    const r = await fetch("/api/admin/floorplan", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ what: "space", id, ...body }),
    });
    if (!r.ok) { toast.error("That didn't save"); await load(); }
    else if (!optimistic) await load();
  };

  const patchPlan = async (body: Record<string, unknown>) => {
    if (!plan) return;
    const r = await fetch("/api/admin/floorplan", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ what: "plan", id: plan.id, ...body }),
    });
    if (!r.ok) toast.error("Couldn't save the room");
    await load();
  };

  const addRoom = async () => {
    const name = await dialog.prompt({
      title: "Name this room",
      body: <p>Whatever you call it out loud — &ldquo;Main room&rdquo;, &ldquo;Room 2&rdquo;.</p>,
      confirmLabel: "Add it",
      placeholder: "Main room",
    });
    if (!name) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/floorplan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ what: "plan", name, walls: [] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't add it"); return; }
      await load();
      setPlanId(d.id);
      setWallsOpen(true);
    } finally { setBusy(false); }
  };

  const addSpace = async () => {
    if (!plan) return;
    const [w, dp] = newSize.split("x").map(Number);
    const sameKind = plan.spaces.filter((sp) => (sp.kind || "BOOTH") === newKind).length;
    const prefix: Record<string, string> = { BOOTH: "B", TABLE: "T", DESK: "Desk", FIXTURE: "F", WALKWAY: "Aisle" };
    /* Dropped near the top-left of the room rather than at 0,0 — a booth
       exactly on the corner is hard to grab, and it reads as a mistake. */
    const x = snap(box.minX + 12, plan.gridIn || 1);
    const y = snap(box.minY + 12, plan.gridIn || 1);
    setBusy(true);
    try {
      const r = await fetch("/api/admin/floorplan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          what: "space", planId: plan.id,
          kind: newKind,
          label: `${prefix[newKind] || "B"}${sameKind + 1}`,
          xIn: x, yIn: y, widthIn: w, depthIn: dp, rotationDeg: 0,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't add the booth"); return; }
      await load();
      setSelected(d.id);
    } finally { setBusy(false); }
  };

  const removeSpace = async (s: PlanSpace) => {
    const yes = await dialog.confirm({
      title: `Remove ${s.label || "this booth"}?`,
      body: <p>{s.vendorName ? `${s.vendorName} is assigned to it. Their agreement isn't touched — only the square on this map.` : "It comes off the map. Nothing else changes."}</p>,
      confirmLabel: "Remove it",
      tone: "danger",
    });
    if (!yes) return;
    await fetch(`/api/admin/floorplan?space=${encodeURIComponent(s.id)}`, { method: "DELETE" });
    setSelected(null);
    await load();
  };

  /* ------------------------------------------------------------ dragging -- */

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  /** Screen point → plan inches, via the SVG's own transform. No scale maths here. */
  const toPlan = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  const onDown = (e: React.PointerEvent, s: PlanSpace) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toPlan(e);
    dragRef.current = { id: s.id, dx: p.x - s.xIn, dy: p.y - s.yIn };
    setSelected(s.id);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !plan) return;
    const p = toPlan(e);
    const step = plan.gridIn || 1;
    const xIn = snap(p.x - d.dx, step);
    const yIn = snap(p.y - d.dy, step);
    setPlans((ps) => ps.map((pl) => pl.id !== plan.id ? pl : {
      ...pl, spaces: pl.spaces.map((s) => (s.id === d.id ? { ...s, xIn, yIn } : s)),
    }));
  };

  const onUp = async () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !plan) return;
    const s = plan.spaces.find((x) => x.id === d.id);
    if (s) await patchSpace(s.id, { xIn: s.xIn, yIn: s.yIn }, false);
  };

  /* Arrow keys, because a tape measure is exact and a thumb is not. One inch a
     press, a foot with shift. */
  useEffect(() => {
    if (!selected || !plan) return;
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      };
      const d = map[e.key];
      if (!d) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      e.preventDefault();
      const step = e.shiftKey ? 12 : 1;
      const s = plan.spaces.find((x) => x.id === selected);
      if (!s) return;
      void patchSpace(selected, { xIn: s.xIn + d[0] * step, yIn: s.yIn + d[1] * step });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, plan]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --------------------------------------------------------------- draw -- */

  const sel = plan?.spaces.find((s) => s.id === selected) || null;
  const pad = 36; // inches of margin around the room so labels have room
  const viewBox = plan && poly.length >= 3
    ? `${box.minX - pad} ${box.minY - pad} ${box.w + pad * 2} ${box.h + pad * 2}`
    : "0 0 480 360";

  const wallSegments = plan ? wallPoints(plan.walls) : [];

  const unplaced = contracts.filter((c) => !c.placed);

  if (loading) {
    return (
      <main className="content">
        <div className="stack g-4"><Skeleton height={28} width="40%" /><Skeleton height={320} /></div>
      </main>
    );
  }

  return (
    <main className="content">
      <div className="mb-3">
        <LinkButton href="/admin" variant="ghost" size="sm" icon="arrowLeft">Admin</LinkButton>
      </div>

      <PageHeader
        title="Site map"
        subtitle="Measure each room wall by wall, lay the booths out to scale, and put vendors in them."
      />

      {err ? <Note tone="error" title="Couldn't load it">{err}</Note> : null}

      {plans.length === 0 ? (
        <Card>
          <EmptyState
            icon="grid"
            title="No rooms yet"
            body="Start with one room. You'll walk its walls with a tape measure and type what it says — the shape draws itself from your numbers."
            action={<Button variant="primary" icon="plus" onClick={() => void addRoom()}>Add a room</Button>}
          />
        </Card>
      ) : (
        <div className="stack g-4">
          {/* ---- room switcher ---- */}
          <div className="row wrap g-2" style={{ alignItems: "center" }}>
            {plans.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={p.id === planId ? "primary" : "secondary"}
                onClick={() => { setPlanId(p.id); setSelected(null); }}
              >
                {p.name}
                {p.spaces.length ? ` · ${p.spaces.length}` : ""}
              </Button>
            ))}
            <Button size="sm" variant="ghost" icon="plus" onClick={() => void addRoom()}>Room</Button>
          </div>

          {plan ? (
            <>
              {plan.walls.length === 0 ? (
                <Note tone="info" title="This room has no walls yet">
                  Stand in a corner with a tape measure and walk the room. Type each wall&rsquo;s length and which
                  way you turn at the end of it. The outline is drawn from those numbers.
                  <div className="mt-3">
                    <Button variant="primary" icon="edit" onClick={() => setWallsOpen(true)}>Measure the walls</Button>
                  </div>
                </Note>
              ) : plan.gapIn > 1 ? (
                <Note tone="warn" title={`The walls don't meet — they're ${fmtLength(plan.gapIn)} apart`}>
                  The last wall doesn&rsquo;t finish where the first one started, so one of the lengths or turns is
                  off. The drawing below shows the shape your numbers make, gap and all.
                  <div className="mt-3">
                    <Button size="sm" variant="secondary" icon="edit" onClick={() => setWallsOpen(true)}>Check the walls</Button>
                  </div>
                </Note>
              ) : null}

              {/* ---- the toolbar ---- */}
              <Card
                title={plan.name}
                subtitle={
                  plan.walls.length
                    ? `${plural(plan.walls.length, "wall")} · ${plan.areaSqFt} sq ft of floor · ${plural(plan.spaces.length, "booth")}`
                    : "Not measured yet"
                }
                actions={
                  <>
                    <Button size="sm" variant="secondary" icon="edit" onClick={() => setWallsOpen(true)}>Walls</Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      onClick={async () => {
                        const yes = await dialog.confirm({
                          title: `Delete ${plan.name}?`,
                          body: <p>The room and its {plural(plan.spaces.length, "booth")} come off the map. Vendor agreements aren&rsquo;t touched.</p>,
                          confirmLabel: "Delete the room",
                          tone: "danger",
                        });
                        if (!yes) return;
                        await fetch(`/api/admin/floorplan?plan=${encodeURIComponent(plan.id)}`, { method: "DELETE" });
                        setPlanId("");
                        await load();
                      }}
                    >
                      Delete room
                    </Button>
                  </>
                }
              >
                <div className="stack g-3">
                  <div className="row wrap g-3" style={{ alignItems: "flex-end" }}>
                    <Field label="Add">
                      {(p) => (
                        <Select
                          {...p}
                          value={newKind}
                          style={{ width: 150 }}
                          onChange={(e) => {
                            const k = e.target.value as SpaceKind;
                            setNewKind(k);
                            /* Switch the size list with it — a walkway offered a
                               5×5 default was a walkway nobody used. */
                            const first = KIND_PRESETS[k][0];
                            setNewSize(`${first.widthIn}x${first.depthIn}`);
                          }}
                        >
                          {SPACE_KINDS.map((k) => (
                            <option key={k} value={k}>{KIND_LABEL[k]}</option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label="Size">
                      {(p) => (
                        <Select {...p} value={newSize} onChange={(e) => setNewSize(e.target.value)} style={{ width: 170 }}>
                          {KIND_PRESETS[newKind].map((s) => (
                            <option key={s.label} value={`${s.widthIn}x${s.depthIn}`}>{s.label}</option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Button variant="primary" icon="plus" disabled={busy || plan.walls.length === 0} onClick={() => void addSpace()}>
                      Add {KIND_LABEL[newKind].toLowerCase()}
                    </Button>
                    <Field label="Snap to">
                      {(p) => (
                        <Select {...p} value={String(plan.gridIn)} onChange={(e) => void patchPlan({ gridIn: Number(e.target.value) })} style={{ width: 130 }}>
                          <option value="0">No snapping</option>
                          <option value="1">1 inch</option>
                          <option value="3">3 inches</option>
                          <option value="6">6 inches</option>
                          <option value="12">1 foot</option>
                        </Select>
                      )}
                    </Field>
                  </div>

                  {problems.overlapping.size > 0 || problems.outside.size > 0 || problems.blocking.size > 0 ? (
                    <Note tone="warn">
                      {problems.overlapping.size > 0 ? `${plural(problems.overlapping.size, "thing")} overlapping. ` : ""}
                      {problems.blocking.size > 0 ? `${plural(problems.blocking.size, "thing")} standing in a walkway. ` : ""}
                      {problems.outside.size > 0 ? `${plural(problems.outside.size, "thing")} outside the room. ` : ""}
                      They&rsquo;re outlined in red below.
                    </Note>
                  ) : null}
                </div>
              </Card>

              {/* ---- the drawing ---- */}
              <Card flush>
                <div style={{ background: "var(--bg-sunken)", borderRadius: "var(--r-lg)", padding: "var(--sp-2)" }}>
                  <svg
                    ref={svgRef}
                    viewBox={viewBox}
                    style={{ width: "100%", height: "auto", maxHeight: "70vh", touchAction: "none", display: "block" }}
                    onPointerMove={onMove}
                    onPointerUp={() => void onUp()}
                    onPointerLeave={() => void onUp()}
                    onPointerDown={() => setSelected(null)}
                    role="img"
                    aria-label={`Scale drawing of ${plan.name}`}
                  >
                    {/* One-foot grid, so the drawing reads as measured rather than sketched. */}
                    <defs>
                      <pattern id="ft" width="12" height="12" patternUnits="userSpaceOnUse">
                        <path d="M12 0 L0 0 0 12" fill="none" stroke="var(--border-subtle)" strokeWidth="0.5" />
                      </pattern>
                    </defs>
                    {poly.length >= 3 ? (
                      <polygon points={poly.map((p) => `${p.x},${p.y}`).join(" ")} fill="url(#ft)" stroke="none" />
                    ) : null}

                    {/* Walkways first, so they sit UNDER the things standing
                        in them — an aisle is floor, not furniture. */}
                    {plan.spaces.filter((sp) => sp.kind === "WALKWAY").map((sp) => {
                      const f = footprint(sp);
                      return (
                        <rect
                          key={sp.id}
                          x={sp.xIn} y={sp.yIn} width={f.w} height={f.h}
                          fill="var(--info-soft)" opacity={0.55}
                          stroke="var(--info)" strokeWidth="1" strokeDasharray="8 5"
                          onPointerDown={(e) => onDown(e, sp)}
                          style={{ cursor: "grab" }}
                        />
                      );
                    })}

                    {/* The walls. Drawn as the SOLID stretches either side of
                        every door, arch and window, so an opening is a real gap
                        in the line rather than a symbol sitting on top of it. */}
                    {wallSegments.slice(0, -1).map((a, i) => {
                      const b = wallSegments[i + 1];
                      const w = plan.walls[i];
                      const openings = w.openings || [];
                      const mx = (a.x + b.x) / 2;
                      const my = (a.y + b.y) / 2;
                      /* Nudge the label to the outside of the wall so it never
                         sits on top of a booth pushed against it. */
                      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
                      const nx = -((b.y - a.y) / len) * 14;
                      const ny = ((b.x - a.x) / len) * 14;
                      return (
                        <g key={i}>
                          {wallSolids(a, b, openings).map((seg, k) => (
                            <line
                              key={k}
                              x1={seg.from.x} y1={seg.from.y} x2={seg.to.x} y2={seg.to.y}
                              stroke="var(--text)" strokeWidth="3" strokeLinecap="square"
                            />
                          ))}

                          {openings.map((o, k) => {
                            const pts = openingPoints(a, b, o);
                            const ox = (pts.from.x + pts.to.x) / 2;
                            const oy = (pts.from.y + pts.to.y) / 2;
                            /* Each opening reads differently at a glance:
                               a window keeps a thin line across the gap, an
                               archway is dashed, a doorway is left open with a
                               swing, a service hatch gets a bar. */
                            return (
                              <g key={`o${k}`}>
                                {o.kind === "WINDOW" ? (
                                  <line x1={pts.from.x} y1={pts.from.y} x2={pts.to.x} y2={pts.to.y} stroke="var(--info)" strokeWidth="1.5" />
                                ) : o.kind === "ARCH" ? (
                                  <line x1={pts.from.x} y1={pts.from.y} x2={pts.to.x} y2={pts.to.y} stroke="var(--text-muted)" strokeWidth="1.5" strokeDasharray="5 4" />
                                ) : o.kind === "SERVICE" ? (
                                  <line x1={pts.from.x} y1={pts.from.y} x2={pts.to.x} y2={pts.to.y} stroke="var(--warn)" strokeWidth="3" />
                                ) : null}
                                {/* End ticks, so a doorway reads as a measured
                                    opening rather than a missing bit of wall. */}
                                <circle cx={pts.from.x} cy={pts.from.y} r="2.5" fill="var(--text)" />
                                <circle cx={pts.to.x} cy={pts.to.y} r="2.5" fill="var(--text)" />
                                <text
                                  x={ox + nx} y={oy + ny}
                                  textAnchor="middle" dominantBaseline="middle"
                                  style={{ fontSize: 7.5, fill: "var(--text-muted)" }}
                                >
                                  {o.label || OPENING_LABEL[o.kind]} {fmtLength(o.widthIn)}
                                </text>
                              </g>
                            );
                          })}

                          <text
                            x={mx - nx} y={my - ny}
                            textAnchor="middle" dominantBaseline="middle"
                            style={{ fontSize: 11, fill: "var(--text-muted)", fontWeight: 600 }}
                          >
                            {fmtLength(w.lengthIn)}{w.label ? ` · ${w.label}` : ""}
                          </text>
                        </g>
                      );
                    })}

                    {/* The gap, drawn honestly rather than closed for appearances. */}
                    {plan.gapIn > 1 && wallSegments.length > 1 ? (
                      <line
                        x1={wallSegments[wallSegments.length - 1].x} y1={wallSegments[wallSegments.length - 1].y}
                        x2={0} y2={0}
                        stroke="var(--danger)" strokeWidth="2" strokeDasharray="6 4"
                      />
                    ) : null}

                    {/* Everything standing on the floor. Walkways already drawn. */}
                    {plan.spaces.filter((sp) => sp.kind !== "WALKWAY").map((s) => {
                      const f = footprint(s);
                      const bad = problems.overlapping.has(s.id) || problems.outside.has(s.id) || problems.blocking.has(s.id);
                      const isSel = s.id === selected;
                      return (
                        <g
                          key={s.id}
                          onPointerDown={(e) => onDown(e, s)}
                          style={{ cursor: "grab" }}
                        >
                          <rect
                            x={s.xIn} y={s.yIn} width={f.w} height={f.h}
                            rx={2}
                            fill={fillFor(s)}
                            stroke={bad ? "var(--danger)" : isSel ? "var(--accent)" : strokeFor(s)}
                            strokeWidth={isSel ? 3 : bad ? 3 : 1.5}
                          />
                          <text
                            x={s.xIn + f.w / 2} y={s.yIn + f.h / 2 - 7}
                            textAnchor="middle" dominantBaseline="middle"
                            style={{ fontSize: 10, fontWeight: 700, fill: "var(--text)", pointerEvents: "none" }}
                          >
                            {s.label}
                          </text>
                          <text
                            x={s.xIn + f.w / 2} y={s.yIn + f.h / 2 + 5}
                            textAnchor="middle" dominantBaseline="middle"
                            style={{ fontSize: 8, fill: "var(--text-muted)", pointerEvents: "none" }}
                          >
                            {fmtSize(s.widthIn, s.depthIn)}
                          </text>
                          {s.vendorName ? (
                            <text
                              x={s.xIn + f.w / 2} y={s.yIn + f.h / 2 + 16}
                              textAnchor="middle" dominantBaseline="middle"
                              style={{ fontSize: 7.5, fill: "var(--accent-text)", pointerEvents: "none" }}
                            >
                              {s.vendorName.length > 18 ? `${s.vendorName.slice(0, 17)}…` : s.vendorName}
                            </text>
                          ) : null}
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </Card>

              {/* ---- the selected booth ---- */}
              {sel ? (
                <Card
                  title={`${sel.label || KIND_LABEL[(sel.kind || "BOOTH") as SpaceKind]}`}
                  subtitle={`${fmtSize(sel.widthIn, sel.depthIn)} ft · ${sqFt(sel.widthIn, sel.depthIn)} sq ft · ${fmtLength(sel.xIn)} from the left, ${fmtLength(sel.yIn)} down`}
                  actions={<Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Close</Button>}
                >
                  <div className="stack g-4">
                    <div className="row wrap g-3" style={{ alignItems: "flex-end" }}>
                      <Field label="What it is">
                        {(p) => (
                          <Select
                            {...p}
                            value={(sel.kind || "BOOTH")}
                            style={{ width: 150 }}
                            onChange={(e) => void patchSpace(sel.id, { kind: e.target.value }, false)}
                          >
                            {SPACE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                          </Select>
                        )}
                      </Field>
                      <Field label="Name on the map">
                        {(p) => (
                          <Input {...p} value={sel.label} style={{ width: 140 }}
                            onChange={(e) => void patchSpace(sel.id, { label: e.target.value })} />
                        )}
                      </Field>
                      <Field label="Size">
                        {(p) => (
                          <Select
                            {...p}
                            value={`${sel.widthIn}x${sel.depthIn}`}
                            style={{ width: 150 }}
                            onChange={(e) => {
                              const [w, d] = e.target.value.split("x").map(Number);
                              void patchSpace(sel.id, { widthIn: w, depthIn: d });
                            }}
                          >
                            {(KIND_PRESETS[(sel.kind || "BOOTH") as SpaceKind] || []).map((o) => (
                              <option key={o.label} value={`${o.widthIn}x${o.depthIn}`}>{o.label}</option>
                            ))}
                            {/* Whatever it is now, even if it isn't a preset —
                                otherwise picking a kind silently resizes it. */}
                            {!(KIND_PRESETS[(sel.kind || "BOOTH") as SpaceKind] || []).some((o) => o.widthIn === sel.widthIn && o.depthIn === sel.depthIn) ? (
                              <option value={`${sel.widthIn}x${sel.depthIn}`}>{fmtSize(sel.widthIn, sel.depthIn)} ft</option>
                            ) : null}
                          </Select>
                        )}
                      </Field>
                      <Button variant="secondary" icon="refresh" onClick={() => void patchSpace(sel.id, { rotationDeg: (sel.rotationDeg + 90) % 360 })}>
                        Turn 90°
                      </Button>
                    </div>

                    {rentable(sel.kind || "BOOTH") ? (
                    <div className="row wrap g-2">
                      {(["AVAILABLE", "HELD", "TAKEN"] as const).map((st) => (
                        <Button
                          key={st}
                          size="sm"
                          variant={sel.status === st ? "primary" : "secondary"}
                          onClick={() => void patchSpace(sel.id, { status: st })}
                        >
                          {STATUS_LABEL[st]}
                        </Button>
                      ))}
                    </div>
                    ) : null}

                    {/* A walkway or a structural fixture is not let to anybody,
                        so it gets no status buttons and no vendor picker. */}
                    {rentable(sel.kind || "BOOTH") ? (
                      <div className="row wrap g-2" style={{ alignItems: "center" }}>
                        {sel.vendorName ? (
                          <>
                            <Badge tone="success" dot>{sel.vendorCode} {sel.vendorName}</Badge>
                            <Button size="sm" variant="ghost" onClick={() => void patchSpace(sel.id, { vendorId: "", contractId: "" }, false)}>
                              Clear
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="secondary" icon="store" onClick={() => setAssignFor(sel.id)}>
                            Put a vendor in it
                          </Button>
                        )}
                      </div>
                    ) : (
                      <span className="t-xs t-muted">
                        {KIND_LABEL[(sel.kind || "BOOTH") as SpaceKind]}s aren&rsquo;t let to anyone, so there&rsquo;s
                        nothing to assign. {sel.kind === "WALKWAY" ? "Anything standing in this one is flagged above." : ""}
                      </span>
                    )}

                    <div>
                      <Button size="sm" variant="dangerSoft" icon="trash" onClick={() => void removeSpace(sel)}>
                        Remove this booth
                      </Button>
                    </div>

                    <span className="t-xs t-muted">
                      Drag it to move. Arrow keys nudge an inch at a time, with shift a foot — worth using when it
                      has to sit exactly against a wall.
                    </span>
                  </div>
                </Card>
              ) : null}

              {/* ---- signed but nowhere to stand ---- */}
              {unplaced.length > 0 ? (
                <Card
                  title="Signed, with nowhere to stand"
                  subtitle="Agreements signed by both sides that aren't on any map yet."
                >
                  <div className="stack g-2">
                    {unplaced.map((c) => (
                      <div key={c.id} className="row between wrap g-3" style={{ padding: "var(--sp-2) 0", borderBottom: "1px solid var(--border-subtle)" }}>
                        <span className="stack g-1">
                          <b>{c.vendorName}</b>
                          <span className="t-xs t-muted">{c.boothLabel || "No booth named on the agreement"}</span>
                        </span>
                        <span className="num t-sm">{money(c.monthlyRentCents)}/mo</span>
                      </div>
                    ))}
                  </div>
                </Card>
              ) : null}
            </>
          ) : null}
        </div>
      )}

      {plan ? (
        <WallEditor
          open={wallsOpen}
          plan={plan}
          onClose={() => setWallsOpen(false)}
          onSave={async (walls, name) => { await patchPlan({ walls, name }); setWallsOpen(false); }}
        />
      ) : null}

      <Modal open={!!assignFor} onClose={() => setAssignFor(null)} title="Who's in this booth?" width="sm">
        <div className="stack g-2">
          {contracts.length === 0 ? (
            <EmptyState icon="store" title="No signed agreements" body="Once an agreement is signed by both sides the vendor turns up here." />
          ) : (
            contracts.map((c) => (
              <button
                key={c.id}
                type="button"
                className="nav-item"
                style={{ minHeight: 48 }}
                onClick={async () => {
                  const id = assignFor;
                  setAssignFor(null);
                  if (id) await patchSpace(id, { vendorId: c.vendorId, contractId: c.id }, false);
                }}
              >
                <Icon name="store" size={16} />
                <span className="stack g-1 grow" style={{ minWidth: 0, textAlign: "left" }}>
                  <span className="truncate">{c.vendorName}</span>
                  <span className="t-xs t-muted truncate">
                    {c.boothLabel || "No booth named"} · {money(c.monthlyRentCents)}/mo
                    {c.placed ? " · already on the map" : ""}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </Modal>
    </main>
  );
}

/**
 * Typing a room in, wall by wall.
 *
 * Every length is parsed as you go and echoed back in feet and inches, so a
 * mistyped wall is visible before it becomes a wrong drawing. The running
 * closure gap at the bottom is the real check: a room whose walls don't return
 * to their starting corner has a bad measurement in it somewhere.
 */
function WallEditor({
  open, plan, onClose, onSave,
}: {
  open: boolean;
  plan: Plan;
  onClose: () => void;
  onSave: (walls: Wall[], name: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(plan.name);
  const [rows, setRows] = useState<{ raw: string; turnDeg: number; label: string; openings: Opening[] }[]>([]);
  /* Which wall's doors and windows are open for editing. Only one at a time —
     five walls of expanded opening lists is a form nobody can read. */
  const [openWall, setOpenWall] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(plan.name);
    setRows(
      plan.walls.length
        ? plan.walls.map((w) => ({
            raw: fmtLength(w.lengthIn).replace(/[′″]/g, (m) => (m === "′" ? "'" : '"')),
            turnDeg: w.turnDeg,
            label: w.label || "",
            openings: w.openings || [],
          }))
        : [{ raw: "", turnDeg: 90, label: "", openings: [] }]
    );
  }, [open, plan]);

  const parsed: (Wall | null)[] = rows.map((r) => {
    const lengthIn = parseLength(r.raw);
    return lengthIn === null ? null : { lengthIn, turnDeg: r.turnDeg, label: r.label, openings: r.openings };
  });
  const good = parsed.filter((w): w is Wall => w !== null);
  const gap = good.length >= 3 ? closureGapIn(good) : null;
  const area = good.length >= 3 ? roomAreaSqFt(good) : 0;

  return (
    <Modal open={open} onClose={onClose} title="Measure the room" width="md">
      <div className="stack g-4">
        <Field label="Room name">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>

        <Note tone="info">
          Start in a corner and walk the room the same way round throughout. For each wall, type what the tape
          says and which way you turn at the end of it. <b>24&rsquo; 6&quot;</b>, <b>24 6</b> and <b>24.5</b> all
          mean the same thing.
        </Note>

        <div className="stack g-2">
          {rows.map((r, i) => {
            const inches = parseLength(r.raw);
            return (
              <div key={i} className="row wrap g-2" style={{ alignItems: "flex-end" }}>
                <span className="t-label" style={{ width: 56 }}>Wall {i + 1}</span>
                <Field label="Length" error={r.raw && inches === null ? "Can't read that" : undefined}>
                  {(p) => (
                    <Input
                      {...p}
                      value={r.raw}
                      placeholder="24' 6&quot;"
                      style={{ width: 120 }}
                      onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, raw: e.target.value } : x)))}
                    />
                  )}
                </Field>
                <Field label="Then turn">
                  {(p) => (
                    <Select
                      {...p}
                      value={String(r.turnDeg)}
                      style={{ width: 150 }}
                      onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, turnDeg: Number(e.target.value) } : x)))}
                    >
                      <option value="90">Right (corner)</option>
                      <option value="-90">Left (inside corner)</option>
                      <option value="45">Right 45°</option>
                      <option value="-45">Left 45°</option>
                      <option value="0">Straight on</option>
                    </Select>
                  )}
                </Field>
                <Field label="Label">
                  {(p) => (
                    <Input
                      {...p}
                      value={r.label}
                      placeholder="North wall"
                      style={{ width: 130 }}
                      onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    />
                  )}
                </Field>
                <span className="t-xs t-muted" style={{ minWidth: 60 }}>
                  {inches !== null ? fmtLength(inches) : ""}
                </span>
                <Button
                  size="sm"
                  variant={r.openings.length ? "secondary" : "ghost"}
                  onClick={() => setOpenWall(openWall === i ? null : i)}
                >
                  {r.openings.length ? `${r.openings.length} opening${r.openings.length === 1 ? "" : "s"}` : "Doors & windows"}
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Remove wall ${i + 1}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  ✕
                </Button>

                {openWall === i ? (
                  <div
                    className="stack g-2"
                    style={{ width: "100%", padding: "var(--sp-3)", background: "var(--bg-sunken)", borderRadius: "var(--r-md)" }}
                  >
                    <span className="t-xs t-muted">
                      Measured from the corner you started this wall at. A door 5 feet along is{" "}
                      <b>5&rsquo;</b> from that corner.
                    </span>

                    {r.openings.map((o, k) => (
                      <div key={k} className="row wrap g-2" style={{ alignItems: "flex-end" }}>
                        <Field label="What">
                          {(p) => (
                            <Select
                              {...p}
                              value={o.kind}
                              style={{ width: 150 }}
                              onChange={(e) => setRows((rs) => rs.map((x, j) => j !== i ? x : {
                                ...x, openings: x.openings.map((y, m) => (m === k ? { ...y, kind: e.target.value as Opening["kind"] } : y)),
                              }))}
                            >
                              {(Object.keys(OPENING_LABEL) as Opening["kind"][]).map((kk) => (
                                <option key={kk} value={kk}>{OPENING_LABEL[kk]}</option>
                              ))}
                            </Select>
                          )}
                        </Field>
                        <Field label="Starts at">
                          {(p) => (
                            <Input
                              {...p}
                              defaultValue={fmtLength(o.offsetIn).replace(/[′″]/g, (m) => (m === "′" ? "'" : '"'))}
                              style={{ width: 100 }}
                              onBlur={(e) => {
                                const v = parseLength(e.target.value);
                                if (v === null) return;
                                setRows((rs) => rs.map((x, j) => j !== i ? x : {
                                  ...x, openings: x.openings.map((y, m) => (m === k ? { ...y, offsetIn: v } : y)),
                                }));
                              }}
                            />
                          )}
                        </Field>
                        <Field label="Wide">
                          {(p) => (
                            <Input
                              {...p}
                              defaultValue={fmtLength(o.widthIn).replace(/[′″]/g, (m) => (m === "′" ? "'" : '"'))}
                              style={{ width: 100 }}
                              onBlur={(e) => {
                                const v = parseLength(e.target.value);
                                if (v === null || v <= 0) return;
                                setRows((rs) => rs.map((x, j) => j !== i ? x : {
                                  ...x, openings: x.openings.map((y, m) => (m === k ? { ...y, widthIn: v } : y)),
                                }));
                              }}
                            />
                          )}
                        </Field>
                        <Field label="Label">
                          {(p) => (
                            <Input
                              {...p}
                              defaultValue={o.label || ""}
                              placeholder="Front door"
                              style={{ width: 130 }}
                              onBlur={(e) => setRows((rs) => rs.map((x, j) => j !== i ? x : {
                                ...x, openings: x.openings.map((y, m) => (m === k ? { ...y, label: e.target.value } : y)),
                              }))}
                            />
                          )}
                        </Field>
                        <Button
                          size="sm" variant="ghost" aria-label="Remove this opening"
                          onClick={() => setRows((rs) => rs.map((x, j) => j !== i ? x : { ...x, openings: x.openings.filter((_, m) => m !== k) }))}
                        >
                          ✕
                        </Button>
                      </div>
                    ))}

                    <div className="row wrap g-2">
                      {OPENING_PRESETS.map((preset) => (
                        <Button
                          key={preset.label}
                          size="sm"
                          variant="secondary"
                          icon="plus"
                          onClick={() => setRows((rs) => rs.map((x, j) => j !== i ? x : {
                            ...x,
                            openings: [...x.openings, { kind: preset.kind, widthIn: preset.widthIn, offsetIn: 0, label: "" }],
                          }))}
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div>
          <Button size="sm" variant="secondary" icon="plus" onClick={() => setRows((rs) => [...rs, { raw: "", turnDeg: 90, label: "", openings: [] }])}>
            Another wall
          </Button>
        </div>

        {gap !== null ? (
          gap <= 1 ? (
            <Note tone="success" title="The walls close">
              {plural(good.length, "wall")} · {area} sq ft of floor.
            </Note>
          ) : (
            <Note tone="warn" title={`Out by ${fmtLength(gap)}`}>
              The last wall doesn&rsquo;t finish where the first one started. Usually one length is mistyped or a
              turn is the wrong way. You can save it anyway and fix it later — the drawing will show the gap.
            </Note>
          )
        ) : null}

        <div className="row wrap g-2">
          <Button variant="primary" icon="check" disabled={good.length < 3} onClick={() => void onSave(good, name)}>
            Save the room
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

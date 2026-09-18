"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Button, Card, EmptyState, Field, Icon, Input, LinkButton, Note, PageHeader,
  Select, Skeleton, Modal, useDialog, useToast,
} from "@/components/ui";
import { money, plural } from "@/lib/format";
import {
  parseLength, fmtLength, fmtSize, wallPoints, roomPolygon, closureGapIn,
  roomAreaSqFt, bounds, footprint, overlaps, spaceInsideRoom, snap,
  wallSolids, openingPoints, overlapProblem, rentable, nearestWall, openingMeasures, projectOnSegment,
  centreOf, centroid, outwardNormal, offsetPt,
  outline, isCorner, spaceSqFt, describeSize, legThickness,
  STATUS_LABEL, KIND_LABEL, KIND_PRESETS, OPENING_LABEL, OPENING_PRESETS, SPACE_KINDS,
  type Wall, type Space, type Opening, type SpaceKind, type Pt,
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

/**
 * A dimension line: the measurement drawn where it is measured.
 *
 * The number on its own, in a panel, was the problem — you could type "5 feet
 * from the corner" and have no way to see WHICH corner, or to check the drawing
 * against the room. Drawn on the plan, with ticks at both ends and the figure
 * in the middle, it is the same thing an architect's drawing shows and it needs
 * no explaining.
 *
 * Pushed outside the wall along `normal`, so it never lands on top of a booth
 * standing against the wall being measured.
 */
function Dim({
  from, to, normal, offset, label, tone = "var(--text-muted)",
}: {
  from: Pt; to: Pt; normal: Pt; offset: number; label: string; tone?: string;
}) {
  const a = offsetPt(from, normal, offset);
  const b = offsetPt(to, normal, offset);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return null;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  /* Ticks run along the wall's normal, so they read as end-stops however the
     wall is oriented. */
  const t = 5;
  const tick = (p: Pt) => (
    <line
      x1={p.x - normal.x * t} y1={p.y - normal.y * t}
      x2={p.x + normal.x * t} y2={p.y + normal.y * t}
      stroke={tone} strokeWidth="1.2"
    />
  );
  /* Witness lines back to the thing being measured, so the eye can follow the
     dimension to the point it belongs to. */
  const witness = (p: Pt, q: Pt) => (
    <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={tone} strokeWidth="0.7" strokeDasharray="3 3" opacity={0.7} />
  );
  return (
    <g style={{ pointerEvents: "none" }}>
      {witness(from, a)}
      {witness(to, b)}
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={tone} strokeWidth="1.2" />
      {tick(a)}
      {tick(b)}
      <text
        x={mid.x} y={mid.y}
        textAnchor="middle" dominantBaseline="middle"
        style={{ fontSize: 9, fontWeight: 700, fill: tone, paintOrder: "stroke", stroke: "var(--bg-sunken)", strokeWidth: 3 }}
      >
        {label}
      </text>
    </g>
  );
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
  /* Placing an opening: pick what it is, then click the wall where it goes.
     Typing a distance from "the start of the wall" meant knowing which corner
     the software counted from, which is not knowable standing in the room. */
  const [placing, setPlacing] = useState<{ kind: Opening["kind"]; widthIn: number } | null>(null);
  /* What the next opening will be. Kept separate from `placing` so the width
     survives cancelling, and so nothing is armed until you say so. */
  const [openKind, setOpenKind] = useState<Opening["kind"]>("DOOR");
  const [openWidthRaw, setOpenWidthRaw] = useState("3'");
  const [selOpening, setSelOpening] = useState<{ wall: number; index: number } | null>(null);
  /* Show every opening's measurements at once, for checking the whole room
     against a tape. Off by default because twelve dimension lines at once is a
     drawing you can't read. */
  const [showAllDims, setShowAllDims] = useState(false);
  const [newKind, setNewKind] = useState<SpaceKind>("BOOTH");
  /* Typed, not picked. Presets are shortcuts that fill these boxes — every
     market ends up with a booth nobody sells, and a shelf is whatever length
     of wall is left over. Both accept 5, 5'6", 66" or 5 6. */
  const [newW, setNewW] = useState("5'");
  const [newD, setNewD] = useState("5'");
  const [newShape, setNewShape] = useState<"RECT" | "LCORNER">("RECT");
  const [newLeg, setNewLeg] = useState('16"');

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch("/api/admin/floorplan");
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setErr(String(d.error || "Couldn't load the site map."));
        return;
      }
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
  const roomCentre = useMemo(() => centroid(poly), [poly]);

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
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      toast.error("That didn't save", String(d.error || ""));
      await load();
    }
    else if (!optimistic) await load();
  };

  const patchPlan = async (body: Record<string, unknown>) => {
    if (!plan) return;
    const r = await fetch("/api/admin/floorplan", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ what: "plan", id: plan.id, ...body }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      toast.error("Couldn't save the room", String(d.error || ""));
    }
    await load();
  };

  /** Replace one wall's openings and save the room. */
  const setOpenings = async (wallIndex: number, openings: Opening[]) => {
    if (!plan) return;
    const walls = plan.walls.map((w, i) => (i === wallIndex ? { ...w, openings } : w));
    setPlans((ps) => ps.map((pl) => (pl.id === plan.id ? { ...pl, walls } : pl)));
    const r = await fetch("/api/admin/floorplan", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ what: "plan", id: plan.id, walls }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      toast.error("Couldn't save that", String(d.error || ""));
      await load();
    }
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
      /* The server's own words. "Couldn't add it" on its own meant the one
         thing most likely to be wrong — the SQL not having been run — was
         indistinguishable from a typo in a room name. */
      if (!r.ok) { toast.error("Couldn't add the room", String(d.error || "")); return; }
      await load();
      setPlanId(d.id);
      setWallsOpen(true);
    } finally { setBusy(false); }
  };

  const addSpace = async () => {
    if (!plan) return;
    /* Read what was typed. A size that can't be read stops the add rather than
       quietly becoming a 5x5 — a booth the wrong size on the map is worse than
       no booth at all. */
    const w = parseLength(newW);
    const dp = parseLength(newD);
    if (w === null || w < 6) { toast.error("Check the width", "Try 5, 5'6\" or 66\"."); return; }
    if (dp === null || dp < 6) { toast.error("Check the depth", "Try 5, 5'6\" or 66\"."); return; }
    const leg = newShape === "LCORNER" ? parseLength(newLeg) : 0;
    if (newShape === "LCORNER" && (leg === null || leg < 2)) { toast.error("Check the shelf depth", "Try 16\" or 1'6\"."); return; }
    const sameKind = plan.spaces.filter((sp) => (sp.kind || "BOOTH") === newKind).length;
    const prefix: Record<string, string> = { BOOTH: "B", SHELF: "S", TABLE: "T", DESK: "Desk", FIXTURE: "F", WALKWAY: "Aisle" };
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
          shape: newShape, legIn: leg || 0,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't add it", String(d.error || "")); return; }
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
  const openDragRef = useRef<{ wall: number; index: number } | null>(null);

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
    /* Dragging a door slides it ALONG its wall — it can't leave the wall, so
       the pointer is projected onto that one wall rather than followed. */
    const od = openDragRef.current;
    if (od && plan) {
      const wall = plan.walls[od.wall];
      const o = wall?.openings?.[od.index];
      if (!wall || !o) return;
      const a = wallSegments[od.wall];
      const b = wallSegments[od.wall + 1];
      if (!a || !b) return;
      const p = toPlan(e);
      const proj = projectOnSegment(p, a, b);
      const step = plan.gridIn || 1;
      const offsetIn = Math.max(0, Math.min(snap(proj.t - o.widthIn / 2, step), wall.lengthIn - o.widthIn));
      setPlans((ps) => ps.map((pl) => pl.id !== plan.id ? pl : {
        ...pl,
        walls: pl.walls.map((w, i) => i !== od.wall ? w : {
          ...w, openings: (w.openings || []).map((x, k) => (k === od.index ? { ...x, offsetIn } : x)),
        }),
      }));
      return;
    }

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
    const od = openDragRef.current;
    openDragRef.current = null;
    if (od && plan) {
      await setOpenings(od.wall, plan.walls[od.wall]?.openings || []);
      return;
    }

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
  /* Dimension lines sit 26in outside the wall, plus ticks and a figure, so the
     margin has to grow when they're showing or they get clipped. */
  const pad = selOpening || showAllDims ? 80 : 36;
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
                            setNewW(fmtLength(first.widthIn).replace(/[\u2032\u2033]/g, (c) => (c === "\u2032" ? "'" : '"')));
                            setNewD(fmtLength(first.depthIn).replace(/[\u2032\u2033]/g, (c) => (c === "\u2032" ? "'" : '"')));
                            setNewShape((first.shape as "RECT" | "LCORNER") || "RECT");
                            if (first.legIn) setNewLeg(fmtLength(first.legIn).replace(/[\u2032\u2033]/g, (c) => (c === "\u2032" ? "'" : '"')));
                          }}
                        >
                          {SPACE_KINDS.map((k) => (
                            <option key={k} value={k}>{KIND_LABEL[k]}</option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    {/* Presets only fill the boxes below. Whatever gets typed
                        wins, because no two markets rent the same sizes. */}
                    <Field label="Preset">
                      {(p) => (
                        <Select
                          {...p}
                          value=""
                          style={{ width: 175 }}
                          onChange={(e) => {
                            const pre = KIND_PRESETS[newKind].find((o) => o.label === e.target.value);
                            if (!pre) return;
                            const t = (v: number) => fmtLength(v).replace(/[\u2032\u2033]/g, (c) => (c === "\u2032" ? "'" : '"'));
                            setNewW(t(pre.widthIn));
                            setNewD(t(pre.depthIn));
                            setNewShape((pre.shape as "RECT" | "LCORNER") || "RECT");
                            if (pre.legIn) setNewLeg(t(pre.legIn));
                          }}
                        >
                          <option value="">Pick a size…</option>
                          {KIND_PRESETS[newKind].map((s) => (
                            <option key={s.label} value={s.label}>{s.label}</option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label={newShape === "LCORNER" ? "Arm one" : "Width"} hint="5, 5&apos;6&quot; or 66&quot;">
                      {(p) => (
                        <Input {...p} value={newW} style={{ width: 92 }} onChange={(e) => setNewW(e.target.value)} />
                      )}
                    </Field>
                    <Field label={newShape === "LCORNER" ? "Arm two" : "Depth"}>
                      {(p) => (
                        <Input {...p} value={newD} style={{ width: 92 }} onChange={(e) => setNewD(e.target.value)} />
                      )}
                    </Field>
                    <Field label="Shape">
                      {(p) => (
                        <Select
                          {...p}
                          value={newShape}
                          style={{ width: 140 }}
                          onChange={(e) => setNewShape(e.target.value as "RECT" | "LCORNER")}
                        >
                          <option value="RECT">Straight</option>
                          <option value="LCORNER">Corner (L)</option>
                        </Select>
                      )}
                    </Field>
                    {newShape === "LCORNER" ? (
                      <Field label="Shelf depth" hint="How deep the shelf itself is">
                        {(p) => (
                          <Input {...p} value={newLeg} style={{ width: 92 }} onChange={(e) => setNewLeg(e.target.value)} />
                        )}
                      </Field>
                    ) : null}
                    <Button variant="primary" icon="plus" disabled={busy || plan.walls.length === 0} onClick={() => void addSpace()}>
                      Add {KIND_LABEL[newKind].toLowerCase()}
                    </Button>
                  </div>

                  {/* Openings go in by pointing at the wall, not by typing a
                      distance from a corner the drawing never named. The width
                      is typed BEFORE placing: every door in a real building is
                      its own size, and the presets are only shortcuts. */}
                  <div className="row wrap g-3" style={{ alignItems: "flex-end" }}>
                    <Field label="Opening">
                      {(p) => (
                        <Select
                          {...p}
                          value={openKind}
                          style={{ width: 160 }}
                          onChange={(e) => { setOpenKind(e.target.value as Opening["kind"]); setPlacing(null); }}
                        >
                          {(Object.keys(OPENING_LABEL) as Opening["kind"][]).map((kk) => (
                            <option key={kk} value={kk}>{OPENING_LABEL[kk]}</option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field
                      label="How wide"
                      error={openWidthRaw && parseLength(openWidthRaw) === null ? "Can't read that" : undefined}
                    >
                      {(p) => (
                        <Input
                          {...p}
                          value={openWidthRaw}
                          placeholder="3' 2&quot;"
                          style={{ width: 110 }}
                          onChange={(e) => { setOpenWidthRaw(e.target.value); setPlacing(null); }}
                        />
                      )}
                    </Field>
                    <Button
                      variant={placing ? "primary" : "secondary"}
                      icon="plus"
                      disabled={plan.walls.length === 0 || parseLength(openWidthRaw) === null}
                      onClick={() => {
                        const w = parseLength(openWidthRaw);
                        if (w === null || w <= 0) return;
                        setPlacing((cur) => (cur ? null : { kind: openKind, widthIn: w }));
                      }}
                    >
                      {placing ? "Cancel" : "Place it"}
                    </Button>
                    <Button
                      size="sm"
                      variant={showAllDims ? "primary" : "ghost"}
                      onClick={() => setShowAllDims((v) => !v)}
                    >
                      {showAllDims ? "Hide measurements" : "Show all measurements"}
                    </Button>
                    <span className="t-xs t-muted">
                      or:{" "}
                      {OPENING_PRESETS.map((preset, i) => (
                        <button
                          key={preset.label}
                          type="button"
                          className="linklike"
                          onClick={() => {
                            setOpenKind(preset.kind);
                            setOpenWidthRaw(fmtLength(preset.widthIn).replace(/[′″]/g, (c) => (c === "′" ? "'" : '"')));
                            setPlacing({ kind: preset.kind, widthIn: preset.widthIn });
                          }}
                        >
                          {preset.label}{i < OPENING_PRESETS.length - 1 ? ", " : ""}
                        </button>
                      ))}
                    </span>
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

                  {placing ? (
                    <Note tone="info">
                      Now tap the wall where the {fmtLength(placing.widthIn)} {OPENING_LABEL[placing.kind].toLowerCase()}
                      goes. It drops centred on the spot you tap, and you can drag it along the wall afterwards or
                      type the exact distance from either corner.
                    </Note>
                  ) : null}

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
                    onPointerDown={(e) => {
                      if (!placing || !plan) { setSelected(null); setSelOpening(null); return; }
                      /* Clicked somewhere in the room with an opening in hand:
                         drop it on whichever wall is nearest, centred on the
                         click, so it lands where the finger pointed. */
                      const pt = toPlan(e);
                      const hit = nearestWall(pt, wallSegments);
                      if (!hit) { toast.error("Click on a wall", "Openings live in walls — tap the wall where it goes."); return; }
                      const wall = plan.walls[hit.index];
                      const width = Math.min(placing.widthIn, wall.lengthIn);
                      const step = plan.gridIn || 1;
                      const offsetIn = Math.max(0, Math.min(snap(hit.t - width / 2, step), wall.lengthIn - width));
                      const next = [...(wall.openings || []), { kind: placing.kind, widthIn: width, offsetIn, label: "" }];
                      setSelOpening({ wall: hit.index, index: next.length - 1 });
                      setPlacing(null);
                      void setOpenings(hit.index, next);
                    }}
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
                      const c = centreOf(sp);
                      return (
                        <polygon
                          key={sp.id}
                          points={outline({ ...sp, rotationDeg: 0 }).map((q) => `${q.x},${q.y}`).join(" ")}
                          transform={`rotate(${sp.rotationDeg || 0} ${c.x} ${c.y})`}
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
                      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                      /* Worked out from the room's own centre, so it is the
                         real outside however the room was walked. Wall and
                         opening labels go INSIDE; dimension lines go outside,
                         and the two can never land on each other. */
                      const outward = outwardNormal(a, b, roomCentre);
                      const wallLabelAt = offsetPt(mid, outward, -16);
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
                            const isSelOpening = selOpening?.wall === i && selOpening?.index === k;
                            return (
                              <g
                                key={`o${k}`}
                                style={{ cursor: "grab" }}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  (e.target as Element).setPointerCapture?.(e.pointerId);
                                  setSelOpening({ wall: i, index: k });
                                  setSelected(null);
                                  openDragRef.current = { wall: i, index: k };
                                }}
                              >
                                {/* A fat invisible grab strip: a 3px line is
                                    impossible to hit with a thumb. */}
                                <line
                                  x1={pts.from.x} y1={pts.from.y} x2={pts.to.x} y2={pts.to.y}
                                  stroke="transparent" strokeWidth="26" strokeLinecap="round"
                                />
                                {isSelOpening ? (
                                  <line
                                    x1={pts.from.x} y1={pts.from.y} x2={pts.to.x} y2={pts.to.y}
                                    stroke="var(--accent)" strokeWidth="7" strokeLinecap="round" opacity={0.65}
                                  />
                                ) : null}
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
                                  x={offsetPt({ x: ox, y: oy }, outward, -13).x}
                                  y={offsetPt({ x: ox, y: oy }, outward, -13).y}
                                  textAnchor="middle" dominantBaseline="middle"
                                  style={{ fontSize: 7.5, fill: "var(--text-muted)" }}
                                >
                                  {o.label || OPENING_LABEL[o.kind]} {fmtLength(o.widthIn)}
                                </text>

                                {/* The measurements, drawn where they're taken:
                                    corner → opening, the opening itself, and
                                    opening → the other corner. Three lines that
                                    add up to the wall, so you can check them
                                    against the tape without doing arithmetic. */}
                                {(isSelOpening || showAllDims) ? (() => {
                                  const out = outward;
                                  const m = openingMeasures(o, w.lengthIn);
                                  return (
                                    <>
                                      {m.fromStart > 0 ? (
                                        <Dim from={a} to={pts.from} normal={out} offset={26} label={fmtLength(m.fromStart)}
                                          tone={isSelOpening ? "var(--accent)" : "var(--text-muted)"} />
                                      ) : null}
                                      <Dim from={pts.from} to={pts.to} normal={out} offset={26} label={fmtLength(o.widthIn)}
                                        tone={isSelOpening ? "var(--accent)" : "var(--text-muted)"} />
                                      {m.fromEnd > 0 ? (
                                        <Dim from={pts.to} to={b} normal={out} offset={26} label={fmtLength(m.fromEnd)}
                                          tone={isSelOpening ? "var(--accent)" : "var(--text-muted)"} />
                                      ) : null}
                                    </>
                                  );
                                })() : null}
                              </g>
                            );
                          })}

                          <text
                            x={wallLabelAt.x} y={wallLabelAt.y}
                            textAnchor="middle" dominantBaseline="middle"
                            style={{
                              fontSize: 11, fill: "var(--text-muted)", fontWeight: 600,
                              paintOrder: "stroke", stroke: "var(--bg-sunken)", strokeWidth: 3,
                            }}
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
                      const c = centreOf(s);
                      /* Drawn unrotated, because the group around it already
                         turns — rotating the points as well would turn it
                         twice. */
                      const pts = outline({ ...s, rotationDeg: 0 }).map((q) => `${q.x},${q.y}`).join(" ");
                      /* An L's centre is in the notch — thin air. Its name goes
                         on the long arm instead, or it floats off the shelf. */
                      const corner = isCorner(s);
                      const t = corner ? legThickness(s) : 0;
                      const tx = corner ? s.xIn + s.widthIn / 2 : c.x;
                      const ty = corner ? s.yIn + t / 2 : c.y;
                      const bad = problems.overlapping.has(s.id) || problems.outside.has(s.id) || problems.blocking.has(s.id);
                      const isSel = s.id === selected;
                      return (
                        <g
                          key={s.id}
                          /* The whole group turns, so the name and the size
                             written on it turn with the booth instead of
                             sitting flat while the outline swings. */
                          transform={`rotate(${s.rotationDeg || 0} ${c.x} ${c.y})`}
                          onPointerDown={(e) => onDown(e, s)}
                          style={{ cursor: "grab" }}
                        >
                          <polygon
                            points={pts}
                            fill={fillFor(s)}
                            stroke={bad ? "var(--danger)" : isSel ? "var(--accent)" : strokeFor(s)}
                            strokeWidth={isSel ? 3 : bad ? 3 : 1.5}
                            strokeLinejoin="round"
                          />
                          <text
                            x={tx} y={corner ? ty - 5 : c.y - 7}
                            textAnchor="middle" dominantBaseline="middle"
                            style={{ fontSize: corner ? 9 : 10, fontWeight: 700, fill: "var(--text)", pointerEvents: "none" }}
                          >
                            {s.label}
                          </text>
                          <text
                            x={tx} y={corner ? ty + 5 : c.y + 5}
                            textAnchor="middle" dominantBaseline="middle"
                            style={{ fontSize: corner ? 7 : 8, fill: "var(--text-muted)", pointerEvents: "none" }}
                          >
                            {isCorner(s) ? `${fmtSize(s.widthIn, s.depthIn)} L` : fmtSize(s.widthIn, s.depthIn)}
                          </text>
                          {s.vendorName ? (
                            <text
                              x={tx} y={corner ? ty + 14 : c.y + 16}
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

              {/* ---- the selected door / window ---- */}
              {selOpening && plan.walls[selOpening.wall]?.openings?.[selOpening.index] ? (() => {
                const wall = plan.walls[selOpening.wall];
                const o = wall.openings![selOpening.index];
                const m = openingMeasures(o, wall.lengthIn);
                const write = (patch: Partial<Opening>) =>
                  void setOpenings(selOpening.wall, (wall.openings || []).map((x, k) => (k === selOpening.index ? { ...x, ...patch } : x)));
                return (
                  <Card
                    title={o.label || OPENING_LABEL[o.kind]}
                    subtitle={`In wall ${selOpening.wall + 1}${wall.label ? ` — ${wall.label}` : ""} · ${fmtLength(wall.lengthIn)} long`}
                    actions={<Button size="sm" variant="ghost" onClick={() => setSelOpening(null)}>Close</Button>}
                  >
                    <div className="stack g-4">
                      {/* Both ends, always. A single distance is only meaningful
                          if you know which corner it counts from, and standing
                          in the room you can measure from either. */}
                      <div className="row wrap g-4">
                        <div className="stack g-1">
                          <span className="t-label">From the start of this wall</span>
                          <Input
                            defaultValue={fmtLength(m.fromStart).replace(/[′″]/g, (c) => (c === "′" ? "'" : '"'))}
                            style={{ width: 120 }}
                            key={`s${m.fromStart}`}
                            onBlur={(e) => {
                              const v = parseLength(e.target.value);
                              if (v !== null) write({ offsetIn: v });
                            }}
                          />
                        </div>
                        <div className="stack g-1">
                          <span className="t-label">From the far end</span>
                          <Input
                            defaultValue={fmtLength(m.fromEnd).replace(/[′″]/g, (c) => (c === "′" ? "'" : '"'))}
                            style={{ width: 120 }}
                            key={`e${m.fromEnd}`}
                            onBlur={(e) => {
                              const v = parseLength(e.target.value);
                              /* Typed from the other corner, converted back —
                                 so either number can be the one you measured. */
                              if (v !== null) write({ offsetIn: Math.max(0, wall.lengthIn - o.widthIn - v) });
                            }}
                          />
                        </div>
                        <div className="stack g-1">
                          <span className="t-label">Wide</span>
                          <Input
                            defaultValue={fmtLength(o.widthIn).replace(/[′″]/g, (c) => (c === "′" ? "'" : '"'))}
                            style={{ width: 110 }}
                            key={`w${o.widthIn}`}
                            onBlur={(e) => {
                              const v = parseLength(e.target.value);
                              if (v !== null && v > 0) write({ widthIn: v });
                            }}
                          />
                        </div>
                      </div>

                      <div className="row wrap g-3" style={{ alignItems: "flex-end" }}>
                        <Field label="What it is">
                          {(p) => (
                            <Select {...p} value={o.kind} style={{ width: 160 }} onChange={(e) => write({ kind: e.target.value as Opening["kind"] })}>
                              {(Object.keys(OPENING_LABEL) as Opening["kind"][]).map((kk) => (
                                <option key={kk} value={kk}>{OPENING_LABEL[kk]}</option>
                              ))}
                            </Select>
                          )}
                        </Field>
                        <Field label="Label">
                          {(p) => (
                            <Input
                              {...p}
                              defaultValue={o.label || ""}
                              placeholder="Front door"
                              style={{ width: 150 }}
                              onBlur={(e) => write({ label: e.target.value })}
                            />
                          )}
                        </Field>
                      </div>

                      <span className="t-xs t-muted">
                        {fmtLength(m.fromStart)} from one corner, {fmtLength(m.fromEnd)} from the other, centre at{" "}
                        {fmtLength(m.centre)}. Drag it along the wall on the drawing, or type either distance.
                      </span>

                      <div>
                        <Button
                          size="sm" variant="dangerSoft" icon="trash"
                          onClick={() => {
                            const next = (wall.openings || []).filter((_, k) => k !== selOpening.index);
                            setSelOpening(null);
                            void setOpenings(selOpening.wall, next);
                          }}
                        >
                          Remove this {OPENING_LABEL[o.kind].toLowerCase()}
                        </Button>
                      </div>
                    </div>
                  </Card>
                );
              })() : null}

              {/* ---- the selected booth ---- */}
              {sel ? (
                <Card
                  title={`${sel.label || KIND_LABEL[(sel.kind || "BOOTH") as SpaceKind]}`}
                  subtitle={
                    `${describeSize(sel)} · ${spaceSqFt(sel)} sq ft` +
                    `${(sel.rotationDeg || 0) !== 0 ? ` · turned ${sel.rotationDeg}°` : ""}` +
                    ` · ${fmtLength(sel.xIn)} from the left, ${fmtLength(sel.yIn)} down`
                  }
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
                      {/* Typed, so an existing booth can be resized to whatever
                          it really is. Blur commits; a size that can't be read
                          is left alone rather than guessed at. */}
                      <Field label={isCorner(sel) ? "Arm one" : "Width"} hint="5, 5&apos;6&quot; or 66&quot;">
                        {(p) => (
                          <Input
                            {...p}
                            key={`w${sel.id}${sel.widthIn}`}
                            defaultValue={fmtLength(sel.widthIn).replace(/[\u2032\u2033]/g, (c) => (c === "\u2032" ? "'" : '"'))}
                            style={{ width: 92 }}
                            onBlur={(e) => {
                              const v = parseLength(e.target.value);
                              if (v !== null && v >= 6) void patchSpace(sel.id, { widthIn: v });
                            }}
                          />
                        )}
                      </Field>
                      <Field label={isCorner(sel) ? "Arm two" : "Depth"}>
                        {(p) => (
                          <Input
                            {...p}
                            key={`d${sel.id}${sel.depthIn}`}
                            defaultValue={fmtLength(sel.depthIn).replace(/[\u2032\u2033]/g, (c) => (c === "\u2032" ? "'" : '"'))}
                            style={{ width: 92 }}
                            onBlur={(e) => {
                              const v = parseLength(e.target.value);
                              if (v !== null && v >= 6) void patchSpace(sel.id, { depthIn: v });
                            }}
                          />
                        )}
                      </Field>
                      <Field label="Shape">
                        {(p) => (
                          <Select
                            {...p}
                            value={(sel.shape as string) || "RECT"}
                            style={{ width: 140 }}
                            onChange={(e) => {
                              const shape = e.target.value;
                              /* Turning a straight shelf into a corner with no
                                 depth set would draw a rectangle and look
                                 broken, so it gets a sensible depth on the way. */
                              const legIn = shape === "LCORNER" && !(sel.legIn || 0)
                                ? Math.max(6, Math.min(18, Math.floor(Math.min(sel.widthIn, sel.depthIn) / 2)))
                                : undefined;
                              void patchSpace(sel.id, legIn === undefined ? { shape } : { shape, legIn });
                            }}
                          >
                            <option value="RECT">Straight</option>
                            <option value="LCORNER">Corner (L)</option>
                          </Select>
                        )}
                      </Field>
                      {((sel.shape as string) || "RECT") === "LCORNER" ? (
                        <Field label="Shelf depth">
                          {(p) => (
                            <Input
                              {...p}
                              key={`g${sel.id}${sel.legIn}`}
                              defaultValue={fmtLength(legThickness(sel)).replace(/[\u2032\u2033]/g, (c) => (c === "\u2032" ? "'" : '"'))}
                              style={{ width: 92 }}
                              onBlur={(e) => {
                                const v = parseLength(e.target.value);
                                if (v !== null && v >= 2) void patchSpace(sel.id, { legIn: v });
                              }}
                            />
                          )}
                        </Field>
                      ) : null}
                      <Field label="Preset">
                        {(p) => (
                          <Select
                            {...p}
                            value=""
                            style={{ width: 175 }}
                            onChange={(e) => {
                              const pre = (KIND_PRESETS[(sel.kind || "BOOTH") as SpaceKind] || []).find((o) => o.label === e.target.value);
                              if (!pre) return;
                              void patchSpace(sel.id, {
                                widthIn: pre.widthIn, depthIn: pre.depthIn,
                                shape: pre.shape || "RECT", legIn: pre.legIn || 0,
                              });
                            }}
                          >
                            <option value="">Pick a size…</option>
                            {(KIND_PRESETS[(sel.kind || "BOOTH") as SpaceKind] || []).map((o) => (
                              <option key={o.label} value={o.label}>{o.label}</option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <div className="stack g-1">
                        <span className="t-label">Angle</span>
                        <div className="row g-2" style={{ alignItems: "center" }}>
                          <Button
                            size="sm" variant="secondary" aria-label="Turn 15 degrees anticlockwise"
                            onClick={() => void patchSpace(sel.id, { rotationDeg: (((sel.rotationDeg || 0) - 15) % 360 + 360) % 360 })}
                          >
                            ↺
                          </Button>
                          {/* Typed in degrees, because a booth following an
                              angled wall has to match the wall, not the nearest
                              quarter turn. */}
                          <Input
                            type="number"
                            min="0"
                            max="359"
                            inputMode="numeric"
                            aria-label="Angle in degrees"
                            value={String(sel.rotationDeg || 0)}
                            style={{ width: 84 }}
                            onChange={(e) => {
                              const v = ((Math.round(Number(e.target.value) || 0) % 360) + 360) % 360;
                              void patchSpace(sel.id, { rotationDeg: v });
                            }}
                          />
                          <Button
                            size="sm" variant="secondary" aria-label="Turn 15 degrees clockwise"
                            onClick={() => void patchSpace(sel.id, { rotationDeg: (((sel.rotationDeg || 0) + 15) % 360 + 360) % 360 })}
                          >
                            ↻
                          </Button>
                          <Button
                            size="sm" variant="secondary"
                            onClick={() => void patchSpace(sel.id, { rotationDeg: (((sel.rotationDeg || 0) + 90) % 360 + 360) % 360 })}
                          >
                            90°
                          </Button>
                          {(sel.rotationDeg || 0) !== 0 ? (
                            <Button size="sm" variant="ghost" onClick={() => void patchSpace(sel.id, { rotationDeg: 0 })}>
                              Square up
                            </Button>
                          ) : null}
                        </div>
                      </div>
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
                      has to sit exactly against a wall. It turns about its own centre, so it stays where it is
                      while it swings.
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
          <br />
          Doors, archways and windows go in afterwards by tapping the wall on the drawing — you don&rsquo;t have
          to work out which corner a distance counts from.
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
                <span className="t-xs t-muted" style={{ minWidth: 70 }}>
                  {r.openings.length ? `${r.openings.length} opening${r.openings.length === 1 ? "" : "s"}` : ""}
                </span>
                <Button size="sm" variant="ghost" aria-label={`Remove wall ${i + 1}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  ✕
                </Button>

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

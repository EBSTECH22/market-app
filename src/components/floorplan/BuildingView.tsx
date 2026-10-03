"use client";

/**
 * Every room on one drawing, where it really sits in the building.
 *
 * Each room is still measured on its own, wall by wall, in its own inches.
 * This only moves each room by its position in the building (originXIn /
 * originYIn — where the room's first corner is) and draws them all together,
 * so the site map reads like the sketch of the whole place: rooms side by side,
 * the openings between them lined up, and the booths in each.
 *
 * Read only. Tap a room to open it and edit its walls and booths.
 */
import { useMemo } from "react";
import {
  wallPoints, roomPolygon, bounds, centroid, wallSolids, openingPoints, outwardNormal, offsetPt,
  outline, centreOf, fmtLength, describeSize, rentable, type Wall, type Space,
} from "@/lib/floorplan";

type Room = {
  id: string; name: string; walls: Wall[]; originXIn: number; originYIn: number;
  spaces: (Space & { kind: string })[];
};

const SCREEN = {
  fill: { AVAILABLE: "var(--bg-elevated)", HELD: "var(--warn-soft)", TAKEN: "var(--accent-soft)" } as Record<string, string>,
  stroke: { AVAILABLE: "var(--border-strong)", HELD: "var(--warn)", TAKEN: "var(--accent)" } as Record<string, string>,
  wall: "var(--text)", text: "var(--text)", muted: "var(--text-secondary)", room: "var(--text-muted)",
  window: "var(--info)", opening: "var(--warn)", grid: "var(--border-subtle)",
  fixture: "var(--bg-sunken)", fixtureStroke: "var(--text-muted)", walk: "var(--info-soft)", walkStroke: "var(--info)",
};
/* Paper: fixed light colours, so a dark-mode screen still prints a white map. */
const PAPER: typeof SCREEN = {
  fill: { AVAILABLE: "#ffffff", HELD: "#fdf0d5", TAKEN: "#dcefe3" },
  stroke: { AVAILABLE: "#111111", HELD: "#b7791f", TAKEN: "#2f6b45" },
  wall: "#111111", text: "#111111", muted: "#555555", room: "#9aa0a6",
  window: "#2b6cb0", opening: "#b7791f", grid: "#ececec",
  fixture: "#e5e7eb", fixtureStroke: "#6b7280", walk: "#eef5fb", walkStroke: "#2b6cb0",
};

/** Biggest font that fits `text` across `width` (rough average glyph width). */
const fit = (text: string, width: number, max: number) => Math.max(2, Math.min(max, (width * 0.92) / Math.max(1, text.length * 0.56)));

export function BuildingView({ rooms, onOpen, showLengths = true, detailed = false, paper = false }: {
  rooms: Room[];
  onOpen?: (id: string) => void;
  showLengths?: boolean;
  /** Each booth shows who is in it (or OPEN) and its size — the printed map. */
  detailed?: boolean;
  /** Fixed light colours for printing. */
  paper?: boolean;
}) {
  const C = paper ? PAPER : SCREEN;
  const drawn = useMemo(() => rooms.filter((r) => r.walls.length >= 3).map((r) => {
    const dx = r.originXIn || 0, dy = r.originYIn || 0;
    const pts = wallPoints(r.walls).map((p) => ({ x: p.x + dx, y: p.y + dy }));
    const poly = roomPolygon(r.walls).map((p) => ({ x: p.x + dx, y: p.y + dy }));
    return { room: r, dx, dy, pts, poly, centre: centroid(poly) };
  }), [rooms]);

  const box = useMemo(() => bounds(drawn.flatMap((d) => d.poly)), [drawn]);
  if (!drawn.length) return <p className="t-sm t-muted">No measured rooms yet.</p>;

  const u = Math.max(box.w, box.h, 120) / 760;
  const pad = 48 * u;
  const fs = 11 * u;

  return (
    <svg
      viewBox={`${box.minX - pad} ${box.minY - pad} ${box.w + pad * 2} ${box.h + pad * 2}`}
      style={{ width: "100%", height: "auto", maxHeight: "78vh", display: "block" }}
      role="img"
      aria-label="Scale drawing of the whole building"
    >
      <defs>
        <pattern id="bft" width="12" height="12" patternUnits="userSpaceOnUse">
          <path d="M12 0 L0 0 0 12" fill="none" stroke={C.grid} strokeWidth="0.5" />
        </pattern>
      </defs>

      {drawn.map(({ room, poly }) => (
        <polygon
          key={`f${room.id}`}
          points={poly.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="url(#bft)"
          stroke="none"
          style={{ cursor: onOpen ? "pointer" : undefined }}
          onClick={() => onOpen?.(room.id)}
        />
      ))}

      {/* Booths and fixtures, moved with their room. */}
      {drawn.map(({ room, dx, dy }) => room.spaces.map((s) => {
        const c = centreOf(s);
        const walk = s.kind === "WALKWAY";
        const fixture = s.kind === "DESK" || s.kind === "FIXTURE";
        return (
          <g key={s.id} transform={`translate(${dx} ${dy}) rotate(${s.rotationDeg || 0} ${c.x} ${c.y})`} style={{ pointerEvents: "none" }}>
            <polygon
              points={outline({ ...s, rotationDeg: 0 }).map((q) => `${q.x},${q.y}`).join(" ")}
              fill={walk ? C.walk : fixture ? C.fixture : C.fill[s.status] || C.fill.AVAILABLE}
              opacity={walk ? 0.5 : 1}
              stroke={walk ? C.walkStroke : fixture ? C.fixtureStroke : C.stroke[s.status] || C.stroke.AVAILABLE}
              strokeWidth={(detailed && !walk && !fixture ? 1.6 : 1.2) * u}
              strokeDasharray={walk ? `${8 * u} ${5 * u}` : undefined}
            />
            {detailed && !walk && rentable(s.kind) ? (() => {
              /* Up to three lines: booth number, who's in it (or OPEN), size. */
              const w = Math.min(s.widthIn, s.depthIn) < 30 ? Math.max(s.widthIn, s.depthIn) : s.widthIn;
              const who = s.status === "TAKEN" ? (s.vendorName || "Taken") : s.status === "HELD" ? "HELD" : "OPEN";
              const size = describeSize(s);
              const lines = [s.label, who, size].filter(Boolean) as string[];
              const max = Math.min(fs * 1.15, (Math.min(s.widthIn, s.depthIn) || 24) / (lines.length * 1.25));
              const sizes = lines.map((t) => fit(t, w, max));
              const lh = Math.max(...sizes) * 1.2;
              const top = c.y - ((lines.length - 1) * lh) / 2;
              return lines.map((t, k) => (
                <text
                  key={k} x={c.x} y={top + k * lh} fontSize={sizes[k]} textAnchor="middle" dominantBaseline="middle"
                  fontWeight={t === who ? 700 : 400}
                  fill={t === "OPEN" ? C.stroke.TAKEN : t === size ? C.muted : C.text}
                >
                  {t}
                </text>
              ));
            })() : s.label && !walk ? (
              <text x={c.x} y={c.y} fontSize={fit(s.label, s.widthIn, fs)} textAnchor="middle" dominantBaseline="middle" fill={C.text}>
                {s.label}
              </text>
            ) : null}
          </g>
        );
      }))}

      {/* Walls, with real gaps for every door, arch and window. */}
      {drawn.map(({ room, pts, centre }) => pts.slice(0, -1).map((a, i) => {
        const b = pts[i + 1];
        const w = room.walls[i];
        const openings = w.openings || [];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const inward = outwardNormal(a, b, centre);
        const labelAt = offsetPt(mid, inward, -12 * u);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        return (
          <g key={`${room.id}w${i}`}>
            {wallSolids(a, b, openings).map((seg, k) => (
              <line key={k} x1={seg.from.x} y1={seg.from.y} x2={seg.to.x} y2={seg.to.y} stroke={C.wall} strokeWidth={4 * u} strokeLinecap="square" />
            ))}
            {openings.map((o, k) => {
              const p = openingPoints(a, b, o);
              return o.kind === "WINDOW" ? (
                <line key={`o${k}`} x1={p.from.x} y1={p.from.y} x2={p.to.x} y2={p.to.y} stroke={C.window} strokeWidth={2.5 * u} />
              ) : (
                <line key={`o${k}`} x1={p.from.x} y1={p.from.y} x2={p.to.x} y2={p.to.y} stroke={C.opening} strokeWidth={1.5 * u} strokeDasharray={`${5 * u} ${4 * u}`} />
              );
            })}
            {showLengths && len >= 18 ? (
              <text
                x={labelAt.x} y={labelAt.y} fontSize={fs * 0.9} textAnchor="middle" dominantBaseline="middle"
                fill={C.muted} style={{ pointerEvents: "none" }}
              >
                {fmtLength(w.lengthIn)}
              </text>
            ) : null}
          </g>
        );
      }))}

      {drawn.map(({ room, centre }) => (
        <text
          key={`n${room.id}`}
          x={centre.x} y={centre.y} fontSize={fs * 1.7} fontWeight={700} textAnchor="middle" dominantBaseline="middle"
          fill={C.room} opacity={detailed ? 0.35 : 0.8}
          style={{ cursor: onOpen ? "pointer" : undefined, textTransform: "uppercase", letterSpacing: "0.08em" }}
          onClick={() => onOpen?.(room.id)}
        >
          {room.name}
        </text>
      ))}
    </svg>
  );
}

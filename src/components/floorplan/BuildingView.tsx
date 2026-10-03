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
  outline, centreOf, fmtLength, type Wall, type Space,
} from "@/lib/floorplan";

type Room = {
  id: string; name: string; walls: Wall[]; originXIn: number; originYIn: number;
  spaces: (Space & { kind: string })[];
};

const FILL: Record<string, string> = { AVAILABLE: "var(--bg-elevated)", HELD: "var(--warn-soft)", TAKEN: "var(--accent-soft)" };
const STROKE: Record<string, string> = { AVAILABLE: "var(--border-strong)", HELD: "var(--warn)", TAKEN: "var(--accent)" };

export function BuildingView({ rooms, onOpen, showLengths = true }: {
  rooms: Room[];
  onOpen?: (id: string) => void;
  showLengths?: boolean;
}) {
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
          <path d="M12 0 L0 0 0 12" fill="none" stroke="var(--border-subtle)" strokeWidth="0.5" />
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
              fill={walk ? "var(--info-soft)" : fixture ? "var(--bg-sunken)" : FILL[s.status] || FILL.AVAILABLE}
              opacity={walk ? 0.5 : 1}
              stroke={walk ? "var(--info)" : fixture ? "var(--text-muted)" : STROKE[s.status] || STROKE.AVAILABLE}
              strokeWidth={1.2 * u}
              strokeDasharray={walk ? `${8 * u} ${5 * u}` : undefined}
            />
            {s.label && !walk ? (
              <text x={c.x} y={c.y} fontSize={fs} textAnchor="middle" dominantBaseline="middle" fill="var(--text)">
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
              <line key={k} x1={seg.from.x} y1={seg.from.y} x2={seg.to.x} y2={seg.to.y} stroke="var(--text)" strokeWidth={4 * u} strokeLinecap="square" />
            ))}
            {openings.map((o, k) => {
              const p = openingPoints(a, b, o);
              return o.kind === "WINDOW" ? (
                <line key={`o${k}`} x1={p.from.x} y1={p.from.y} x2={p.to.x} y2={p.to.y} stroke="var(--info)" strokeWidth={2.5 * u} />
              ) : (
                <line key={`o${k}`} x1={p.from.x} y1={p.from.y} x2={p.to.x} y2={p.to.y} stroke="var(--warn)" strokeWidth={1.5 * u} strokeDasharray={`${5 * u} ${4 * u}`} />
              );
            })}
            {showLengths && len >= 18 ? (
              <text
                x={labelAt.x} y={labelAt.y} fontSize={fs * 0.9} textAnchor="middle" dominantBaseline="middle"
                fill="var(--text-secondary)" style={{ pointerEvents: "none" }}
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
          fill="var(--text-muted)" opacity={0.8}
          style={{ cursor: onOpen ? "pointer" : undefined, textTransform: "uppercase", letterSpacing: "0.08em" }}
          onClick={() => onOpen?.(room.id)}
        >
          {room.name}
        </text>
      ))}
    </svg>
  );
}

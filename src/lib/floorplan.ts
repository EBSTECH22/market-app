/**
 * The floor plan: rooms measured wall by wall, and booths placed in them.
 *
 * EVERYTHING HERE IS INCHES. Not feet, not pixels, not percentages. A plan that
 * stores feet as decimals starts losing half-inches to rounding the first time
 * somebody types 24'7", and a plan that stores pixels stops being a measurement
 * the moment the window resizes. Inches are whole numbers, they survive every
 * conversion, and a market tape measure reads in them.
 *
 * The room is a LIST OF WALLS rather than a list of corners, because that is
 * how a room actually gets measured: stand in a corner, walk each wall, write
 * down what the tape says and which way you turned. Corners are then derived,
 * which means the drawing cannot disagree with the measurements — and when the
 * walls don't come back to where they started, that is a mis-measured wall,
 * reported as a gap rather than quietly drawn as a wonky shape.
 */

/**
 * A hole in a wall: a doorway, an archway, a window, the register window.
 *
 * Measured the way you'd measure it standing there — how far along the wall it
 * starts, and how wide it is — rather than as coordinates. Both in inches from
 * the START of the wall, which is the corner you were standing at when you
 * measured that wall.
 */
export type Opening = {
  kind: "DOOR" | "ARCH" | "WINDOW" | "SERVICE";
  /** Distance from the start of the wall to the near edge of the opening. */
  offsetIn: number;
  widthIn: number;
  label?: string;
};

export const OPENING_LABEL: Record<Opening["kind"], string> = {
  DOOR: "Doorway",
  ARCH: "Archway",
  WINDOW: "Window",
  SERVICE: "Service window",
};

export type Wall = {
  /** Length of this wall, in inches. */
  lengthIn: number;
  /**
   * Degrees to turn AFTER walking this wall. 90 is a normal right-hand corner
   * walking clockwise; -90 is an inside corner, as in an L-shaped room.
   */
  turnDeg: number;
  /** "North wall", "behind the register" — optional, shown on the drawing. */
  label?: string;
  /** Doors, arches and windows in this wall. */
  openings?: Opening[];
};

/**
 * What a rectangle on the floor IS.
 *
 * One shape with a kind, rather than a separate table per thing. A register
 * desk and a 5×5 booth are both a rectangle that has to sit somewhere exact and
 * must not end up inside something else — so they share every line of the
 * dragging, snapping, rotating and collision code, and only differ in what
 * they are called and whether a vendor can be put in one.
 */
export const SPACE_KINDS = ["BOOTH", "TABLE", "DESK", "FIXTURE", "WALKWAY"] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

export const KIND_LABEL: Record<SpaceKind, string> = {
  BOOTH: "Booth",
  TABLE: "Table",
  DESK: "Counter / desk",
  FIXTURE: "Fixture",
  WALKWAY: "Walkway",
};

/** Can a vendor be assigned to this? A walkway is floor nobody rents. */
export function rentable(kind: string): boolean {
  return kind !== "WALKWAY" && kind !== "FIXTURE";
}

/**
 * Walkways are the exception to every overlap rule — in both directions.
 *
 * Two walkways crossing is a junction, which is normal. But a booth sitting in
 * a walkway is the thing this map exists to prevent: an aisle that looked fine
 * on paper and is four feet wide on opening day with a table in it.
 */
export function overlapProblem(a: { kind?: string }, b: { kind?: string }): "NONE" | "COLLISION" | "BLOCKS_WALKWAY" {
  const aw = (a.kind || "BOOTH") === "WALKWAY";
  const bw = (b.kind || "BOOTH") === "WALKWAY";
  if (aw && bw) return "NONE";
  if (aw || bw) return "BLOCKS_WALKWAY";
  return "COLLISION";
}

export type Space = {
  id: string;
  label: string;
  kind?: string;
  /** Top-left corner in plan inches, before rotation. */
  xIn: number;
  yIn: number;
  widthIn: number;
  depthIn: number;
  /** 0, 90, 180 or 270. Anything else is rounded to the nearest of those. */
  rotationDeg: number;
  status: string;
  vendorId?: string | null;
  vendorName?: string | null;
};

export type Pt = { x: number; y: number };

/* ------------------------------------------------------------------ units -- */

/**
 * Read a length a human typed.
 *
 * Accepts what people actually write on a tape-measure note: `24' 6"`, `24'6`,
 * `24 6`, `24-6`, `24.5` (feet), `6"` (inches alone). Returns inches, or null
 * if it can't be read — never a guess, because a silently misread wall is a
 * room that is drawn wrong and believed.
 */
export function parseLength(raw: string): number | null {
  const s = String(raw || "").trim().replace(/\s+/g, " ");
  if (!s) return null;

  // 6" — inches only
  const inchesOnly = s.match(/^(\d+(?:\.\d+)?)\s*(?:"|''|in|inch|inches)$/i);
  if (inchesOnly) return round(Number(inchesOnly[1]));

  // 24' 6"  /  24'6  /  24'
  const feetInches = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(\d+(?:\.\d+)?)?\s*(?:"|''|in)?$/i);
  if (feetInches) {
    const ft = Number(feetInches[1]);
    const inch = feetInches[2] ? Number(feetInches[2]) : 0;
    if (inch >= 12) return null; // 24' 14" is a typo, not a measurement
    return round(ft * 12 + inch);
  }

  // 24 6  /  24-6  — feet then inches, no marks
  const bare = s.match(/^(\d+)\s*[- ]\s*(\d+(?:\.\d+)?)$/);
  if (bare) {
    const inch = Number(bare[2]);
    if (inch >= 12) return null;
    return round(Number(bare[1]) * 12 + inch);
  }

  // 24  /  24.5 — plain feet
  const plain = s.match(/^(\d+(?:\.\d+)?)$/);
  if (plain) return round(Number(plain[1]) * 12);

  return null;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** 306 → `25′ 6″`. Whole feet lose the inches part. */
export function fmtLength(inches: number): string {
  const neg = inches < 0;
  const total = Math.abs(inches);
  const ft = Math.floor(total / 12);
  const inch = round(total - ft * 12);
  const body = inch === 0 ? `${ft}′` : ft === 0 ? `${inch}″` : `${ft}′ ${inch}″`;
  return neg ? `−${body}` : body;
}

/** Compact form for drawing on a booth: 5×7. */
export function fmtSize(widthIn: number, depthIn: number): string {
  const f = (n: number) => (n % 12 === 0 ? String(n / 12) : fmtLength(n));
  return `${f(widthIn)}×${f(depthIn)}`;
}

export function sqFt(widthIn: number, depthIn: number): number {
  return Math.round(((widthIn * depthIn) / 144) * 10) / 10;
}

/* --------------------------------------------------------------- geometry -- */

/**
 * Walk the walls and return every corner, starting at (0,0) heading east.
 *
 * Screen coordinates: x grows right, y grows DOWN. So a right turn from east
 * heads south, and walking a rectangle clockwise with four 90° turns closes it.
 */
export function wallPoints(walls: Wall[]): Pt[] {
  const pts: Pt[] = [{ x: 0, y: 0 }];
  let heading = 0;
  let x = 0;
  let y = 0;
  for (const w of walls) {
    const rad = (heading * Math.PI) / 180;
    x += Math.cos(rad) * w.lengthIn;
    y += Math.sin(rad) * w.lengthIn;
    pts.push({ x: round(x), y: round(y) });
    heading += w.turnDeg;
  }
  return pts;
}

/**
 * How far the last wall ends from where the first one started.
 *
 * A closed room returns 0. Anything else means a wall was mis-measured or a
 * turn is wrong, and the number is how far out — which is usually enough to
 * spot which wall it was.
 */
export function closureGapIn(walls: Wall[]): number {
  const pts = wallPoints(walls);
  const last = pts[pts.length - 1];
  return round(Math.hypot(last.x, last.y));
}

/** The polygon to draw and to test containment against: corners without the repeated end. */
export function roomPolygon(walls: Wall[]): Pt[] {
  const pts = wallPoints(walls);
  if (pts.length > 1) {
    const last = pts[pts.length - 1];
    if (Math.hypot(last.x, last.y) < 1) pts.pop();
  }
  return pts;
}

export function bounds(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number } {
  if (pts.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Floor area of the room, square feet. Shoelace formula, sign removed. */
export function roomAreaSqFt(walls: Wall[]): number {
  const p = roomPolygon(walls);
  if (p.length < 3) return 0;
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    acc += a.x * b.y - b.x * a.y;
  }
  return Math.round((Math.abs(acc) / 2 / 144) * 10) / 10;
}

/** A booth's footprint after rotation — 90° and 270° swap width and depth. */
export function footprint(s: Pick<Space, "widthIn" | "depthIn" | "rotationDeg">): { w: number; h: number } {
  const r = ((Math.round(s.rotationDeg / 90) * 90) % 360 + 360) % 360;
  return r === 90 || r === 270 ? { w: s.depthIn, h: s.widthIn } : { w: s.widthIn, h: s.depthIn };
}

export function spaceRect(s: Space): { x: number; y: number; w: number; h: number } {
  const f = footprint(s);
  return { x: s.xIn, y: s.yIn, w: f.w, h: f.h };
}

/** Do two booths share any floor? Touching edges are fine; overlapping is not. */
export function overlaps(a: Space, b: Space): boolean {
  const r1 = spaceRect(a);
  const r2 = spaceRect(b);
  return r1.x < r2.x + r2.w && r2.x < r1.x + r1.w && r1.y < r2.y + r2.h && r2.y < r1.y + r1.h;
}

/** Ray casting. Points exactly on an edge count as inside. */
export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    /* On the edge: treat as inside rather than letting a booth pushed flat
       against a wall read as sticking out of the building. */
    const onEdge =
      Math.abs((b.y - a.y) * (pt.x - a.x) - (b.x - a.x) * (pt.y - a.y)) < 0.5 &&
      pt.x >= Math.min(a.x, b.x) - 0.5 && pt.x <= Math.max(a.x, b.x) + 0.5 &&
      pt.y >= Math.min(a.y, b.y) - 0.5 && pt.y <= Math.max(a.y, b.y) + 0.5;
    if (onEdge) return true;
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Is every corner of this booth inside the room? */
export function spaceInsideRoom(s: Space, poly: Pt[]): boolean {
  if (poly.length < 3) return true; // nothing drawn yet — don't cry about it
  const r = spaceRect(s);
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ].every((c) => pointInPolygon(c, poly));
}

/** Snap a measurement to the nearest grid step. */
export function snap(valueIn: number, stepIn: number): number {
  if (!stepIn || stepIn <= 0) return round(valueIn);
  return Math.round(valueIn / stepIn) * stepIn;
}

/** The booth sizes a market actually rents, plus whatever gets typed in. */
export const SIZE_PRESETS: { label: string; widthIn: number; depthIn: number }[] = [
  { label: "3 × 4", widthIn: 36, depthIn: 48 },
  { label: "4 × 4", widthIn: 48, depthIn: 48 },
  { label: "5 × 5", widthIn: 60, depthIn: 60 },
  { label: "5 × 7", widthIn: 60, depthIn: 84 },
  { label: "6 × 6", widthIn: 72, depthIn: 72 },
  { label: "8 × 8", widthIn: 96, depthIn: 96 },
  { label: "10 × 10", widthIn: 120, depthIn: 120 },
];

export const SPACE_STATUS = ["AVAILABLE", "HELD", "TAKEN"] as const;
export type SpaceStatus = (typeof SPACE_STATUS)[number];

export const STATUS_LABEL: Record<string, string> = {
  AVAILABLE: "Available",
  HELD: "On hold",
  TAKEN: "Taken",
};

/* ---------------------------------------------------------------- openings -- */

/**
 * Where an opening sits in real coordinates, so it can be drawn as a gap in the
 * wall rather than a symbol floating near it.
 *
 * Returns the two points along the wall. Clamped to the wall it is in: a 4-foot
 * door typed at 30 feet along a 20-foot wall is a typo, and sliding it back to
 * the end of the wall is better than drawing it out in the car park.
 */
export function openingPoints(a: Pt, b: Pt, o: Opening): { from: Pt; to: Pt } {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const width = Math.max(1, Math.min(o.widthIn, len));
  const start = Math.max(0, Math.min(o.offsetIn, len - width));
  return {
    from: { x: a.x + ux * start, y: a.y + uy * start },
    to: { x: a.x + ux * (start + width), y: a.y + uy * (start + width) },
  };
}

/** The solid stretches of a wall — everything that isn't an opening. */
export function wallSolids(a: Pt, b: Pt, openings: Opening[]): { from: Pt; to: Pt }[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;

  const cuts = openings
    .map((o) => {
      const width = Math.max(1, Math.min(o.widthIn, len));
      const start = Math.max(0, Math.min(o.offsetIn, len - width));
      return { start, end: start + width };
    })
    .sort((x, y) => x.start - y.start);

  const solids: { from: Pt; to: Pt }[] = [];
  let cursor = 0;
  for (const c of cuts) {
    /* Overlapping openings — a door and an arch typed over each other — merge
       rather than producing a negative-length wall segment. */
    if (c.start > cursor) {
      solids.push({
        from: { x: a.x + ux * cursor, y: a.y + uy * cursor },
        to: { x: a.x + ux * c.start, y: a.y + uy * c.start },
      });
    }
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < len) {
    solids.push({
      from: { x: a.x + ux * cursor, y: a.y + uy * cursor },
      to: { x: b.x, y: b.y },
    });
  }
  return solids;
}

/** Common sizes, so nobody measures a standard door. */
export const OPENING_PRESETS: { label: string; kind: Opening["kind"]; widthIn: number }[] = [
  { label: "Single door (3′)", kind: "DOOR", widthIn: 36 },
  { label: "Double door (6′)", kind: "DOOR", widthIn: 72 },
  { label: "Archway (8′)", kind: "ARCH", widthIn: 96 },
  { label: "Window (4′)", kind: "WINDOW", widthIn: 48 },
  { label: "Service window (3′)", kind: "SERVICE", widthIn: 36 },
];

/** Starting sizes by kind, so adding a walkway doesn't hand you a 5×5 square. */
export const KIND_PRESETS: Record<SpaceKind, { label: string; widthIn: number; depthIn: number }[]> = {
  BOOTH: SIZE_PRESETS,
  TABLE: [
    { label: "6′ table", widthIn: 72, depthIn: 30 },
    { label: "8′ table", widthIn: 96, depthIn: 30 },
    { label: "4′ table", widthIn: 48, depthIn: 24 },
    { label: "Round 5′", widthIn: 60, depthIn: 60 },
  ],
  DESK: [
    { label: "Register desk 6′", widthIn: 72, depthIn: 30 },
    { label: "Register desk 8′", widthIn: 96, depthIn: 30 },
    { label: "Counter 10′", widthIn: 120, depthIn: 24 },
  ],
  FIXTURE: [
    { label: "Shelf 4′", widthIn: 48, depthIn: 18 },
    { label: "Fridge", widthIn: 36, depthIn: 30 },
    { label: "Column 1′", widthIn: 12, depthIn: 12 },
    { label: "Restroom 6×6", widthIn: 72, depthIn: 72 },
  ],
  WALKWAY: [
    { label: "Aisle 4′ wide", widthIn: 48, depthIn: 240 },
    { label: "Aisle 5′ wide", widthIn: 60, depthIn: 240 },
    { label: "Aisle 6′ wide", widthIn: 72, depthIn: 240 },
  ],
};

/* --------------------------------------------------- placing on the wall -- */

/**
 * Drop a point onto a wall.
 *
 * Returns how far along the wall it lands (`t`, in inches from the wall's
 * start), how far off the wall it was (`dist`), and the point itself. This is
 * what makes "click where the door goes" possible: a click is never exactly on
 * a line, so it gets projected onto the nearest one.
 */
export function projectOnSegment(p: Pt, a: Pt, b: Pt): { t: number; dist: number; point: Pt } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return { t: 0, dist: Math.hypot(p.x - a.x, p.y - a.y), point: a };
  /* Clamped to the segment: a click past the end of a wall belongs at that
     end, not on the infinite line the wall sits on. */
  const raw = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  const u = Math.max(0, Math.min(1, raw));
  const point = { x: a.x + vx * u, y: a.y + vy * u };
  return { t: round(u * Math.sqrt(len2)), dist: round(Math.hypot(p.x - point.x, p.y - point.y)), point };
}

/**
 * Which wall was clicked, and where along it.
 *
 * `pts` is the corner list from wallPoints, so wall `i` runs pts[i] → pts[i+1]
 * and lines up with the walls array. Returns null when nothing is near enough
 * to be a deliberate click.
 */
export function nearestWall(p: Pt, pts: Pt[], maxDistIn = 36): { index: number; t: number; dist: number } | null {
  let best: { index: number; t: number; dist: number } | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const r = projectOnSegment(p, pts[i], pts[i + 1]);
    if (!best || r.dist < best.dist) best = { index: i, t: r.t, dist: r.dist };
  }
  return best && best.dist <= maxDistIn ? best : null;
}

/**
 * Where an opening sits, measured from BOTH ends of its wall.
 *
 * Both, because "5 feet along" is only meaningful if you know which corner it
 * counts from — and standing in the room you can check either. Given both, the
 * number is unambiguous whichever way you walked.
 */
export function openingMeasures(o: Opening, wallLengthIn: number): {
  fromStart: number; fromEnd: number; centre: number;
} {
  const width = Math.max(1, Math.min(o.widthIn, wallLengthIn));
  const start = Math.max(0, Math.min(o.offsetIn, wallLengthIn - width));
  return {
    fromStart: round(start),
    fromEnd: round(wallLengthIn - (start + width)),
    centre: round(start + width / 2),
  };
}

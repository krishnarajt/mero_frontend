/*
 * Stroke data, geometry and colour helpers. No DOM state lives here.
 *
 * A stroke on the wire is {id, c, w, p, k?, o?}:
 *   c  colour, as drawn in light mode
 *   w  width in world units
 *   p  flat [x0, y0, x1, y1, ...] in world units
 *   k  'l' for straight segments (shapes); absent for smoothed freehand
 *   o  opacity below 1 (highlighter); absent for opaque ink
 *   g  group id; strokes sharing one are selected and moved together
 */

export interface RawStroke {
  id: string;
  c: string;
  w: number;
  p: number[];
  k?: 'l';
  o?: number;
  g?: string;
}

export interface Stroke extends RawStroke {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  path: Path2D | null;
  dot: boolean;
  /** Live strokes only: curve segments up to this point index are on screen. */
  drawn: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type ShapeKind = 'rect' | 'square' | 'ellipse' | 'circle' | 'triangle' | 'hexagon';

export function makeStroke(raw: RawStroke): Stroke {
  const s: Stroke = {
    id: raw.id,
    c: raw.c,
    w: raw.w,
    p: raw.p,
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    path: null,
    dot: false,
    drawn: 0,
  };
  if (raw.k) s.k = raw.k;
  if (raw.o !== undefined && raw.o < 1) s.o = raw.o;
  if (raw.g) s.g = raw.g;
  growBBox(s, 0);
  return s;
}

export function toRaw(s: RawStroke): RawStroke {
  const r: RawStroke = { id: s.id, c: s.c, w: s.w, p: s.p };
  if (s.k) r.k = s.k;
  if (s.o !== undefined) r.o = s.o;
  if (s.g) r.g = s.g;
  return r;
}

/** Deep copy of the stroke's data (points included), for undo snapshots. */
export function snapshot(s: RawStroke): RawStroke {
  const r = toRaw(s);
  r.p = s.p.slice();
  return r;
}

/** Overwrite a stroke's data in place, keeping the object (and its z-order). */
export function assign(s: Stroke, r: RawStroke) {
  s.c = r.c;
  s.w = r.w;
  s.p = r.p.slice();
  if (r.k) s.k = r.k;
  else delete s.k;
  if (r.o !== undefined && r.o < 1) s.o = r.o;
  else delete s.o;
  if (r.g) s.g = r.g;
  else delete s.g;
  resetBBox(s);
}

export function resetBBox(s: Stroke) {
  s.minX = s.minY = Infinity;
  s.maxX = s.maxY = -Infinity;
  s.path = null;
  growBBox(s, 0);
}

export function growBBox(s: Stroke, from: number) {
  const p = s.p;
  for (let i = from; i < p.length; i += 2) {
    const x = p[i];
    const y = p[i + 1];
    if (x < s.minX) s.minX = x;
    if (x > s.maxX) s.maxX = x;
    if (y < s.minY) s.minY = y;
    if (y > s.maxY) s.maxY = y;
  }
}

export function buildPath(s: Stroke): Path2D {
  const p = s.p;
  const n = p.length >> 1;
  const path = new Path2D();
  s.dot = n === 1 || (s.maxX - s.minX < 1e-9 && s.maxY - s.minY < 1e-9);
  if (s.dot) {
    path.arc(p[0], p[1], s.w / 2, 0, Math.PI * 2);
    return path;
  }
  path.moveTo(p[0], p[1]);
  if (s.k === 'l') {
    for (let i = 1; i < n; i++) path.lineTo(p[2 * i], p[2 * i + 1]);
    return path;
  }
  for (let i = 1; i < n - 1; i++) {
    const x = p[2 * i];
    const y = p[2 * i + 1];
    path.quadraticCurveTo(x, y, (x + p[2 * i + 2]) / 2, (y + p[2 * i + 3]) / 2);
  }
  path.lineTo(p[2 * n - 2], p[2 * n - 1]);
  return path;
}

export function randomId(): string {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[b % 62];
  return s;
}

// ---- hit testing ---------------------------------------------------------

export function distToSegSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return x * x + y * y;
}

/** Does the segment a→b (a sweep of radius r) touch stroke s? */
export function sweepHits(s: Stroke, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const pad = s.w / 2;
  if (
    s.maxX + pad + r < Math.min(ax, bx) ||
    s.minX - pad - r > Math.max(ax, bx) ||
    s.maxY + pad + r < Math.min(ay, by) ||
    s.minY - pad - r > Math.max(ay, by)
  )
    return false;
  const lim = (r + pad) * (r + pad);
  const p = s.p;
  if (p.length === 2) return distToSegSq(p[0], p[1], ax, ay, bx, by) <= lim;
  for (let i = 0; i + 3 < p.length; i += 2) {
    // Checking each end against the other segment is close enough for
    // segments this short.
    if (
      distToSegSq(p[i], p[i + 1], ax, ay, bx, by) <= lim ||
      distToSegSq(ax, ay, p[i], p[i + 1], p[i + 2], p[i + 3]) <= lim ||
      distToSegSq(bx, by, p[i], p[i + 1], p[i + 2], p[i + 3]) <= lim
    )
      return true;
  }
  return distToSegSq(p[p.length - 2], p[p.length - 1], ax, ay, bx, by) <= lim;
}

/** Is the whole stroke inside the box? Measured on its centre line, so thick ink can poke out a little. */
export function strokeInsideBox(s: Stroke, b: Box): boolean {
  return s.minX >= b.x0 && s.maxX <= b.x1 && s.minY >= b.y0 && s.maxY <= b.y1;
}

export function unionBox(strokes: Iterable<Stroke>): Box | null {
  let b: Box | null = null;
  for (const s of strokes) {
    const r = s.w / 2;
    if (!b) b = { x0: s.minX - r, y0: s.minY - r, x1: s.maxX + r, y1: s.maxY + r };
    else {
      b.x0 = Math.min(b.x0, s.minX - r);
      b.y0 = Math.min(b.y0, s.minY - r);
      b.x1 = Math.max(b.x1, s.maxX + r);
      b.y1 = Math.max(b.y1, s.maxY + r);
    }
  }
  return b;
}

// ---- shapes ----------------------------------------------------------------

/**
 * Points for a shape dragged from (ax, ay) to (bx, by). `even` forces equal
 * width and height (always on for square and circle). `segPx` is roughly
 * how long, in world units, one segment of a curve should be.
 */
export function shapePoints(kind: ShapeKind, ax: number, ay: number, bx: number, by: number, even: boolean, seg: number): number[] {
  if (even || kind === 'square' || kind === 'circle') {
    const side = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    bx = ax + (bx >= ax ? side : -side);
    by = ay + (by >= ay ? side : -side);
  }
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;
  const rx = Math.abs(bx - ax) / 2;
  const ry = Math.abs(by - ay) / 2;
  switch (kind) {
    case 'rect':
    case 'square':
      return [ax, ay, bx, ay, bx, by, ax, by, ax, ay];
    case 'triangle':
      // Apex on the side the drag started from, so dragging up flips it.
      return [cx, ay, x1, by, x0, by, cx, ay];
    case 'hexagon': {
      const out: number[] = [];
      for (let i = 0; i <= 6; i++) {
        const a = (Math.PI / 3) * i;
        out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
      }
      return out;
    }
    case 'ellipse':
    case 'circle': {
      const perim = Math.PI * (rx + ry);
      const n = Math.max(24, Math.min(240, Math.ceil(perim / seg)));
      const out: number[] = [];
      for (let i = 0; i <= n; i++) {
        const a = (Math.PI * 2 * i) / n;
        out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
      }
      return out;
    }
  }
}

// ---- colour --------------------------------------------------------------

const darkCache = new Map<string, string>();

/**
 * Colour as shown in dark mode. Strokes keep their light-mode colour in the
 * data; only the display changes. Greys and black invert (black ink becomes
 * white ink); saturated colours keep their hue and are only lightened when
 * they are too dark to read on a dark background.
 */
export function darkColor(hex: string): string {
  let out = darkCache.get(hex);
  if (out) return out;
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  if (sat < 0.25) l = 1 - l;
  else if (l < 0.5) l = 1 - l;
  out = `hsl(${h.toFixed(1)} ${(sat * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;
  darkCache.set(hex, out);
  return out;
}

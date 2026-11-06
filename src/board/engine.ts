/*
 * Canvas engine: infinite canvas rendering and all pointer input.
 *
 * Latency model
 * - One opaque canvas created with `desynchronized: true`, so draws skip the
 *   compositor queue and reach the screen as soon as they are flushed.
 * - Pen input is read from `pointerrawupdate` where the browser has it (fires
 *   at the digitiser rate, not once per frame) plus getCoalescedEvents(), and
 *   each new piece of an opaque pen stroke is drawn straight from the event
 *   handler. No waiting for requestAnimationFrame before ink shows up.
 *   Highlighter strokes and shapes are the exception: they are redrawn whole
 *   once per frame, because drawing translucent ink piece by piece would
 *   darken every overlap.
 *
 * Rendering model
 * - Finished strokes live in an offscreen "buffer" canvas rendered for some
 *   view. A frame is: copy the buffer to the screen, then draw in-progress
 *   strokes, anything being moved, and the selection on top. Finishing a
 *   stroke paints just that stroke into the buffer, so a board with 20k
 *   strokes costs the same per frame as an empty one.
 * - Panning a large board shifts the buffer by whole device pixels and only
 *   renders the strip that scrolled into view. Zooming a large board scales
 *   the old buffer as a preview and re-renders once the gesture settles.
 *   Small boards are simply re-rendered every frame, so they are always crisp.
 * - Each finished stroke caches its Path2D in world coordinates.
 * - Strokes being moved, scaled or rotated are left out of the buffer and
 *   drawn with a canvas transform each frame; their points are only
 *   rewritten on drop.
 */

import {
  assign,
  buildPath,
  darkColor,
  growBBox,
  makeStroke,
  randomId,
  resetBBox,
  shapePoints,
  snapshot,
  strokeInsideBox,
  sweepHits,
  unionBox,
  type Box,
  type RawStroke,
  type ShapeKind,
  type Stroke,
} from './strokes';

export type { RawStroke, ShapeKind, Stroke };

export interface View {
  tx: number;
  ty: number;
  z: number;
}

export type Tool = 'select' | 'pen' | 'highlighter' | 'shape' | 'eraser' | 'hand';

export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EngineEvents {
  /** A freehand stroke started; its points follow through points(). */
  begin(s: Stroke): void;
  points(id: string, pts: number[]): void;
  end(s: Stroke): void;
  /** Whole strokes that appeared at once: shapes, duplicates, undone deletes. */
  add(strokes: Stroke[]): void;
  /** Existing strokes whose data changed: moved, scaled, restyled. */
  update(strokes: Stroke[]): void;
  erase(ids: string[]): void;
  cursor(x: number | null, y: number): void;
  viewChanged(v: View): void;
  toolChanged(t: Tool): void;
  /** Selection box on screen, or null when there is nothing to act on. */
  selection(box: ScreenBox | null, count: number): void;
}

type Action =
  | { kind: 'add'; strokes: Stroke[] }
  | { kind: 'del'; strokes: Stroke[] }
  | { kind: 'upd'; before: RawStroke[]; after: RawStroke[] };

/** p' = o + d + s·R(r)·(p − o): scale s and rotation r about o, then shift by d. */
interface Xf {
  s: number;
  r: number;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
}

const IDENTITY: Xf = { s: 1, r: 0, ox: 0, oy: 0, dx: 0, dy: 0 };

function xfPoint(xf: Xf, x: number, y: number): [number, number] {
  const c = Math.cos(xf.r) * xf.s;
  const n = Math.sin(xf.r) * xf.s;
  const px = x - xf.ox;
  const py = y - xf.oy;
  return [xf.ox + xf.dx + c * px - n * py, xf.oy + xf.dy + n * px + c * py];
}

/** Rotation handle distance above the selection box, CSS px. */
const ROTATE_OFFSET = 26;

interface SelDrag {
  id: number;
  mode: 'move' | 'scale' | 'rotate' | 'marquee';
  sx: number;
  sy: number;
  cx: number;
  cy: number;
  anchor: [number, number];
  corner: [number, number];
  moved: boolean;
  additive: boolean;
  /** How far (CSS px) the pointer must travel before a press becomes a drag. */
  slop: number;
  /** Pressed inside the selection box on a stroke outside the selection: a tap selects it. */
  tapHit: Stroke | null;
}

/** Two taps closer together than this (ms) are a double tap. */
const DOUBLE_TAP_MS = 400;

const MIN_Z = 0.02;
const MAX_Z = 64;
/** Re-render the whole buffer every frame while panning if it costs less than this. */
const FULL_RENDER_BUDGET_MS = 7;
/** Ignore samples closer than this to the previous one (CSS px). */
const MIN_SAMPLE_DIST = 0.35;
const ERASER_RADIUS = 9;
/** Fingers are ignored for this long after any pen activity (palm rejection). */
const PALM_MS = 600;

function viewEq(a: View, b: View) {
  return a.tx === b.tx && a.ty === b.ty && a.z === b.z;
}

function make2d(canvas: HTMLCanvasElement, desync: boolean): CanvasRenderingContext2D {
  return canvas.getContext('2d', { alpha: false, desynchronized: desync }) as CanvasRenderingContext2D;
}

export class Engine {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buf = document.createElement('canvas');
  private bctx: CanvasRenderingContext2D;
  private buf2 = document.createElement('canvas');
  private b2ctx: CanvasRenderingContext2D;

  private dpr = 1;
  private W = 0;
  private H = 0;
  view: View = { tx: 0, ty: 0, z: 1 };
  private bufView: View | null = null;

  private strokes: Stroke[] = [];
  private byId = new Map<string, Stroke>();
  /** In-progress strokes, ours and everyone else's. */
  private live = new Map<string, Stroke>();

  private frameReq = 0;
  private staticDirty = true;
  private gesturing = false;
  private settleTimer = 0;
  private lastFullMs = 0;

  private dark = false;
  private bg = '#ffffff';
  private accent = '#1971c2';

  tool: Tool = 'pen';
  /** Style for the next stroke; the board sets these per tool. */
  color = '#1a1a1a';
  /** Thickness in canvas units (px at 100% zoom), so ink zooms with the board... */
  width = 2;
  /** ...unless this is set: then `width` is screen px at whatever zoom you draw at. */
  widthOnScreen = false;
  opacity = 1;
  shapeKind: ShapeKind = 'rect';
  fingerDraw = false;

  private undoStack: Action[] = [];
  private redoStack: Action[] = [];

  // selection
  private selection = new Set<Stroke>();
  private selBox: Box | null = null;
  private selDrag: SelDrag | null = null;
  private marquee: Box | null = null;
  /** Where and when the last select tap ended, for spotting a double tap. */
  private lastTap: { t: number; x: number; y: number } | null = null;
  /** A restyle still being dragged on a slider: what to record for undo when it ends. */
  private stylePending: { list: Stroke[]; before: RawStroke[] } | null = null;
  private xf: Xf | null = null;
  /** Strokes left out of the buffer while they are being transformed, in z-order. */
  private hidden = new Set<Stroke>();
  private hiddenList: Stroke[] = [];

  // pointer state
  private own: Stroke | null = null;
  private drawPointer = -1;
  private sawRaw = false;
  private erasePointer = -1;
  private erased: Stroke[] = [];
  private eraseLast: [number, number] | null = null;
  private shape: { id: number; ax: number; ay: number; s: Stroke } | null = null;
  private pan: { id: number; x: number; y: number } | null = null;
  private touches = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  private tap = { start: 0, max: 0, moved: false };
  /** pointerType of whatever is drawing, erasing or selecting right now. */
  private activeType = '';
  private lastPenAt = -1e9;
  private spaceDown = false;
  private shiftDown = false;
  private lastCursorSent = 0;
  private eraserDot: HTMLDivElement;
  private disposers: (() => void)[] = [];

  constructor(
    private host: HTMLElement,
    private ev: EngineEvents,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'board-canvas';
    host.appendChild(this.canvas);
    this.ctx = make2d(this.canvas, true);
    this.bctx = make2d(this.buf, false);
    this.b2ctx = make2d(this.buf2, false);
    this.eraserDot = document.createElement('div');
    this.eraserDot.className = 'eraser-dot';
    host.appendChild(this.eraserDot);
    this.bindInput();
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.frameReq);
    clearTimeout(this.settleTimer);
    for (const d of this.disposers) d();
    this.canvas.remove();
    this.eraserDot.remove();
  }

  setDark(dark: boolean) {
    this.dark = dark;
    this.bg = dark ? '#161616' : '#ffffff';
    this.accent = dark ? '#4dabf7' : '#1971c2';
    this.invalidate();
  }

  displayColor(c: string) {
    return this.dark ? darkColor(c) : c;
  }

  // ------------------------------------------------------------------
  // Data in
  // ------------------------------------------------------------------

  load(committed: RawStroke[], live: RawStroke[]) {
    this.strokes = [];
    this.byId.clear();
    this.cancelSelDrag();
    this.selection.clear();
    this.selBox = null;
    for (const [id, s] of this.live) if (s !== this.own && s !== this.shape?.s) this.live.delete(id);
    for (const r of committed) {
      const s = makeStroke(r);
      this.strokes.push(s);
      this.byId.set(s.id, s);
    }
    for (const r of live) {
      if (!this.live.has(r.id)) this.live.set(r.id, makeStroke(r));
    }
    this.emitSelection();
    this.invalidate();
  }

  /** Adds strokes that were drawn while offline. */
  addLocal(strokes: Stroke[]) {
    for (const s of strokes) if (!this.byId.has(s.id)) this.commit(s);
    this.requestFrame();
  }

  remoteBegin(r: RawStroke) {
    if (this.live.has(r.id) || this.byId.has(r.id)) return;
    const s = makeStroke(r);
    this.live.set(s.id, s);
    this.drawLiveIncrement(s);
  }

  remoteAppend(id: string, p: number[]) {
    const s = this.live.get(id);
    if (!s || s === this.own) return;
    const from = s.p.length;
    for (let i = 0; i < p.length; i++) s.p.push(p[i]);
    growBBox(s, from);
    this.drawLiveIncrement(s);
  }

  remoteEnd(id: string) {
    const s = this.live.get(id);
    if (!s || s === this.own) return;
    this.live.delete(id);
    this.commit(s);
    // Re-compose so the stroke shows its final, cleanly anti-aliased form.
    this.requestFrame();
  }

  remoteDelete(ids: string[]) {
    if (this.removeIds(ids).length) this.invalidate();
  }

  remoteAdd(raws: RawStroke[]) {
    for (const r of raws) if (!this.byId.has(r.id)) this.commit(makeStroke(r));
    this.requestFrame();
  }

  remoteUpdate(raws: RawStroke[]) {
    if (this.applyRaws(raws).length) this.invalidate();
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  setTool(t: Tool) {
    if (t !== 'select') this.setSelection([]);
    this.tool = t;
    this.eraserDot.style.display = 'none';
    this.ev.toolChanged(t);
  }

  undo() {
    this.flushStyle();
    const a = this.undoStack.pop();
    if (!a) return;
    this.redoStack.push(a);
    if (a.kind === 'add') this.localDelete(a.strokes.map((s) => s.id));
    else if (a.kind === 'del') this.localAdd(a.strokes);
    else this.localApply(a.before);
  }

  redo() {
    this.flushStyle();
    const a = this.redoStack.pop();
    if (!a) return;
    this.undoStack.push(a);
    if (a.kind === 'add') this.localAdd(a.strokes);
    else if (a.kind === 'del') this.localDelete(a.strokes.map((s) => s.id));
    else this.localApply(a.after);
  }

  private localDelete(ids: string[]) {
    const gone = this.removeIds(ids);
    if (!gone.length) return;
    this.ev.erase(gone.map((s) => s.id));
    this.invalidate();
  }

  private localAdd(strokes: Stroke[]) {
    const back = strokes.filter((s) => !this.byId.has(s.id));
    if (!back.length) return;
    for (const s of back) this.commit(s);
    this.ev.add(back);
    this.requestFrame();
  }

  private localApply(raws: RawStroke[]) {
    const changed = this.applyRaws(raws);
    if (!changed.length) return;
    this.ev.update(changed);
    this.invalidate();
  }

  private applyRaws(raws: RawStroke[]): Stroke[] {
    const changed: Stroke[] = [];
    for (const r of raws) {
      const s = this.byId.get(r.id);
      if (!s || this.hidden.has(s)) continue;
      assign(s, r);
      changed.push(s);
    }
    if (changed.some((s) => this.selection.has(s))) {
      this.selBox = unionBox(this.selection);
      this.emitSelection();
    }
    return changed;
  }

  // ---- selection commands ----

  get selectionCount() {
    return this.selection.size;
  }

  selectAll() {
    if (this.tool !== 'select') this.setTool('select');
    this.setSelection(this.strokes);
  }

  clearSelection() {
    this.setSelection([]);
  }

  /** Selected strokes in paint order. */
  private selectedInOrder(): Stroke[] {
    return this.strokes.filter((s) => this.selection.has(s));
  }

  duplicateSelection() {
    const src = this.selectedInOrder();
    if (!src.length) return;
    const off = 20 / this.view.z;
    // Copies of a group form a new group; a lone copy of one member joins none.
    const groups = new Map<string, string | undefined>();
    for (const s of src) if (s.g) groups.set(s.g, groups.has(s.g) ? (groups.get(s.g) ?? randomId()) : undefined);
    const copies = src.map((s) => {
      const r = snapshot(s);
      r.id = randomId();
      r.p = r.p.map((v) => this.round(v + off));
      if (r.g) r.g = groups.get(r.g);
      if (!r.g) delete r.g;
      return makeStroke(r);
    });
    for (const c of copies) this.commit(c);
    this.ev.add(copies);
    this.pushUndo({ kind: 'add', strokes: copies });
    this.setSelection(copies);
  }

  deleteSelection() {
    const ids = this.selectedInOrder().map((s) => s.id);
    if (!ids.length) return;
    const gone = this.removeIds(ids);
    this.ev.erase(ids);
    this.pushUndo({ kind: 'del', strokes: gone });
    this.invalidate();
  }

  /** Which of Group and Ungroup make sense for the current selection. */
  get selectionGroupState(): { canGroup: boolean; canUngroup: boolean } {
    let first: string | undefined;
    let same = true;
    let any = false;
    let i = 0;
    for (const s of this.selection) {
      if (s.g) any = true;
      if (i++ === 0) first = s.g;
      else if (s.g !== first) same = false;
    }
    return { canGroup: this.selection.size > 1 && !(same && first), canUngroup: any };
  }

  /** Group the selection, so a tap on any of its strokes selects them all. */
  groupSelection() {
    const list = this.selectedInOrder();
    if (list.length > 1) this.setGroup(list, randomId());
  }

  ungroupSelection() {
    const list = this.selectedInOrder().filter((s) => s.g);
    if (list.length) this.setGroup(list, undefined);
  }

  private setGroup(list: Stroke[], g: string | undefined) {
    this.flushStyle();
    const before = list.map(snapshot);
    for (const s of list) {
      if (g) s.g = g;
      else delete s.g;
    }
    this.pushUndo({ kind: 'upd', before, after: list.map(snapshot) });
    this.ev.update(list);
    this.emitSelection();
  }

  /** The strokes in s's group, in paint order; just s if it has none. */
  private groupOf(s: Stroke): Stroke[] {
    return s.g ? this.strokes.filter((t) => t.g === s.g) : [s];
  }

  /** Width of the first selected stroke in the units `width` uses, or null. */
  get selectionWidth(): number | null {
    for (const s of this.selection) return this.widthOnScreen ? s.w * this.view.z : s.w;
    return null;
  }

  /** A thickness from the toolbar as a stroke's world width. */
  private worldWidth(w: number) {
    return this.widthOnScreen ? Math.round((w / this.view.z) * 1e4) / 1e4 : w;
  }

  /**
   * Recolour and/or re-thicken everything selected. width is in the units
   * `width` uses. With `final` false (a slider mid-drag) the change is
   * only drawn; the last call with `final` true records undo and syncs it.
   */
  styleSelection(style: { c?: string; width?: number }, final = true) {
    const list = this.stylePending?.list ?? this.selectedInOrder();
    if (!list.length) return;
    if (!this.stylePending) this.stylePending = { list, before: list.map(snapshot) };
    for (const s of list) {
      if (style.c) s.c = style.c;
      if (style.width) s.w = this.worldWidth(style.width);
      s.path = null;
    }
    this.selBox = unionBox(this.selection);
    if (final) this.flushStyle();
    this.emitSelection();
    this.invalidate();
  }

  private flushStyle() {
    const p = this.stylePending;
    if (!p) return;
    this.stylePending = null;
    const live = p.list.filter((s) => this.byId.get(s.id) === s);
    if (!live.length) return;
    this.pushUndo({ kind: 'upd', before: p.before.filter((r) => this.byId.has(r.id)), after: live.map(snapshot) });
    this.ev.update(live);
  }

  private setSelection(list: Iterable<Stroke>) {
    this.flushStyle();
    const next = new Set(list);
    if (!next.size && !this.selection.size) return;
    this.selection = next;
    this.selBox = unionBox(next);
    this.emitSelection();
    this.requestFrame();
  }

  /** The selection box's corners on screen (TL, TR, BR, BL), following any drag in progress. */
  private selCorners(): [number, number][] | null {
    const b = this.selBox;
    if (!b || !this.selection.size) return null;
    const pad = 6 / this.view.z;
    const xf = this.xf ?? IDENTITY;
    const pts: [number, number][] = [
      [b.x0 - pad, b.y0 - pad],
      [b.x1 + pad, b.y0 - pad],
      [b.x1 + pad, b.y1 + pad],
      [b.x0 - pad, b.y1 + pad],
    ];
    return pts.map(([x, y]) => {
      const [wx, wy] = xfPoint(xf, x, y);
      return this.worldToScreen(wx, wy);
    });
  }

  private selScreenBox(): ScreenBox | null {
    const c = this.selCorners();
    if (!c) return null;
    const xs = c.map((p) => p[0]);
    const ys = c.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  private emitSelection() {
    const dragging = this.selDrag?.moved && this.selDrag.mode !== 'marquee';
    this.ev.selection(dragging ? null : this.selScreenBox(), this.selection.size);
  }

  // ---- view ----

  zoomAt(sx: number, sy: number, factor: number) {
    const v = this.view;
    const z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * factor));
    const wx = (sx - v.tx) / v.z;
    const wy = (sy - v.ty) / v.z;
    this.setView({ z, tx: sx - wx * z, ty: sy - wy * z });
  }

  zoomTo(z: number) {
    this.zoomAt(this.W / this.dpr / 2, this.H / this.dpr / 2, z / this.view.z);
  }

  setView(v: View) {
    this.view = v;
    this.ev.viewChanged(v);
    if (this.selection.size) this.emitSelection();
    this.requestFrame();
  }

  worldToScreen(x: number, y: number): [number, number] {
    return [x * this.view.z + this.view.tx, y * this.view.z + this.view.ty];
  }

  // ------------------------------------------------------------------
  // Store
  // ------------------------------------------------------------------

  private commit(s: Stroke) {
    s.path = null;
    this.strokes.push(s);
    this.byId.set(s.id, s);
    if (this.bufView && !this.staticDirty) {
      // Paint just this stroke into the existing buffer.
      const ctx = this.bctx;
      this.setViewTransform(ctx, this.bufView);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      this.paintStroke(ctx, s, this.bufView);
    }
  }

  private removeIds(ids: string[]): Stroke[] {
    const gone: Stroke[] = [];
    let selChanged = false;
    for (const id of ids) {
      const s = this.byId.get(id);
      if (s) {
        this.byId.delete(id);
        gone.push(s);
        if (this.selection.delete(s)) selChanged = true;
      }
    }
    if (gone.length) {
      const g = new Set(gone);
      this.strokes = this.strokes.filter((s) => !g.has(s));
    }
    if (selChanged) {
      if (this.hidden.size) this.cancelSelDrag();
      this.selBox = unionBox(this.selection);
      this.emitSelection();
    }
    return gone;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.dpr = dpr;
    this.W = Math.round(w * dpr);
    this.H = Math.round(h * dpr);
    for (const c of [this.canvas, this.buf, this.buf2]) {
      c.width = this.W;
      c.height = this.H;
    }
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.invalidate();
  }

  /** Throw away the buffer and re-render everything on the next frame. */
  invalidate() {
    this.staticDirty = true;
    this.requestFrame();
  }

  requestFrame() {
    if (!this.frameReq) this.frameReq = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.frameReq = 0;
    const v = this.view;
    const bv = this.bufView;
    if (this.staticDirty || !bv) {
      this.fullRender(v);
    } else if (!viewEq(bv, v)) {
      if (!this.gesturing || this.lastFullMs < FULL_RENDER_BUDGET_MS) this.fullRender(v);
      else if (bv.z === v.z) this.shiftRender(v);
      // else: zooming a heavy board; compose() scales the old buffer until it settles.
    }
    this.compose();
  };

  private setViewTransform(ctx: CanvasRenderingContext2D, v: View) {
    const d = this.dpr;
    ctx.setTransform(v.z * d, 0, 0, v.z * d, v.tx * d, v.ty * d);
  }

  private fullRender(v: View) {
    const t0 = performance.now();
    this.renderInto(this.bctx, v, 0, 0, this.W, this.H);
    this.bufView = { ...v };
    this.staticDirty = false;
    this.lastFullMs = performance.now() - t0;
  }

  /** Pan by whole device pixels: reuse the old pixels, render only the new strip. */
  private shiftRender(v: View) {
    const bv = this.bufView!;
    const dx = Math.round((v.tx - bv.tx) * this.dpr);
    const dy = Math.round((v.ty - bv.ty) * this.dpr);
    if (dx === 0 && dy === 0) return;
    if (Math.abs(dx) >= this.W || Math.abs(dy) >= this.H) {
      this.fullRender(v);
      return;
    }
    const nv: View = { z: bv.z, tx: bv.tx + dx / this.dpr, ty: bv.ty + dy / this.dpr };
    const c2 = this.b2ctx;
    c2.setTransform(1, 0, 0, 1, 0, 0);
    c2.drawImage(this.buf, dx, dy);
    if (dx > 0) this.renderInto(c2, nv, 0, 0, dx, this.H);
    if (dx < 0) this.renderInto(c2, nv, this.W + dx, 0, -dx, this.H);
    if (dy > 0) this.renderInto(c2, nv, 0, 0, this.W, dy);
    if (dy < 0) this.renderInto(c2, nv, 0, this.H + dy, this.W, -dy);
    [this.buf, this.buf2] = [this.buf2, this.buf];
    [this.bctx, this.b2ctx] = [this.b2ctx, this.bctx];
    this.bufView = nv;
  }

  /** Render committed strokes for view `v` into a device-pixel rectangle of ctx. */
  private renderInto(ctx: CanvasRenderingContext2D, v: View, x: number, y: number, w: number, h: number) {
    const full = x === 0 && y === 0 && w === this.W && h === this.H;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!full) {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
    }
    ctx.fillStyle = this.bg;
    ctx.fillRect(x, y, w, h);
    this.setViewTransform(ctx, v);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const d = this.dpr;
    const x0 = (x / d - v.tx) / v.z;
    const y0 = (y / d - v.ty) / v.z;
    const x1 = ((x + w) / d - v.tx) / v.z;
    const y1 = ((y + h) / d - v.ty) / v.z;
    // Strokes smaller than ~half a device pixel would be invisible anyway.
    const tiny = 0.5 / (v.z * d);
    const hidden = this.hidden.size ? this.hidden : null;
    for (const s of this.strokes) {
      const r = s.w / 2;
      if (s.maxX + r < x0 || s.minX - r > x1 || s.maxY + r < y0 || s.minY - r > y1) continue;
      if (s.maxX - s.minX + s.w < tiny && s.maxY - s.minY + s.w < tiny) continue;
      if (hidden && hidden.has(s)) continue;
      this.paintStroke(ctx, s, v);
    }
    ctx.restore();
  }

  private paintStroke(ctx: CanvasRenderingContext2D, s: Stroke, v: View) {
    const path = s.path ?? (s.path = buildPath(s));
    const col = this.dark ? darkColor(s.c) : s.c;
    const translucent = s.o !== undefined;
    if (translucent) {
      // Highlighter: multiply on light paper (ink underneath stays dark),
      // screen on dark paper (ink underneath stays light).
      // Translucent colour over near-black reads as mud, so dark mode lays
      // it on thicker: 35% becomes ~58%.
      ctx.globalAlpha = this.dark ? 1 - (1 - s.o!) ** 2 : s.o!;
      ctx.globalCompositeOperation = this.dark ? 'screen' : 'multiply';
    }
    if (s.dot) {
      ctx.fillStyle = col;
      ctx.fill(path);
    } else {
      ctx.strokeStyle = col;
      // Keep hairlines visible when zoomed far out.
      ctx.lineWidth = Math.max(s.w, 0.6 / (v.z * this.dpr));
      ctx.stroke(path);
    }
    if (translucent) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /** Buffer to screen, then live strokes, transformed selection and overlays on top. */
  private compose() {
    const ctx = this.ctx;
    const v = this.view;
    const bv = this.bufView!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (viewEq(bv, v)) {
      ctx.drawImage(this.buf, 0, 0);
    } else {
      const s = v.z / bv.z;
      let dx = (v.tx - bv.tx * s) * this.dpr;
      let dy = (v.ty - bv.ty * s) * this.dpr;
      if (s === 1) {
        dx = Math.round(dx);
        dy = Math.round(dy);
      }
      const w = this.W * s;
      const h = this.H * s;
      ctx.fillStyle = this.bg;
      // Only paint background where the buffer will not cover.
      if (dx > 0) ctx.fillRect(0, 0, dx, this.H);
      if (dx + w < this.W) ctx.fillRect(dx + w, 0, this.W - dx - w, this.H);
      if (dy > 0) ctx.fillRect(0, 0, this.W, dy);
      if (dy + h < this.H) ctx.fillRect(0, dy + h, this.W, this.H - dy - h);
      if (s === 1) ctx.drawImage(this.buf, dx, dy);
      else ctx.drawImage(this.buf, dx, dy, w, h);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (this.hidden.size) {
      this.setViewTransform(ctx, v);
      const xf = this.xf;
      if (xf) {
        const a = Math.cos(xf.r) * xf.s;
        const b = Math.sin(xf.r) * xf.s;
        ctx.transform(a, b, -b, a, xf.ox + xf.dx - (a * xf.ox - b * xf.oy), xf.oy + xf.dy - (b * xf.ox + a * xf.oy));
      }
      const vz: View = { ...v, z: v.z * (xf?.s ?? 1) };
      for (const s of this.hiddenList) this.paintStroke(ctx, s, vz);
    }
    if (this.live.size) {
      this.setViewTransform(ctx, v);
      for (const s of this.live.values()) {
        s.path = buildPath(s);
        this.paintStroke(ctx, s, v);
        s.path = null;
        s.drawn = Math.max(1, (s.p.length >> 1) - 1);
      }
    }
    this.drawOverlay(ctx);
  }

  private drawOverlay(ctx: CanvasRenderingContext2D) {
    const m = this.marquee;
    const c = this.selCorners();
    if (!m && !c) return;
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.accent;
    if (m) {
      const [x0, y0] = this.worldToScreen(m.x0, m.y0);
      const [x1, y1] = this.worldToScreen(m.x1, m.y1);
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = this.accent;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.globalAlpha = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }
    if (c) {
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(c[0][0], c[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(c[i][0], c[i][1]);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      // Rotate handle: a stalk out of the middle of the top edge.
      const [tx, ty, hx, hy] = this.rotateHandle(c);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.fillStyle = this.bg;
      ctx.beginPath();
      ctx.arc(hx, hy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Scale handles, drawn square to the box's current rotation.
      const r = this.xf?.r ?? 0;
      for (const [px, py] of c) {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(r);
        ctx.fillRect(-5, -5, 10, 10);
        ctx.strokeRect(-4.5, -4.5, 9, 9);
        ctx.restore();
      }
    }
  }

  /** [top-edge midpoint x, y, handle x, y] in screen px for the given corners. */
  private rotateHandle(c: [number, number][]): [number, number, number, number] {
    const tx = (c[0][0] + c[1][0]) / 2;
    const ty = (c[0][1] + c[1][1]) / 2;
    // Outward normal of the top edge (TL→TR), so the stalk turns with the box.
    let nx = c[1][1] - c[0][1];
    let ny = c[0][0] - c[1][0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    return [tx, ty, tx + nx * ROTATE_OFFSET, ty + ny * ROTATE_OFFSET];
  }

  /**
   * Draw the part of a live stroke that has not been drawn yet, straight onto
   * the screen canvas. Uses exactly the segments buildPath() would, minus the
   * final half-segment, which waits for the next sample.
   */
  private drawLiveIncrement(s: Stroke) {
    if (s.o !== undefined || s.k) {
      // Translucent or straight-edged: redrawn whole each frame instead.
      this.requestFrame();
      return;
    }
    const ctx = this.ctx;
    const p = s.p;
    const n = p.length >> 1;
    if (!n) return;
    this.setViewTransform(ctx, this.view);
    const col = this.dark ? darkColor(s.c) : s.c;
    const lw = Math.max(s.w, 0.6 / (this.view.z * this.dpr));
    if (s.drawn === 0) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(p[0], p[1], lw / 2, 0, Math.PI * 2);
      ctx.fill();
      s.drawn = 1;
    }
    if (n < 3 || s.drawn >= n - 1) return;
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let k = Math.max(2, s.drawn + 1);
    if (k === 2) ctx.moveTo(p[0], p[1]);
    else ctx.moveTo((p[2 * k - 4] + p[2 * k - 2]) / 2, (p[2 * k - 3] + p[2 * k - 1]) / 2);
    for (; k < n; k++) {
      const cx = p[2 * k - 2];
      const cy = p[2 * k - 1];
      ctx.quadraticCurveTo(cx, cy, (cx + p[2 * k]) / 2, (cy + p[2 * k + 1]) / 2);
    }
    ctx.stroke();
    s.drawn = n - 1;
  }

  // ------------------------------------------------------------------
  // Input
  // ------------------------------------------------------------------

  private on(el: HTMLElement | Window, type: string, fn: (e: any) => void, opts?: AddEventListenerOptions) {
    el.addEventListener(type, fn, opts);
    this.disposers.push(() => el.removeEventListener(type, fn, opts));
  }

  private bindInput() {
    const c = this.canvas;
    this.on(c, 'pointerdown', (e: PointerEvent) => this.onDown(e));
    this.on(c, 'pointermove', (e: PointerEvent) => this.onMove(e, false));
    if ('onpointerrawupdate' in window) this.on(c, 'pointerrawupdate', (e: PointerEvent) => this.onMove(e, true));
    this.on(c, 'pointerup', (e: PointerEvent) => this.onUp(e, false));
    this.on(c, 'pointercancel', (e: PointerEvent) => this.onUp(e, true));
    this.on(c, 'pointerleave', (e: PointerEvent) => {
      if (e.pointerType !== 'touch') {
        this.eraserDot.style.display = 'none';
        this.ev.cursor(null, 0);
      }
    });
    this.on(c, 'contextmenu', (e: Event) => e.preventDefault());
    this.on(c, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    this.on(window, 'resize', () => this.resize());
    this.on(window, 'keydown', (e: KeyboardEvent) => this.onKey(e, true));
    this.on(window, 'keyup', (e: KeyboardEvent) => this.onKey(e, false));
    this.on(window, 'blur', () => {
      this.spaceDown = false;
      this.shiftDown = false;
    });
  }

  private toWorld(cx: number, cy: number): [number, number] {
    const v = this.view;
    return [(cx - v.tx) / v.z, (cy - v.ty) / v.z];
  }

  private round(n: number) {
    // Precision follows zoom: ~0.1 screen px at the zoom it was drawn at.
    const dec = Math.min(6, Math.max(1, Math.ceil(Math.log10(this.view.z * 10))));
    const q = 10 ** dec;
    return Math.round(n * q) / q;
  }

  private busy() {
    return this.drawPointer >= 0 || this.erasePointer >= 0 || !!this.shape || !!this.selDrag || !!this.pan;
  }

  private onDown(e: PointerEvent) {
    e.preventDefault();
    if (e.pointerType === 'pen') this.lastPenAt = performance.now();

    if (e.pointerType === 'touch') {
      if ((this.busy() && this.activeType !== 'touch') || performance.now() - this.lastPenAt < PALM_MS) return;
      this.canvas.setPointerCapture(e.pointerId);
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
      if (this.touches.size === 1) this.tap = { start: performance.now(), max: 1, moved: false };
      this.tap.max = Math.max(this.tap.max, this.touches.size);
      if (this.touches.size === 1 && this.fingerDraw && this.tool !== 'hand') {
        this.startTool(e, this.tool === 'eraser');
      } else if (this.touches.size > 1) {
        // A second finger turns whatever one finger was doing into a pinch.
        this.cancelTouchAction();
      }
      this.gesturing = this.touches.size > 1 || !this.fingerDraw || this.tool === 'hand';
      return;
    }

    if (e.pointerType === 'pen' && this.touches.size) {
      // Pen wins over any hand resting on the screen.
      this.touches.clear();
      this.endGesture();
    }
    if (this.busy()) return;

    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || this.spaceDown)) {
      this.startPan(e);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const penEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
    this.startTool(e, penEraser || this.tool === 'eraser');
  }

  private startTool(e: PointerEvent, erase: boolean) {
    this.canvas.setPointerCapture(e.pointerId);
    this.activeType = e.pointerType;
    if (erase) {
      this.erasePointer = e.pointerId;
      this.erased = [];
      this.eraseLast = null;
      this.eraseAt(e.clientX, e.clientY);
      return;
    }
    switch (this.tool) {
      case 'hand':
        return this.startPan(e);
      case 'select':
        return this.startSelect(e);
      case 'shape':
        return this.startShape(e);
      default:
        return this.startStroke(e);
    }
  }

  private startStroke(e: PointerEvent) {
    const [x, y] = this.toWorld(e.clientX, e.clientY);
    const raw: RawStroke = { id: randomId(), c: this.color, w: this.worldWidth(this.width), p: [this.round(x), this.round(y)] };
    if (this.tool === 'highlighter' && this.opacity < 1) raw.o = this.opacity;
    const s = makeStroke(raw);
    this.own = s;
    this.drawPointer = e.pointerId;
    this.sawRaw = false;
    this.live.set(s.id, s);
    this.drawLiveIncrement(s);
    this.ev.begin(s);
  }

  private startShape(e: PointerEvent) {
    const [x, y] = this.toWorld(e.clientX, e.clientY);
    const s = makeStroke({ id: randomId(), c: this.color, w: this.worldWidth(this.width), p: [this.round(x), this.round(y)], k: 'l' });
    this.shape = { id: e.pointerId, ax: x, ay: y, s };
    this.live.set(s.id, s);
    this.requestFrame();
  }

  private moveShape(e: PointerEvent) {
    const sh = this.shape!;
    const [x, y] = this.toWorld(e.clientX, e.clientY);
    const pts = shapePoints(this.shapeKind, sh.ax, sh.ay, x, y, e.shiftKey || this.shiftDown, 4 / this.view.z);
    sh.s.p = pts.map((v) => this.round(v));
    resetBBox(sh.s);
    this.requestFrame();
  }

  private endShape(cancelled: boolean) {
    const sh = this.shape!;
    this.shape = null;
    this.live.delete(sh.s.id);
    const s = sh.s;
    const big = (s.maxX - s.minX) * this.view.z > 3 || (s.maxY - s.minY) * this.view.z > 3;
    if (!cancelled && big) {
      this.commit(s);
      this.ev.add([s]);
      this.pushUndo({ kind: 'add', strokes: [s] });
    }
    this.requestFrame();
  }

  private startPan(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    this.activeType = e.pointerType;
    this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.gesturing = true;
    this.canvas.style.cursor = 'grabbing';
  }

  // ---- select ----

  private hitTest(wx: number, wy: number, r: number): Stroke | null {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (sweepHits(s, wx, wy, wx, wy, r)) return s;
    }
    return null;
  }

  private startSelect(e: PointerEvent) {
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    const additive = e.shiftKey || this.shiftDown;
    const tol = e.pointerType === 'mouse' ? 10 : 18;
    const drag: SelDrag = {
      id: e.pointerId,
      mode: 'marquee',
      sx: wx,
      sy: wy,
      cx: e.clientX,
      cy: e.clientY,
      anchor: [0, 0],
      corner: [0, 0],
      moved: false,
      additive,
      slop: e.pointerType === 'mouse' ? 3 : 6,
      tapHit: null,
    };
    // Double tap: select just the stroke under the pen, even inside a group.
    const tap = this.lastTap;
    this.lastTap = null;
    if (!additive && tap && performance.now() - tap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) <= tol) {
      const hit = this.hitTest(wx, wy, tol / this.view.z);
      if (hit) {
        this.setSelection([hit]);
        drag.mode = 'move';
        this.selDrag = drag;
        return;
      }
    }
    const sb = this.selScreenBox();
    const corners = this.selCorners();
    const b = this.selBox;
    if (sb && corners && b && !additive) {
      const [, , hx, hy] = this.rotateHandle(corners);
      if (Math.hypot(e.clientX - hx, e.clientY - hy) <= tol) {
        drag.mode = 'rotate';
        drag.anchor = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
        this.selDrag = drag;
        return;
      }
      const pad = 6 / this.view.z;
      // Same order as selCorners(): TL, TR, BR, BL; the opposite corner is i+2.
      const world: [number, number][] = [
        [b.x0 - pad, b.y0 - pad],
        [b.x1 + pad, b.y0 - pad],
        [b.x1 + pad, b.y1 + pad],
        [b.x0 - pad, b.y1 + pad],
      ];
      for (let i = 0; i < 4; i++) {
        if (Math.hypot(e.clientX - corners[i][0], e.clientY - corners[i][1]) <= tol) {
          drag.mode = 'scale';
          drag.corner = world[i];
          drag.anchor = world[(i + 2) % 4];
          this.selDrag = drag;
          return;
        }
      }
      if (e.clientX >= sb.x && e.clientX <= sb.x + sb.w && e.clientY >= sb.y && e.clientY <= sb.y + sb.h) {
        drag.mode = 'move';
        const hit = this.hitTest(wx, wy, tol / this.view.z);
        if (hit && !this.selection.has(hit)) drag.tapHit = hit;
        this.selDrag = drag;
        return;
      }
    }
    const hit = this.hitTest(wx, wy, tol / this.view.z);
    if (hit) {
      // A tap takes the stroke's whole group.
      const group = this.groupOf(hit);
      if (additive) {
        const next = new Set(this.selection);
        const all = group.every((s) => next.has(s));
        for (const s of group) {
          if (all) next.delete(s);
          else next.add(s);
        }
        this.setSelection(next);
      } else if (!this.selection.has(hit)) this.setSelection(group);
      if (this.selection.has(hit)) {
        drag.mode = 'move';
        this.selDrag = drag;
      }
      return;
    }
    if (!additive) this.setSelection([]);
    this.selDrag = drag;
  }

  private moveSelect(e: PointerEvent) {
    const d = this.selDrag!;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < d.slop) return;
      d.moved = true;
      if (d.mode !== 'marquee') {
        this.hiddenList = this.selectedInOrder();
        this.hidden = new Set(this.hiddenList);
        this.xf = { ...IDENTITY };
        this.emitSelection();
        this.invalidate();
      }
    }
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    if (d.mode === 'marquee') {
      this.marquee = { x0: Math.min(d.sx, wx), y0: Math.min(d.sy, wy), x1: Math.max(d.sx, wx), y1: Math.max(d.sy, wy) };
    } else if (d.mode === 'move') {
      this.xf = { ...IDENTITY, dx: wx - d.sx, dy: wy - d.sy };
    } else if (d.mode === 'rotate') {
      const [ax, ay] = d.anchor;
      let r = Math.atan2(wy - ay, wx - ax) - Math.atan2(d.sy - ay, d.sx - ax);
      const step = Math.PI / 12;
      if (e.shiftKey || this.shiftDown) r = Math.round(r / step) * step;
      else {
        // Light snap to the right angles, which are what you usually want.
        const q = Math.round(r / (Math.PI / 2)) * (Math.PI / 2);
        if (Math.abs(r - q) < 0.06) r = q;
      }
      this.xf = { ...IDENTITY, r, ox: ax, oy: ay };
    } else {
      const [ax, ay] = d.anchor;
      const vx = d.corner[0] - ax;
      const vy = d.corner[1] - ay;
      const len = vx * vx + vy * vy || 1;
      const s = Math.max(0.02, ((wx - ax) * vx + (wy - ay) * vy) / len);
      this.xf = { ...IDENTITY, s, ox: ax, oy: ay };
    }
    this.requestFrame();
  }

  private endSelect(cancelled: boolean) {
    const d = this.selDrag!;
    this.selDrag = null;
    if (d.mode === 'marquee') {
      const box = this.marquee;
      this.marquee = null;
      if (box && d.moved && !cancelled) {
        // A grouped stroke only counts if its whole group is inside too.
        const inside = new Set<Stroke>();
        const short = new Set<string>();
        for (const s of this.strokes) {
          if (strokeInsideBox(s, box)) inside.add(s);
          else if (s.g) short.add(s.g);
        }
        const found = [...inside].filter((s) => !s.g || !short.has(s.g));
        this.setSelection(d.additive ? [...this.selection, ...found] : found);
      }
      if (!d.moved) this.lastTap = { t: performance.now(), x: d.cx, y: d.cy };
      this.requestFrame();
      this.emitSelection();
      return;
    }
    if (!d.moved) {
      if (cancelled) return;
      this.lastTap = { t: performance.now(), x: d.cx, y: d.cy };
      if (d.tapHit && this.byId.get(d.tapHit.id) === d.tapHit) this.setSelection(this.groupOf(d.tapHit));
      return;
    }
    const xf = this.xf!;
    const list = this.hiddenList;
    this.xf = null;
    this.hidden = new Set();
    this.hiddenList = [];
    if (!cancelled && (xf.s !== 1 || xf.r !== 0 || xf.dx !== 0 || xf.dy !== 0)) {
      const before = list.map(snapshot);
      for (const s of list) {
        const p = s.p;
        for (let i = 0; i < p.length; i += 2) {
          const [x, y] = xfPoint(xf, p[i], p[i + 1]);
          p[i] = this.round(x);
          p[i + 1] = this.round(y);
        }
        if (xf.s !== 1) s.w = Math.round(s.w * xf.s * 1e4) / 1e4;
        resetBBox(s);
      }
      this.pushUndo({ kind: 'upd', before, after: list.map(snapshot) });
      this.ev.update(list);
      this.selBox = unionBox(this.selection);
    }
    this.emitSelection();
    this.invalidate();
  }

  /** Drop an in-progress move/scale/marquee without applying it. */
  private cancelSelDrag() {
    if (!this.selDrag) return;
    this.selDrag = null;
    this.marquee = null;
    if (this.hidden.size) {
      this.xf = null;
      this.hidden = new Set();
      this.hiddenList = [];
      this.invalidate();
    }
    this.requestFrame();
  }

  private cancelTouchAction() {
    if (this.activeType !== 'touch') return;
    if (this.drawPointer >= 0) this.abortOwnStroke();
    if (this.erasePointer >= 0) this.finishErase();
    if (this.shape) this.endShape(true);
    if (this.selDrag) this.cancelSelDrag();
  }

  // ---- move / up ----

  private onMove(e: PointerEvent, raw: boolean) {
    if (e.pointerType === 'pen') this.lastPenAt = performance.now();

    if (e.pointerId === this.drawPointer && this.own) {
      if (raw) this.sawRaw = true;
      else if (this.sawRaw) return;
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      const evs = list.length ? list : [e];
      const s = this.own;
      const before = s.p.length;
      for (const ce of evs) this.addSample(s, ce.clientX, ce.clientY);
      if (s.p.length > before) {
        growBBox(s, before);
        this.drawLiveIncrement(s);
        this.ev.points(s.id, s.p.slice(before));
      }
      this.sendCursor(e);
      return;
    }
    if (raw) return;

    if (e.pointerId === this.erasePointer) {
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ce of list.length ? list : [e]) this.eraseAt(ce.clientX, ce.clientY);
      this.moveEraserDot(e);
      this.sendCursor(e);
      return;
    }

    if (this.shape && e.pointerId === this.shape.id) {
      this.moveShape(e);
      this.sendCursor(e);
      return;
    }

    if (this.selDrag && e.pointerId === this.selDrag.id) {
      this.moveSelect(e);
      this.sendCursor(e);
      return;
    }

    if (this.pan && e.pointerId === this.pan.id) {
      const dx = e.clientX - this.pan.x;
      const dy = e.clientY - this.pan.y;
      this.pan.x = e.clientX;
      this.pan.y = e.clientY;
      this.setView({ ...this.view, tx: this.view.tx + dx, ty: this.view.ty + dy });
      return;
    }

    const t = this.touches.get(e.pointerId);
    if (t) {
      if (Math.hypot(e.clientX - t.sx, e.clientY - t.sy) > 12) this.tap.moved = true;
      if (this.busy()) {
        t.x = e.clientX;
        t.y = e.clientY;
        return;
      }
      this.touchGesture(e.pointerId, e.clientX, e.clientY);
      return;
    }

    if (e.pointerType !== 'touch' && e.buttons === 0) {
      if (this.tool === 'eraser') this.moveEraserDot(e);
      this.sendCursor(e);
    }
  }

  private addSample(s: Stroke, cx: number, cy: number) {
    const p = s.p;
    const [wx, wy] = this.toWorld(cx, cy);
    const lx = p[p.length - 2];
    const ly = p[p.length - 1];
    const minD = MIN_SAMPLE_DIST / this.view.z;
    if (Math.abs(wx - lx) < minD && Math.abs(wy - ly) < minD) return;
    p.push(this.round(wx), this.round(wy));
  }

  private touchGesture(id: number, x: number, y: number) {
    const t = this.touches.get(id)!;
    const pts = [...this.touches.values()];
    const cx0 = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy0 = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const d0 = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    t.x = x;
    t.y = y;
    const pts1 = [...this.touches.values()];
    const cx1 = pts1.reduce((a, p) => a + p.x, 0) / pts1.length;
    const cy1 = pts1.reduce((a, p) => a + p.y, 0) / pts1.length;
    const v = this.view;
    let z = v.z;
    if (pts1.length > 1 && d0 > 0) {
      const d1 = Math.hypot(pts1[0].x - pts1[1].x, pts1[0].y - pts1[1].y);
      z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * (d1 / d0)));
    }
    const wx = (cx0 - v.tx) / v.z;
    const wy = (cy0 - v.ty) / v.z;
    this.setView({ z, tx: cx1 - wx * z, ty: cy1 - wy * z });
  }

  private onUp(e: PointerEvent, cancelled: boolean) {
    if (e.pointerId === this.drawPointer && this.own) {
      const s = this.own;
      if (!cancelled) {
        const before = s.p.length;
        this.addSample(s, e.clientX, e.clientY);
        if (s.p.length > before) {
          growBBox(s, before);
          this.ev.points(s.id, s.p.slice(before));
        }
      }
      this.own = null;
      this.drawPointer = -1;
      this.live.delete(s.id);
      s.drawn = 0;
      this.commit(s);
      this.pushUndo({ kind: 'add', strokes: [s] });
      this.ev.end(s);
      this.requestFrame();
    } else if (e.pointerId === this.erasePointer) {
      this.finishErase();
    } else if (this.shape && e.pointerId === this.shape.id) {
      this.endShape(cancelled);
    } else if (this.selDrag && e.pointerId === this.selDrag.id) {
      this.endSelect(cancelled);
    } else if (this.pan && e.pointerId === this.pan.id) {
      this.pan = null;
      this.canvas.style.cursor = '';
      this.endGesture();
    }

    if (this.touches.delete(e.pointerId) && this.touches.size === 0) {
      const quick = performance.now() - this.tap.start < 320;
      if (!cancelled && quick && !this.tap.moved) {
        if (this.tap.max === 2) this.undo();
        else if (this.tap.max === 3) this.redo();
      }
      this.endGesture();
    }
  }

  private abortOwnStroke() {
    const s = this.own;
    if (!s) return;
    this.own = null;
    this.drawPointer = -1;
    this.live.delete(s.id);
    // The server already has the start of it; finish it there and remove it.
    this.ev.end(s);
    this.ev.erase([s.id]);
    this.requestFrame();
  }

  private endGesture() {
    this.gesturing = false;
    // Re-render crisply now that the view has stopped moving.
    this.requestFrame();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const pinch = e.ctrlKey || e.metaKey;
    // A mouse wheel notch is a large or line-mode delta; trackpads scroll in
    // small pixel deltas, which pan instead.
    const notch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50;
    if (pinch || notch) {
      const k = pinch ? 0.01 : e.deltaMode === 1 ? 0.05 : 0.0015;
      this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k));
    } else {
      this.setView({ ...this.view, tx: this.view.tx - e.deltaX, ty: this.view.ty - e.deltaY });
    }
    this.gesturing = true;
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.endGesture(), 140);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const target = e.target as HTMLElement | null;
    // Text fields keep their keys; a slider or colour picker left focused doesn't.
    const typing = target?.tagName === 'TEXTAREA' || (target?.tagName === 'INPUT' && !['range', 'color'].includes((target as HTMLInputElement).type));
    if (typing) return;
    if (e.key === 'Shift') this.shiftDown = down;
    if (e.code === 'Space') {
      this.spaceDown = down;
      this.canvas.style.cursor = down ? 'grab' : '';
      e.preventDefault();
      return;
    }
    if (!down) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      this.redo();
    } else if (mod && k === 'd') {
      e.preventDefault();
      this.duplicateSelection();
    } else if (mod && k === 'a') {
      e.preventDefault();
      this.selectAll();
    } else if (mod && k === 'g') {
      e.preventDefault();
      const g = this.selectionGroupState;
      if (e.shiftKey || !g.canGroup) this.ungroupSelection();
      else this.groupSelection();
    } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
      this.deleteSelection();
    } else if (e.key === 'Escape') this.clearSelection();
    else if (mod) return;
    else if (k === 'v') this.setTool('select');
    else if (k === 'p') this.setTool('pen');
    else if (k === 'm') this.setTool('highlighter');
    else if (k === 's') this.setTool('shape');
    else if (k === 'e') this.setTool('eraser');
    else if (k === 'h') this.setTool('hand');
    else if (k === '0') this.zoomTo(1);
    else if (k === '=' || k === '+') this.zoomTo(this.view.z * 1.25);
    else if (k === '-') this.zoomTo(this.view.z / 1.25);
  }

  private sendCursor(e: PointerEvent) {
    const now = performance.now();
    if (now - this.lastCursorSent < 45) return;
    this.lastCursorSent = now;
    const [x, y] = this.toWorld(e.clientX, e.clientY);
    this.ev.cursor(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
  }

  private moveEraserDot(e: PointerEvent) {
    const d = this.eraserDot;
    d.style.display = 'block';
    d.style.transform = `translate(${e.clientX - ERASER_RADIUS}px, ${e.clientY - ERASER_RADIUS}px)`;
  }

  private eraseAt(cx: number, cy: number) {
    const [x, y] = this.toWorld(cx, cy);
    const r = ERASER_RADIUS / this.view.z;
    // Sweep from the previous position so fast strokes do not skip lines.
    const last = this.eraseLast ?? [x, y];
    this.eraseLast = [x, y];
    const hits: string[] = [];
    for (const s of this.strokes) if (sweepHits(s, last[0], last[1], x, y, r)) hits.push(s.id);
    if (hits.length) {
      const gone = this.removeIds(hits);
      this.erased.push(...gone);
      this.ev.erase(hits);
      this.invalidate();
    }
  }

  private finishErase() {
    if (this.erased.length) this.pushUndo({ kind: 'del', strokes: this.erased });
    this.erased = [];
    this.erasePointer = -1;
    this.eraseLast = null;
  }

  private pushUndo(a: Action) {
    this.undoStack.push(a);
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
  }
}

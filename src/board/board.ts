import { api } from '../api';
import { navigate } from '../router';
import { isDark, onThemeChange, toggleTheme } from '../theme';
import { Engine, type ScreenBox, type ShapeKind, type Stroke, type Tool, type View } from './engine';
import { toRaw } from './strokes';
import { Sync } from './sync';

const COLORS = ['#1a1a1a', '#5c5f66', '#e03131', '#f08c00', '#fab005', '#2f9e44', '#1971c2', '#7048e8', '#e64980'];
/**
 * Thickness slider ranges in canvas units (px at 100% zoom). The slider is
 * squared so thin sizes get most of its travel.
 */
const PEN_RANGE: [number, number] = [0.2, 30];
const HL_RANGE: [number, number] = [4, 60];
const SLIDER_MAX = 1000;
const PREFS_KEY = 'mero.prefs';

const svg = (d: string) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const ICON = {
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  select: svg('<path d="M5 3l14 8-6 1.5L10 19z"/>'),
  pen: svg('<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/>'),
  highlighter: svg('<path d="M14 4l6 6-8 8H8v-4z M8 14l-4 6h6"/>'),
  eraser: svg('<path d="M8 20h12M5 15l9-9 5 5-8 8H8l-3-3a1.4 1.4 0 010-1z"/>'),
  hand: svg(
    '<path d="M8 13V6a1.5 1.5 0 013 0v5V4.5a1.5 1.5 0 013 0V11V6a1.5 1.5 0 013 0v8a6 6 0 01-6 6h-1a6 6 0 01-5-3l-2.5-4a1.5 1.5 0 012.5-1.6z"/>',
  ),
  undo: svg('<path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3"/>'),
  finger: svg(
    '<path d="M10 12V5a1.5 1.5 0 013 0v6l4 1a2 2 0 011.5 2.3L17.6 19a2 2 0 01-2 1.6H11a2 2 0 01-1.6-.8L6 15a1.5 1.5 0 012.2-2z"/>',
  ),
  sun: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  ),
  pin: svg('<path d="M9 3h6l-1 6 3 3.5H7L10 9z M12 12.5V21"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 119.5 4a6.5 6.5 0 0010.5 10.5z"/>'),
  duplicate: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>'),
  group: svg('<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/><rect x="7" y="7" width="6" height="6" rx="1"/><rect x="11" y="11" width="6" height="6" rx="1"/>'),
  ungroup: svg('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};
const SHAPES: { kind: ShapeKind; label: string; icon: string }[] = [
  { kind: 'rect', label: 'Rectangle', icon: svg('<rect x="3" y="6" width="18" height="12" rx="1"/>') },
  { kind: 'square', label: 'Square', icon: svg('<rect x="5" y="5" width="14" height="14" rx="1"/>') },
  { kind: 'ellipse', label: 'Ellipse', icon: svg('<ellipse cx="12" cy="12" rx="9" ry="6"/>') },
  { kind: 'circle', label: 'Circle', icon: svg('<circle cx="12" cy="12" r="8"/>') },
  { kind: 'triangle', label: 'Triangle', icon: svg('<path d="M12 4l9 16H3z"/>') },
  { kind: 'hexagon', label: 'Hexagon', icon: svg('<path d="M21 12l-4.5 7.8h-9L3 12l4.5-7.8h9z"/>') },
];

interface Prefs {
  tool: Tool;
  pen: { color: string; width: number };
  hl: { color: string; width: number; opacity: number };
  shape: ShapeKind;
  fingerDraw: boolean;
  /** Thickness stays the same on screen at any zoom, instead of scaling with the board. */
  fixedWidth: boolean;
}

function loadPrefs(): Prefs {
  const d: Prefs = {
    tool: 'pen',
    pen: { color: COLORS[0], width: 2 },
    hl: { color: '#fab005', width: 22, opacity: 0.35 },
    shape: 'rect',
    fixedWidth: false,
    fingerDraw: !matchMedia('(pointer: fine)').matches && navigator.maxTouchPoints > 0 && screen.width < 700,
  };
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return { ...d, ...p, pen: { ...d.pen, ...p.pen }, hl: { ...d.hl, ...p.hl } };
  } catch {
    return d;
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

/** Tenths below 1, halves below 10, whole numbers above. */
function roundWidth(w: number) {
  return w < 1 ? Math.round(w * 10) / 10 : w < 10 ? Math.round(w * 2) / 2 : Math.round(w);
}

function sliderToWidth(t: number, [lo, hi]: [number, number]) {
  return roundWidth(lo + (hi - lo) * (t / SLIDER_MAX) ** 2);
}

function widthToSlider(w: number, [lo, hi]: [number, number]) {
  return Math.round(Math.sqrt(Math.min(1, Math.max(0, (w - lo) / (hi - lo)))) * SLIDER_MAX);
}

function fmtWidth(w: number) {
  return roundWidth(w) + ' px';
}

function peerColor(cid: number) {
  return `hsl(${(cid * 137) % 360} 70% 45%)`;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

type OutOp = { t: 'r'; s: Stroke[] } | { t: 'u'; s: Stroke[] } | { t: 'd'; ids: string[] };

export function mountBoard(root: HTMLElement, boardId: string): () => void {
  const toolBtn = (t: Tool, title: string, icon: string) => `<button class="ib" data-tool="${t}" title="${title}">${icon}</button>`;
  root.innerHTML = `
    <div class="board">
      <div class="stage"></div>
      <div class="cursors"></div>
      <div class="bar bar-left">
        <button class="ib" data-act="back" title="Boards">${ICON.back}</button>
        <button class="title" data-act="rename" title="Rename">…</button>
      </div>
      <div class="bar bar-side">
        ${toolBtn('select', 'Select (V)', ICON.select)}
        ${toolBtn('pen', 'Pen (P)', ICON.pen)}
        ${toolBtn('highlighter', 'Highlighter (M)', ICON.highlighter)}
        <button class="ib" data-tool="shape" title="Shapes (S)"></button>
        ${toolBtn('eraser', 'Eraser (E)', ICON.eraser)}
        ${toolBtn('hand', 'Pan (H, or hold Space)', ICON.hand)}
        <div class="sep"></div>
        <button class="ib" data-act="undo" title="Undo (Ctrl+Z, two-finger tap)">${ICON.undo}</button>
        <button class="ib" data-act="redo" title="Redo (Ctrl+Shift+Z, three-finger tap)">${ICON.redo}</button>
      </div>
      <div class="bar shape-menu" hidden>
        ${SHAPES.map((s) => `<button class="ib" data-shape="${s.kind}" title="${s.label}">${s.icon}</button>`).join('')}
      </div>
      <div class="bar bar-props">
        <div class="grp colors"></div>
        <div class="grp slider">
          <span class="dot"><i></i></span>
          <input type="range" min="0" max="${SLIDER_MAX}" data-slider="width" aria-label="Thickness" title="Thickness" />
          <span class="val"></span>
          <button class="ib" data-act="width-mode">${ICON.pin}</button>
        </div>
        <div class="grp slider opacity">
          <input type="range" min="5" max="95" step="5" data-slider="opacity" aria-label="Opacity" title="Opacity" />
          <span class="val"></span>
        </div>
      </div>
      <div class="bar bar-right">
        <button class="ib" data-act="finger" title="Draw with finger">${ICON.finger}</button>
        <button class="ib" data-act="theme" title="Dark mode"></button>
        <button class="zoom" data-act="zoom" title="Reset zoom (0)">100%</button>
        <div class="peers"></div>
        <div class="status"><i></i><span></span></div>
      </div>
      <div class="bar selbar" hidden>
        <button data-act="group" title="Group (Ctrl+G)">${ICON.group}<span>Group</span></button>
        <button data-act="ungroup" title="Ungroup (Ctrl+Shift+G)">${ICON.ungroup}<span>Ungroup</span></button>
        <button data-act="duplicate" title="Duplicate (Ctrl+D)">${ICON.duplicate}<span>Duplicate</span></button>
        <button data-act="delete" title="Delete (Del)">${ICON.trash}<span>Delete</span></button>
      </div>
      <div class="banner" hidden></div>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const boardEl = $('.board');
  const stage = $('.stage');
  const cursorLayer = $('.cursors');
  const titleBtn = $<HTMLButtonElement>('.title');
  const zoomBtn = $<HTMLButtonElement>('.zoom');
  const statusDot = $('.status i');
  const statusText = $('.status span');
  const peersEl = $('.peers');
  const banner = $('.banner');
  const shapeMenu = $('.shape-menu');
  const propsBar = $('.bar-props');
  const selbar = $('.selbar');
  const groupBtn = $('[data-act="group"]');
  const ungroupBtn = $('[data-act="ungroup"]');
  const widthIn = $<HTMLInputElement>('[data-slider="width"]');
  const widthVal = widthIn.nextElementSibling as HTMLElement;
  const widthDot = $('.slider .dot i');
  const widthModeBtn = $('[data-act="width-mode"]');
  const opacityGrp = $('.slider.opacity');
  const opacityIn = $<HTMLInputElement>('[data-slider="opacity"]');
  const opacityVal = opacityIn.nextElementSibling as HTMLElement;
  /** The slider being dragged, so selection updates don't fight its thumb. */
  let sliding: HTMLInputElement | null = null;

  const prefs = loadPrefs();
  const viewKey = `mero.view.${boardId}`;

  // ---- remote cursors ---------------------------------------------------
  const peers = new Map<number, string>();
  const cursors = new Map<number, { el: HTMLDivElement; x: number; y: number; at: number }>();

  function placeCursor(c: { el: HTMLDivElement; x: number; y: number }) {
    const [sx, sy] = engine.worldToScreen(c.x, c.y);
    c.el.style.transform = `translate(${sx}px, ${sy}px)`;
  }

  function renderPeers() {
    peersEl.innerHTML = [...peers]
      .map(
        ([cid, name]) =>
          `<span class="peer" style="--c:${peerColor(cid)}" title="${esc(name)}">${esc(name.slice(0, 1).toUpperCase())}</span>`,
      )
      .join('');
  }

  // ---- outbox for anything done while the socket was down ---------------
  const offlineIds = new Set<string>();
  let outbox: OutOp[] = [];

  function sendOrQueue(op: OutOp) {
    const msg = op.t === 'd' ? op : { t: op.t, s: op.s.map(toRaw) };
    if (!sync.send(msg)) outbox.push(op);
  }

  function placeSelbar(box: ScreenBox | null) {
    if (!box) {
      selbar.hidden = true;
      return;
    }
    selbar.hidden = false;
    const g = engine.selectionGroupState;
    groupBtn.hidden = !g.canGroup;
    ungroupBtn.hidden = !g.canUngroup;
    const w = selbar.offsetWidth;
    const h = selbar.offsetHeight;
    let x = box.x + box.w / 2 - w / 2;
    // Below the box: the rotate handle sits above it.
    let y = box.y + box.h + 12;
    if (y + h > window.innerHeight - 8) y = box.y - h - 44;
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
    selbar.style.transform = `translate(${x}px, ${y}px)`;
  }

  let saveViewTimer = 0;
  const engine = new Engine(stage, {
    begin(s) {
      if (!sync.send({ t: 'b', ...toRaw(s) })) offlineIds.add(s.id);
    },
    points(id, pts) {
      if (!offlineIds.has(id)) sync.points(id, pts);
    },
    end(s) {
      if (offlineIds.delete(s.id) || !sync.send({ t: 'e', id: s.id })) outbox.push({ t: 'r', s: [s] });
    },
    add(strokes) {
      sendOrQueue({ t: 'r', s: strokes });
    },
    update(strokes) {
      sendOrQueue({ t: 'u', s: strokes });
    },
    erase(ids) {
      sendOrQueue({ t: 'd', ids });
    },
    cursor(x, y) {
      if (sync.open) sync.send(x === null ? { t: 'm' } : { t: 'm', x, y });
    },
    viewChanged(v: View) {
      zoomBtn.textContent = Math.round(v.z * 100) + '%';
      renderSliders();
      for (const c of cursors.values()) placeCursor(c);
      clearTimeout(saveViewTimer);
      saveViewTimer = window.setTimeout(() => {
        try {
          localStorage.setItem(viewKey, JSON.stringify(v));
        } catch {
          /* ignore */
        }
      }, 300);
    },
    toolChanged(t: Tool) {
      root.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
      stage.dataset.active = t;
      if (prefs.tool !== t) {
        prefs.tool = t;
        savePrefs(prefs);
      }
      renderProps();
    },
    selection(box) {
      placeSelbar(box);
      renderSliders();
    },
  });
  engine.setDark(isDark());
  // Dev builds only: lets a browser test reach the engine.
  if (import.meta.env.DEV) (window as any).__mero = engine;

  try {
    const v = JSON.parse(localStorage.getItem(viewKey) || 'null');
    if (v && isFinite(v.tx) && isFinite(v.ty) && v.z > 0) engine.setView(v);
    else engine.setView({ tx: stage.clientWidth / 2, ty: stage.clientHeight / 2, z: 1 });
  } catch {
    engine.setView({ tx: stage.clientWidth / 2, ty: stage.clientHeight / 2, z: 1 });
  }

  // ---- style bar ----------------------------------------------------------

  /** Pen style is shared by the pen, shapes and restyling a selection. */
  function style() {
    return engine.tool === 'highlighter' ? prefs.hl : prefs.pen;
  }

  function renderProps() {
    const t = engine.tool;
    propsBar.hidden = t === 'eraser' || t === 'hand';
    const st = style();
    const sel = t === 'select';
    const custom = !COLORS.includes(st.color);
    $('.colors').innerHTML =
      COLORS.map(
        (c) =>
          `<button class="sw${!sel && c === st.color ? ' on' : ''}" data-color="${c}" title="${c}" style="--c:${engine.displayColor(c)}"></button>`,
      ).join('') +
      `<label class="sw custom${!sel && custom ? ' on' : ''}" title="Custom colour" style="--c:${
        custom ? engine.displayColor(st.color) : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)'
      }"><input type="color" value="${custom ? st.color : '#000000'}" /></label>`;
    $('[data-tool="shape"]').innerHTML = SHAPES.find((s) => s.kind === prefs.shape)!.icon;
    root.querySelectorAll<HTMLElement>('[data-shape]').forEach((b) => b.classList.toggle('on', b.dataset.shape === prefs.shape));
    $('[data-act="finger"]').classList.toggle('on', prefs.fingerDraw);
    $('[data-act="theme"]').innerHTML = isDark() ? ICON.sun : ICON.moon;

    const hl = t === 'highlighter';
    engine.color = st.color;
    engine.width = st.width;
    engine.widthOnScreen = prefs.fixedWidth;
    engine.opacity = hl ? prefs.hl.opacity : 1;
    renderSliders();
  }

  /** Slider positions, labels and the preview dot. In select mode they show the selection's width. */
  function renderSliders() {
    const hl = engine.tool === 'highlighter';
    const st = style();
    const selW = engine.tool === 'select' ? engine.selectionWidth : null;
    const w = selW ?? st.width;
    if (!sliding) widthIn.value = String(widthToSlider(w, hl ? HL_RANGE : PEN_RANGE));
    widthVal.textContent = fmtWidth(w);
    // The dot shows the ink as it will look on screen at the current zoom.
    const d = Math.max(1.5, Math.min(24, prefs.fixedWidth ? w : w * engine.view.z));
    widthModeBtn.classList.toggle('on', prefs.fixedWidth);
    widthModeBtn.title = prefs.fixedWidth
      ? 'Thickness is fixed on screen, whatever the zoom. Tap to make it scale with zoom.'
      : 'Thickness scales with zoom. Tap to keep it fixed on screen.';
    widthDot.style.cssText = `width:${d}px;height:${d}px;background:${engine.displayColor(st.color)};opacity:${hl ? prefs.hl.opacity : 1}`;
    opacityGrp.hidden = !hl;
    if (!sliding) opacityIn.value = String(Math.round(prefs.hl.opacity * 100));
    opacityVal.textContent = Math.round(prefs.hl.opacity * 100) + '%';
    engine.shapeKind = prefs.shape;
    engine.fingerDraw = prefs.fingerDraw;
  }

  function pickColor(c: string) {
    if (engine.tool === 'select' && engine.selectionCount) {
      engine.styleSelection({ c });
      return;
    }
    if (engine.tool === 'select') engine.setTool('pen');
    style().color = c;
    savePrefs(prefs);
    renderProps();
  }

  /** A thickness slider move. `final` is the release, which is when a selection restyle is recorded and synced. */
  function slideWidth(final: boolean) {
    const w = sliderToWidth(Number(widthIn.value), engine.tool === 'highlighter' ? HL_RANGE : PEN_RANGE);
    if (engine.tool === 'select' && engine.selectionCount) {
      engine.styleSelection({ width: w }, final);
    } else {
      style().width = w;
      engine.width = w;
      if (final) savePrefs(prefs);
    }
    renderSliders();
  }

  function slideOpacity(final: boolean) {
    prefs.hl.opacity = Number(opacityIn.value) / 100;
    engine.opacity = prefs.hl.opacity;
    if (final) savePrefs(prefs);
    renderSliders();
  }

  engine.setTool(prefs.tool);

  // ---- socket -------------------------------------------------------------
  const sync = new Sync(boardId, {
    init(m) {
      engine.load(m.strokes, m.live);
      peers.clear();
      for (const p of m.peers) peers.set(p.cid, p.name);
      renderPeers();
      const ops = outbox;
      outbox = [];
      for (const op of ops) {
        if (op.t === 'r') engine.addLocal(op.s);
        else if (op.t === 'u') engine.remoteUpdate(op.s.map(toRaw));
        else engine.remoteDelete(op.ids);
        sendOrQueue(op);
      }
    },
    begin: (s) => engine.remoteBegin(s),
    append: (id, p) => engine.remoteAppend(id, p),
    end: (id) => engine.remoteEnd(id),
    del: (ids) => engine.remoteDelete(ids),
    add: (s) => engine.remoteAdd(s),
    update: (s) => engine.remoteUpdate(s),
    cursor(cid, x, y) {
      let c = cursors.get(cid);
      if (x === undefined || y === undefined) {
        c?.el.remove();
        cursors.delete(cid);
        return;
      }
      if (!c) {
        const el = document.createElement('div');
        el.className = 'cursor';
        el.style.setProperty('--c', peerColor(cid));
        el.innerHTML = `<i></i><span></span>`;
        el.querySelector('span')!.textContent = peers.get(cid) || '';
        cursorLayer.appendChild(el);
        c = { el, x, y, at: 0 };
        cursors.set(cid, c);
      }
      c.x = x;
      c.y = y;
      c.at = performance.now();
      placeCursor(c);
    },
    join(cid, name) {
      peers.set(cid, name);
      renderPeers();
    },
    leave(cid) {
      peers.delete(cid);
      cursors.get(cid)?.el.remove();
      cursors.delete(cid);
      renderPeers();
    },
    status(state, rtt) {
      statusDot.className = state;
      statusText.textContent = state === 'open' ? (rtt ? `${rtt} ms` : 'live') : state === 'connecting' ? 'connecting' : 'offline';
    },
    fatal(reason) {
      banner.hidden = false;
      banner.textContent =
        reason === 'auth' ? 'Session expired. Log in again.' : 'This board does not exist or you are not a member of its workspace.';
      if (reason === 'auth') setTimeout(() => navigate('/login'), 1200);
    },
  });

  const cursorSweep = window.setInterval(() => {
    const now = performance.now();
    for (const [cid, c] of cursors) {
      if (now - c.at > 4000) {
        c.el.remove();
        cursors.delete(cid);
      }
    }
  }, 1000);

  api('GET', `/api/boards/${boardId}`)
    .then((b) => {
      titleBtn.textContent = b.name;
      document.title = `${b.name} · mero`;
    })
    .catch(() => (titleBtn.textContent = 'Board'));

  const offTheme = onThemeChange((dark) => {
    engine.setDark(dark);
    renderProps();
  });

  // ---- toolbar ----------------------------------------------------------
  boardEl.addEventListener('click', async (e) => {
    const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!t) return;
    const d = t.dataset;
    if (d.tool) {
      // The shapes button opens its picker; tapping it again closes it.
      if (d.tool === 'shape') shapeMenu.hidden = engine.tool === 'shape' ? !shapeMenu.hidden : false;
      else shapeMenu.hidden = true;
      engine.setTool(d.tool as Tool);
    } else if (d.shape) {
      prefs.shape = d.shape as ShapeKind;
      savePrefs(prefs);
      shapeMenu.hidden = true;
      engine.setTool('shape');
    } else if (d.color) pickColor(d.color);
    else if (d.act === 'undo') engine.undo();
    else if (d.act === 'redo') engine.redo();
    else if (d.act === 'group') engine.groupSelection();
    else if (d.act === 'ungroup') engine.ungroupSelection();
    else if (d.act === 'duplicate') engine.duplicateSelection();
    else if (d.act === 'delete') engine.deleteSelection();
    else if (d.act === 'zoom') engine.zoomTo(1);
    else if (d.act === 'theme') toggleTheme();
    else if (d.act === 'finger') {
      prefs.fingerDraw = !prefs.fingerDraw;
      savePrefs(prefs);
      renderProps();
    } else if (d.act === 'width-mode') {
      prefs.fixedWidth = !prefs.fixedWidth;
      savePrefs(prefs);
      renderProps();
    } else if (d.act === 'back') navigate('/');
    else if (d.act === 'rename') {
      const name = prompt('Board name', titleBtn.textContent || '')?.trim();
      if (name) {
        titleBtn.textContent = name;
        await api('PATCH', `/api/boards/${boardId}`, { name }).catch(() => {});
      }
    }
  });
  // The custom colour input is re-rendered with the bar, so listen on the bar.
  propsBar.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.type === 'color') pickColor(input.value);
    else if (input.dataset.slider) {
      sliding = input;
      if (input === widthIn) slideWidth(false);
      else slideOpacity(false);
    }
  });
  // Release ends a slide. 'change' covers keys but doesn't fire if the thumb
  // ends where it started, so pointerup ends it too; whichever comes first wins.
  function endSlide() {
    const input = sliding;
    if (!input) return;
    sliding = null;
    if (input === widthIn) slideWidth(true);
    else slideOpacity(true);
  }
  propsBar.addEventListener('change', endSlide);
  window.addEventListener('pointerup', endSlide);
  window.addEventListener('pointercancel', endSlide);
  stage.addEventListener('pointerdown', () => (shapeMenu.hidden = true));

  return () => {
    window.removeEventListener('pointerup', endSlide);
    window.removeEventListener('pointercancel', endSlide);
    clearInterval(cursorSweep);
    clearTimeout(saveViewTimer);
    offTheme();
    sync.close();
    engine.destroy();
    document.title = 'mero';
  };
}

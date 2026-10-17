import { createApi } from './api.js';
import {
  apply,
  compose,
  fromPlacement,
  invert,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  rotationAbout,
  toPlacement,
  translation,
} from './geometry.js';
import { openPlanFile } from './raster.js';

// Floor plan designer: upload a plan, set its scale, outline named rooms, and
// place it on the live LiDAR map. Plan geometry is edited in image pixels and
// converted to plan metres (x right, z down from the top-left) when saved.

const params = new URLSearchParams(location.search);
const api = createApi({ mock: params.has('mock'), token: params.get('token') ?? '' });

const $ = (id) => document.getElementById(id);
const svg = $('svg');
const world = $('world');
const stage = $('stage');
const SVGNS = 'http://www.w3.org/2000/svg';
const CLOSE_RADIUS = 14; // screen px to snap onto the first vertex
const TAP_SLOP = 6; // screen px before a press becomes a pan

const state = {
  tool: 'upload',
  plan: null, // { id, name, imageSrc, widthPx, heightPx, mpp, rooms: [{ id, name, poly: [[px, py]] }], placement }
  newImage: null, // data URL waiting to be uploaded
  source: null, // opened PDF/image, for page switching
  page: 1,
  scaleLine: null, // { a: [px, py], b: [px, py] | null }
  draft: null, // vertices of the room being drawn
  cursor: null,
  selected: null,
  map: null,
  placementDraft: null, // unsaved manual placement
  dirty: false,
  view: { x: 0, y: 0, k: 1 },
  space: false,
};

// --- Helpers ---------------------------------------------------------------

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const pts = (poly) => poly.map(([x, y]) => `${x},${y}`).join(' ');
const pad2 = (n) => String(n).padStart(2, '0');
const deg = (rad) => (rad * 180) / Math.PI;
const mpp = () => state.plan?.mpp ?? null;
const placement = () => state.placementDraft ?? state.plan?.placement ?? null;

function toast(text, error = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

function busy(label) {
  $('busy').hidden = !label;
  if (label) $('busyLabel').textContent = label;
}

function screenToWorld(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  const { x, y, k } = state.view;
  return [(clientX - r.left - x) / k, (clientY - r.top - y) / k];
}

// Shift snaps a new point to horizontal/vertical from the previous one.
function snap(prev, p, on) {
  if (!on || !prev) return p;
  return Math.abs(p[0] - prev[0]) > Math.abs(p[1] - prev[1]) ? [p[0], prev[1]] : [prev[0], p[1]];
}

function markDirty() {
  state.dirty = true;
  renderPanel();
}

// Map content (map frame, metres) → plan pixels, via the inverse placement.
function mapToPlanPx(T_inv, [x, z]) {
  const [px, pz] = apply(T_inv, [x, z]);
  return [px / mpp(), pz / mpp()];
}

function mapWallsInPlanMetres() {
  const P = placement();
  if (!P || !state.map) return [];
  const inv = invert(fromPlacement(P));
  return (state.map.walls ?? []).map((w) => [...apply(inv, [w[0], w[1]]), ...apply(inv, [w[2], w[3]])]);
}

function overlayCentre() {
  const walls = mapWallsInPlanMetres();
  if (!walls.length) return [(state.plan.widthPx * mpp()) / 2, (state.plan.heightPx * mpp()) / 2];
  const xs = walls.flatMap((w) => [w[0], w[2]]);
  const zs = walls.flatMap((w) => [w[1], w[3]]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
}

function linkedMapRooms(planRoomId) {
  return (state.map?.rooms ?? []).filter((r) => r.planRoomId === planRoomId);
}

// --- View ------------------------------------------------------------------

function applyView() {
  const { x, y, k } = state.view;
  world.setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
  renderOverlays();
}

function fit() {
  if (!state.plan) return;
  const r = svg.getBoundingClientRect();
  const pad = Math.min(48, r.width * 0.06);
  const k = Math.min((r.width - 2 * pad) / state.plan.widthPx, (r.height - 2 * pad) / state.plan.heightPx);
  state.view = { k, x: (r.width - state.plan.widthPx * k) / 2, y: (r.height - state.plan.heightPx * k) / 2 };
  applyView();
}

function zoomAt(clientX, clientY, factor) {
  const r = svg.getBoundingClientRect();
  const sx = clientX - r.left;
  const sy = clientY - r.top;
  const { x, y, k } = state.view;
  const k2 = Math.min(40, Math.max(0.02, k * factor));
  state.view = { k: k2, x: sx - ((sx - x) / k) * k2, y: sy - ((sy - y) / k) * k2 };
  applyView();
}

// --- Rendering -------------------------------------------------------------

function renderImage() {
  const img = $('planImg');
  $('empty').hidden = !!state.plan;
  if (!state.plan) {
    img.removeAttribute('href');
    return;
  }
  img.setAttribute('href', state.plan.imageSrc);
  img.setAttribute('width', state.plan.widthPx);
  img.setAttribute('height', state.plan.heightPx);
}

function renderRooms() {
  const layer = $('roomsLayer');
  layer.replaceChildren();
  if (!state.plan) return;
  const k = state.view.k;
  const fs = 11 / k;
  for (const room of state.plan.rooms) {
    const selected = room.id === state.selected;
    const linked = linkedMapRooms(room.id).length > 0;
    layer.append(
      el('polygon', {
        points: pts(room.poly),
        class: `room-shape${selected ? ' selected' : ''}${linked ? ' linked' : ''}`,
        'data-room': room.id,
      }),
    );
    const [cx, cy] = polygonCentroid(room.poly);
    layer.append(el('text', { x: cx, y: cy, 'font-size': fs, 'text-anchor': 'middle', class: 'room-label', 'stroke-width': 3 / k }, room.name.toUpperCase()));
    const area = mpp() ? `${(polygonArea(room.poly) * mpp() ** 2).toFixed(1)} M²` : '';
    const sub = [area, linked ? '● LINKED' : ''].filter(Boolean).join(' · ');
    if (sub) {
      layer.append(el('text', { x: cx, y: cy + fs * 1.5, 'font-size': fs * 0.85, 'text-anchor': 'middle', class: 'room-label sub', 'stroke-width': 3 / k }, sub));
    }
    if (selected && state.tool === 'select') {
      room.poly.forEach(([x, y], i) => layer.append(el('circle', { cx: x, cy: y, r: 6 / k, class: 'handle', 'data-vertex': i, 'data-room': room.id })));
    }
  }
}

function renderDraft() {
  const layer = $('draftLayer');
  layer.replaceChildren();
  const k = state.view.k;
  if (state.draft) {
    const live = state.cursor ? [...state.draft, state.cursor] : state.draft;
    layer.append(el(live.length > 2 ? 'polygon' : 'polyline', { points: pts(live), class: 'draft' }));
    state.draft.forEach(([x, y], i) => layer.append(el('circle', { cx: x, cy: y, r: (i === 0 ? 7 : 4.5) / k, class: `handle${i === 0 ? ' first' : ''}` })));
  }
  const line = state.scaleLine;
  if (line) {
    const b = line.b ?? state.cursor;
    if (b) {
      layer.append(el('line', { x1: line.a[0], y1: line.a[1], x2: b[0], y2: b[1], class: 'scale-line' }));
      // End ticks perpendicular to the line.
      const len = Math.hypot(b[0] - line.a[0], b[1] - line.a[1]) || 1;
      const nx = (-(b[1] - line.a[1]) / len) * (9 / k);
      const ny = ((b[0] - line.a[0]) / len) * (9 / k);
      for (const p of [line.a, b]) layer.append(el('line', { x1: p[0] - nx, y1: p[1] - ny, x2: p[0] + nx, y2: p[1] + ny, class: 'scale-tick' }));
      const label = mpp() ? `${(len * mpp()).toFixed(2)} M` : `${Math.round(len)} PX`;
      layer.append(
        el('text', { x: (line.a[0] + b[0]) / 2 + nx * 1.6, y: (line.a[1] + b[1]) / 2 + ny * 1.6, 'font-size': 11 / k, 'text-anchor': 'middle', class: 'room-label', 'stroke-width': 3 / k }, label),
      );
    }
  }
}

function renderMap() {
  const layer = $('mapLayer');
  layer.replaceChildren();
  const P = placement();
  if (!P || !mpp() || !state.map) return;
  const k = state.view.k;
  const inv = invert(fromPlacement(P));
  const toPx = (p) => mapToPlanPx(inv, p);
  for (const room of state.map.rooms ?? []) {
    room.walls.forEach((w, i) => {
      const [a, b] = [toPx([w[0], w[1]]), toPx([w[2], w[3]])];
      layer.append(el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: `map-wall${(room.seen?.[i] ?? 1) < 2 ? ' weak' : ''}` }));
    });
    for (const o of room.openings ?? []) {
      const [a, b] = [toPx([o.s[0], o.s[1]]), toPx([o.s[2], o.s[3]])];
      layer.append(el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: o.kind === 'door' ? 'map-door' : 'map-window' }));
    }
  }
  // Map origin: where the first scan started.
  if (state.map.origin) {
    const [ox, oy] = toPx([0, 0]);
    const s = 10 / k;
    layer.append(el('path', { d: `M${ox - s},${oy}H${ox + s}M${ox},${oy - s}V${oy + s}`, class: 'map-origin' }));
    layer.append(el('circle', { cx: ox, cy: oy, r: s * 0.55, class: 'map-origin', fill: 'none' }));
  }
  if (state.tool === 'place') {
    const [cx, cz] = overlayCentre();
    const c = [cx / mpp(), cz / mpp()];
    const arm = 70 / k;
    // The overlay is drawn with the inverse placement, which turns it
    // clockwise on screen by +yaw; the handle follows.
    const angle = -Math.PI / 2 + P.yaw;
    const h = [c[0] + Math.cos(angle) * arm, c[1] + Math.sin(angle) * arm];
    layer.append(el('line', { x1: c[0], y1: c[1], x2: h[0], y2: h[1], class: 'rot-arm' }));
    layer.append(el('circle', { cx: h[0], cy: h[1], r: 9 / k, class: 'rot-handle', 'data-rotate': '1' }));
    layer.append(el('circle', { cx: c[0], cy: c[1], r: 4 / k, class: 'handle first' }));
  }
}

function renderOverlays() {
  renderMap();
  renderRooms();
  renderDraft();
}

const STEP_OF_TOOL = { upload: 'upload', scale: 'scale', room: 'rooms', select: 'rooms', place: 'place' };

let roomListSignature = '';
function renderRoomList() {
  const rooms = state.plan?.rooms ?? [];
  const meta = rooms.map((r) => {
    const linked = linkedMapRooms(r.id);
    const walls = linked.reduce((n, m) => n + m.walls.length, 0);
    const doors = linked.reduce((n, m) => n + (m.openings ?? []).filter((o) => o.kind === 'door').length, 0);
    const windows = linked.reduce((n, m) => n + (m.openings ?? []).filter((o) => o.kind === 'window').length, 0);
    return { linked, walls, doors, windows };
  });
  const signature = JSON.stringify([rooms.map((r) => r.id), state.selected, meta.map((m) => [m.linked.map((l) => l.name), m.walls, m.doors, m.windows]), !!mpp()]);
  $('roomCount').textContent = pad2(rooms.length);
  $('roomsEmpty').hidden = rooms.length > 0;
  if (signature === roomListSignature) return;
  roomListSignature = signature;

  const list = $('rooms');
  list.replaceChildren();
  rooms.forEach((room, i) => {
    const m = meta[i];
    const li = document.createElement('li');
    li.classList.toggle('selected', room.id === state.selected);
    li.dataset.room = room.id;
    const idx = Object.assign(document.createElement('span'), { className: 'idx', textContent: pad2(i + 1) });
    const name = Object.assign(document.createElement('input'), { value: room.name, maxLength: 40, ariaLabel: 'Room name' });
    name.addEventListener('input', () => {
      room.name = name.value;
      markDirty();
      renderRooms();
    });
    name.addEventListener('focus', () => select(room.id));
    const del = Object.assign(document.createElement('button'), { className: 'del', textContent: '×', title: 'Delete room' });
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteRoom(room.id);
    });
    const chips = document.createElement('div');
    chips.className = 'meta';
    const chip = (text, cls = '') => chips.append(Object.assign(document.createElement('span'), { className: `chip ${cls}`, textContent: text }));
    if (mpp()) chip(`${(polygonArea(room.poly) * mpp() ** 2).toFixed(1)} M²`);
    if (m.linked.length) {
      chip(`LINKED · ${m.linked.map((l) => l.name.toUpperCase()).join(', ')}`, 'on');
      chip(`${m.walls} WALLS`);
      if (m.doors) chip(`${m.doors} DOOR${m.doors > 1 ? 'S' : ''}`);
      if (m.windows) chip(`${m.windows} WINDOW${m.windows > 1 ? 'S' : ''}`);
    } else {
      chip('NOT SCANNED', 'red');
    }
    li.append(idx, name, del, chips);
    li.addEventListener('click', () => select(room.id));
    list.append(li);
  });
}

function renderPanel() {
  const plan = state.plan;
  // Steps
  const done = {
    upload: !!plan,
    scale: !!mpp(),
    rooms: !!plan?.rooms.length && !state.dirty,
    place: !!plan?.placement,
  };
  for (const li of $('steps').children) {
    li.classList.toggle('done', done[li.dataset.step]);
    li.classList.toggle('active', STEP_OF_TOOL[state.tool] === li.dataset.step);
  }
  for (const b of $('rail').querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === state.tool));
  stage.dataset.tool = state.tool;

  // Scale
  if (mpp()) {
    $('scaleReadout').textContent = `${(1 / mpp()).toFixed(1)} PX/M`;
    $('scaleSub').textContent = `PLAN ${(plan.widthPx * mpp()).toFixed(1)} × ${(plan.heightPx * mpp()).toFixed(1)} M`;
  } else {
    $('scaleReadout').textContent = '--';
    $('scaleSub').textContent = plan ? 'DRAW A LINE OF KNOWN LENGTH' : 'UPLOAD A PLAN FIRST';
  }
  const lineReady = !!state.scaleLine?.b;
  $('scaleLength').disabled = !lineReady;
  $('applyScale').disabled = !lineReady;

  // Placement
  const P = placement();
  if (P) {
    $('placeReadout').textContent = `${deg(P.yaw).toFixed(1)}°`;
    $('placeSub').textContent = `${state.placementDraft ? 'UNSAVED · ' : ''}OFFSET ${P.t[0].toFixed(2)}, ${P.t[2].toFixed(2)} M`;
  } else {
    $('placeReadout').textContent = 'NOT PLACED';
    $('placeSub').textContent = state.map?.walls?.length ? `${state.map.walls.length} SCANNED WALLS READY` : 'SCAN WALLS WITH THE APP, THEN AUTO-PLACE';
  }
  const canPlace = !!plan?.id && !!mpp();
  $('autoplace').disabled = !canPlace;
  $('manual').disabled = !canPlace;
  for (const b of document.querySelectorAll('[data-rot]')) b.disabled = !canPlace || !P;
  $('savePlacement').disabled = !state.placementDraft;
  $('clearPlacement').disabled = !plan?.placement && !state.placementDraft;

  // Save
  $('save').disabled = !plan || !mpp() || !state.dirty;
  $('saveState').textContent = !plan
    ? 'NOTHING TO SAVE'
    : !mpp()
      ? 'SET THE SCALE TO SAVE'
      : state.dirty
        ? 'UNSAVED CHANGES'
        : `SAVED${plan.updatedAt ? ` · ${new Date(plan.updatedAt).toLocaleTimeString()}` : ''}`;
  if (document.activeElement !== $('planName')) $('planName').value = plan?.name ?? '';
  $('planName').disabled = !plan;

  renderRoomList();
  renderHint();
}

function renderHint() {
  const plan = state.plan;
  let text = '';
  if (!plan) text = 'UPLOAD A PDF, JPG OR PNG FLOOR PLAN';
  else if (state.tool === 'scale') text = state.scaleLine?.b ? 'ENTER THE REAL LENGTH IN THE PANEL' : state.scaleLine ? 'TAP THE OTHER END · SHIFT = STRAIGHT' : 'TAP BOTH ENDS OF A WALL YOU KNOW THE LENGTH OF';
  else if (state.tool === 'room')
    text = state.draft?.length >= 3 ? 'TAP THE FIRST CORNER OR ENTER TO CLOSE · ⌫ UNDO' : state.draft ? 'TAP THE NEXT CORNER · SHIFT = STRAIGHT' : 'TAP A ROOM CORNER TO START';
  else if (state.tool === 'select') text = state.selected ? 'DRAG CORNERS TO ADJUST · ⌫ DELETES ROOM' : 'TAP A ROOM TO EDIT IT';
  else if (state.tool === 'place')
    text = !mpp() ? 'SET THE SCALE FIRST' : placement() ? 'DRAG TO MOVE · RED HANDLE ROTATES · R ±1°' : 'AUTO-PLACE, OR MANUAL TO DRAG THE SCAN ONTO THE PLAN';
  $('hint').textContent = text;
}

function render() {
  renderImage();
  renderOverlays();
  renderPanel();
}

// --- Actions ---------------------------------------------------------------

function setTool(tool) {
  if (tool === 'upload') {
    $('file').click();
    return;
  }
  state.tool = tool;
  if (tool !== 'room') state.draft = null;
  if (tool !== 'scale' && state.scaleLine && !state.scaleLine.b) state.scaleLine = null;
  render();
}

function select(id) {
  state.selected = id;
  renderOverlays();
  renderPanel();
}

function deleteRoom(id) {
  const room = state.plan.rooms.find((r) => r.id === id);
  if (!room) return;
  if (linkedMapRooms(id).length && !confirm(`"${room.name}" is linked to a scanned room. Delete it anyway?`)) return;
  state.plan.rooms = state.plan.rooms.filter((r) => r.id !== id);
  if (state.selected === id) state.selected = null;
  markDirty();
  render();
}

function closeDraft() {
  if (!state.draft || state.draft.length < 3) return;
  const id = `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  state.plan.rooms.push({ id, name: `Room ${state.plan.rooms.length + 1}`, poly: state.draft });
  state.draft = null;
  state.selected = id;
  markDirty();
  render();
  // Name it straight away.
  const input = $('rooms').querySelector(`li[data-room="${id}"] input`);
  input?.focus();
  input?.select();
}

function applyScale() {
  const metres = parseFloat($('scaleLength').value);
  const { a, b } = state.scaleLine ?? {};
  if (!a || !b || !(metres > 0)) return toast('Enter the line’s length in metres', true);
  const px = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (px < 5) return toast('Draw a longer line', true);
  state.plan.mpp = metres / px;
  state.scaleLine = null;
  $('scaleLength').value = '';
  markDirty();
  setTool(state.plan.rooms.length ? 'select' : 'room');
  toast(`Scale set: ${(1 / state.plan.mpp).toFixed(1)} px per metre`);
}

async function loadFile(file) {
  if (state.plan?.rooms.length && !confirm('Replace the current plan? Its rooms and placement will be cleared.')) return;
  busy(/\.pdf$/i.test(file.name) ? 'RENDERING PDF' : 'PREPARING IMAGE');
  try {
    state.source = await openPlanFile(file);
    state.page = 1;
    const select = $('page');
    select.replaceChildren(...Array.from({ length: state.source.pages }, (_, i) => new Option(`${i + 1} / ${state.source.pages}`, i + 1)));
    $('pageRow').hidden = state.source.pages < 2;
    await showPage(1, file.name.replace(/\.[^.]+$/, ''));
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not read that file', true);
  } finally {
    busy(null);
  }
}

async function showPage(page, name) {
  const image = await state.source.render(page);
  state.page = page;
  state.newImage = image.dataUrl;
  state.plan = {
    id: state.plan?.id ?? null,
    name: name ?? state.plan?.name ?? 'Floor plan',
    imageSrc: image.dataUrl,
    widthPx: image.widthPx,
    heightPx: image.heightPx,
    mpp: null,
    rooms: [],
    placement: null,
  };
  state.scaleLine = null;
  state.draft = null;
  state.selected = null;
  state.placementDraft = null;
  state.dirty = true;
  state.tool = 'scale';
  render();
  fit();
}

function applyServerPlan(p, imageSrc) {
  state.plan = {
    id: p.id,
    name: p.name,
    imageSrc: imageSrc ?? p.imageUrl,
    widthPx: p.widthPx,
    heightPx: p.heightPx,
    mpp: p.metresPerPx,
    rooms: p.rooms.map((r) => ({ id: r.id, name: r.name, poly: r.polygon.map(([x, z]) => [x / p.metresPerPx, z / p.metresPerPx]) })),
    placement: p.placement,
    updatedAt: p.updatedAt,
  };
}

async function save() {
  const plan = state.plan;
  if (!plan || !mpp()) return;
  $('save').disabled = true;
  try {
    const body = {
      name: plan.name || 'Floor plan',
      widthPx: plan.widthPx,
      heightPx: plan.heightPx,
      metresPerPx: plan.mpp,
      rooms: plan.rooms.map((r) => ({ id: r.id, name: r.name || 'Room', polygon: r.poly.map(([x, y]) => [x * plan.mpp, y * plan.mpp]) })),
      ...(state.newImage && { image: state.newImage }),
    };
    const saved = await api.putPlan(body);
    applyServerPlan(saved, plan.imageSrc);
    state.newImage = null;
    state.dirty = false;
    render();
    toast('Plan saved · rooms are now available in the app');
  } catch (err) {
    toast(err.message, true);
    renderPanel();
  }
}

async function ensureSaved() {
  if (state.dirty || !state.plan?.id) await save();
  return !state.dirty && !!state.plan?.id;
}

async function autoplace() {
  if (!(await ensureSaved())) return;
  busy('MATCHING WALLS');
  try {
    const res = await api.autoplace();
    state.plan.placement = res.placement;
    state.placementDraft = null;
    state.tool = 'place';
    render();
    toast(`Placed · ${Math.round(res.inlierFraction * 100)}% of scanned walls match`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(null);
  }
}

// Start manual placement with the scan's centre on the plan's centre.
async function startManual() {
  if (!(await ensureSaved())) return;
  if (!placement()) {
    const walls = state.map?.walls ?? [];
    const xs = walls.flatMap((w) => [w[0], w[2]]);
    const zs = walls.flatMap((w) => [w[1], w[3]]);
    const mapCentre = walls.length ? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2] : [0, 0];
    const planCentre = [(state.plan.widthPx * mpp()) / 2, (state.plan.heightPx * mpp()) / 2];
    state.placementDraft = { yaw: 0, t: [mapCentre[0] - planCentre[0], 0, mapCentre[1] - planCentre[1]] };
  }
  setTool('place');
}

// Rotate the scan overlay on screen by `degrees` (clockwise) about its centre.
function rotateOverlay(degrees) {
  const P = placement();
  if (!P) return;
  const T = compose(fromPlacement(P), rotationAbout((degrees * Math.PI) / 180, overlayCentre()));
  state.placementDraft = toPlacement(T);
  renderOverlays();
  renderPanel();
}

async function savePlacement(value = state.placementDraft) {
  try {
    const saved = await api.putPlacement(value);
    state.plan.placement = saved.placement;
    state.plan.updatedAt = saved.updatedAt;
    state.placementDraft = null;
    render();
    toast(value ? 'Placement saved' : 'Placement cleared');
  } catch (err) {
    toast(err.message, true);
  }
}

// --- Pointer & keyboard ----------------------------------------------------

const pointers = new Map();
let gesture = null;

svg.addEventListener('pointerdown', (e) => {
  if (!state.plan) return;
  svg.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    gesture = { type: 'pinch', d0: Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), c0: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2], view0: { ...state.view } };
    return;
  }
  const w = screenToWorld(e.clientX, e.clientY);
  const t = e.target;
  const start = { sx: e.clientX, sy: e.clientY, view0: { ...state.view }, w };
  if (state.space || e.button === 1) gesture = { type: 'pan', ...start };
  else if (state.tool === 'select' && t.dataset.vertex != null) gesture = { type: 'vertex', room: t.dataset.room, index: +t.dataset.vertex, ...start };
  else if (state.tool === 'place' && t.dataset.rotate && placement()) {
    const c = overlayCentre().map((v) => v / mpp());
    gesture = { type: 'rotate', c, a0: Math.atan2(w[1] - c[1], w[0] - c[0]), P0: placement(), ...start };
  } else if (state.tool === 'place' && placement()) gesture = { type: 'move', P0: placement(), ...start };
  else gesture = { type: 'tap', ...start };
  stage.classList.toggle('panning', gesture.type === 'pan');
});

svg.addEventListener('pointermove', (e) => {
  if (!state.plan) return;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
  const w = screenToWorld(e.clientX, e.clientY);

  if (gesture?.type === 'pinch' && pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const c = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    const { view0, d0, c0 } = gesture;
    const r = svg.getBoundingClientRect();
    const k = Math.min(40, Math.max(0.02, view0.k * (d / d0)));
    const wx = (c0[0] - r.left - view0.x) / view0.k;
    const wy = (c0[1] - r.top - view0.y) / view0.k;
    state.view = { k, x: c[0] - r.left - wx * k, y: c[1] - r.top - wy * k };
    return applyView();
  }
  if (gesture?.type === 'tap' && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > TAP_SLOP) {
    gesture.type = 'pan';
    stage.classList.add('panning');
  }
  if (gesture?.type === 'pan') {
    state.view = { ...gesture.view0, x: gesture.view0.x + e.clientX - gesture.sx, y: gesture.view0.y + e.clientY - gesture.sy };
    return applyView();
  }
  if (gesture?.type === 'vertex') {
    const room = state.plan.rooms.find((r) => r.id === gesture.room);
    const n = room.poly.length;
    const prev = room.poly[(gesture.index - 1 + n) % n];
    room.poly[gesture.index] = snap(prev, w, e.shiftKey);
    gesture.changed = true;
    return renderRooms();
  }
  if (gesture?.type === 'move') {
    const d = [(w[0] - gesture.w[0]) * mpp(), (w[1] - gesture.w[1]) * mpp()];
    state.placementDraft = toPlacement(compose(fromPlacement(gesture.P0), translation(-d[0], -d[1])));
    renderMap();
    return renderPanel();
  }
  if (gesture?.type === 'rotate') {
    const a = Math.atan2(w[1] - gesture.c[1], w[0] - gesture.c[0]);
    let theta = a - gesture.a0;
    if (e.shiftKey) theta = Math.round(theta / (Math.PI / 12)) * (Math.PI / 12);
    const centreM = gesture.c.map((v) => v * mpp());
    state.placementDraft = toPlacement(compose(fromPlacement(gesture.P0), rotationAbout(theta, centreM)));
    renderMap();
    return renderPanel();
  }

  // Hover: live preview of the next segment.
  if (state.tool === 'room' && state.draft) {
    state.cursor = snap(state.draft.at(-1), w, e.shiftKey);
    renderDraft();
  } else if (state.tool === 'scale' && state.scaleLine && !state.scaleLine.b) {
    state.cursor = snap(state.scaleLine.a, w, e.shiftKey);
    renderDraft();
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  const g = gesture;
  if (pointers.size === 0) {
    gesture = null;
    stage.classList.remove('panning');
  } else if (g?.type === 'pinch') {
    gesture = null; // wait for a fresh press
  }
  if (!g || e.type === 'pointercancel') return;
  if (g.type === 'vertex' && g.changed) markDirty();
  if (g.type === 'tap') tap(screenToWorld(e.clientX, e.clientY), e);
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);

function tap(w, e) {
  const k = state.view.k;
  if (state.tool === 'scale') {
    if (!state.scaleLine || state.scaleLine.b) state.scaleLine = { a: w, b: null };
    else {
      state.scaleLine.b = snap(state.scaleLine.a, w, e.shiftKey);
      state.cursor = null;
      setTimeout(() => $('scaleLength').focus(), 0);
    }
    renderDraft();
    renderPanel();
  } else if (state.tool === 'room') {
    if (!mpp()) toast('Tip: set the scale first so rooms get real sizes');
    const draft = state.draft ?? [];
    const first = draft[0];
    if (first && draft.length >= 3 && Math.hypot(w[0] - first[0], w[1] - first[1]) * k < CLOSE_RADIUS) return closeDraft();
    state.draft = [...draft, snap(draft.at(-1), w, e.shiftKey)];
    renderDraft();
    renderHint();
  } else if (state.tool === 'select' || state.tool === 'place') {
    const hit = [...state.plan.rooms].reverse().find((r) => pointInPolygon(w, r.poly));
    if (state.tool === 'select' || hit) select(hit?.id ?? null);
  }
}

svg.addEventListener(
  'wheel',
  (e) => {
    if (!state.plan) return;
    e.preventDefault();
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  },
  { passive: false },
);

addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, select, textarea');
  if (typing) {
    if (e.key === 'Enter' && e.target.id === 'scaleLength') applyScale();
    if (e.key === 'Enter' && e.target.closest('#rooms')) e.target.blur();
    return;
  }
  if (e.key === ' ') {
    state.space = true;
    e.preventDefault();
    return;
  }
  const key = e.key.toLowerCase();
  if (e.key === 'Enter' && state.tool === 'room') closeDraft();
  else if (e.key === 'Escape') {
    state.draft = null;
    state.scaleLine = null;
    state.cursor = null;
    select(null);
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    if (state.draft) {
      state.draft = state.draft.length > 1 ? state.draft.slice(0, -1) : null;
      renderDraft();
      renderHint();
    } else if (state.selected) deleteRoom(state.selected);
  } else if (key === 'r' && state.tool === 'place') rotateOverlay(e.shiftKey ? -1 : 1);
  else if (key === 'u') setTool('upload');
  else if (key === 's' && !e.metaKey && !e.ctrlKey) setTool('scale');
  else if (key === 'n') setTool('room');
  else if (key === 'v') setTool('select');
  else if (key === 'p') setTool('place');
  else if (key === 'f') fit();
  else if (key === 's' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    save();
  }
});
addEventListener('keyup', (e) => {
  if (e.key === ' ') state.space = false;
});

// --- Wiring ----------------------------------------------------------------

for (const b of $('rail').querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
$('fit').addEventListener('click', fit);
$('emptyUpload').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) loadFile(file);
});
$('page').addEventListener('change', async (e) => {
  if (state.plan?.rooms.length && !confirm('Switch page? Rooms drawn on this page will be cleared.')) {
    e.target.value = state.page;
    return;
  }
  busy('RENDERING PDF');
  try {
    await showPage(+e.target.value);
  } finally {
    busy(null);
  }
});
$('planName').addEventListener('input', (e) => {
  if (!state.plan) return;
  state.plan.name = e.target.value;
  markDirty();
});
for (const r of document.querySelectorAll('input[name=look]')) {
  r.addEventListener('change', () => {
    document.body.classList.toggle('ink', r.value === 'ink' && r.checked);
    try {
      localStorage.setItem('slt.designer.look', r.value);
    } catch {}
  });
}
$('applyScale').addEventListener('click', applyScale);
$('save').addEventListener('click', save);
$('autoplace').addEventListener('click', autoplace);
$('manual').addEventListener('click', startManual);
for (const b of document.querySelectorAll('[data-rot]')) b.addEventListener('click', () => rotateOverlay(+b.dataset.rot));
$('savePlacement').addEventListener('click', () => savePlacement());
$('clearPlacement').addEventListener('click', () => {
  if (state.placementDraft && !state.plan?.placement) {
    state.placementDraft = null;
    return render();
  }
  if (confirm('Clear the plan’s placement on the map?')) savePlacement(null);
});

// Drag & drop anywhere on the stage.
let dragDepth = 0;
stage.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('dropzone').hidden = false;
});
stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('dropzone').hidden = true;
});
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  const file = e.dataTransfer.files?.[0];
  if (file) loadFile(file);
});

addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});
new ResizeObserver(() => state.plan && applyView()).observe(stage);

// --- Boot ------------------------------------------------------------------

try {
  if (localStorage.getItem('slt.designer.look') === 'original') $('lookOriginal').checked = true;
} catch {}
document.body.classList.toggle('ink', $('lookInk').checked);

// The live map says whether a plan exists, which spares a 404 on first visit.
let firstMap;
const firstMapArrived = new Promise((resolve) => (firstMap = resolve));

api.connectMap(
  (map) => {
    firstMap(map);
    state.map = map;
    // Someone else (or auto-place) moved the plan: follow unless mid-edit.
    if (state.plan && map.plan && map.plan.id === state.plan.id && !state.placementDraft) state.plan.placement = map.plan.placement;
    renderOverlays();
    renderPanel();
    $('liveLabel').textContent = `${params.has('mock') ? 'MOCK' : 'MAP'} · ${pad2(map.walls?.length ?? 0)} WALLS`;
  },
  (connected) => {
    $('liveDot').classList.toggle('on', connected);
    if (!connected) $('liveLabel').textContent = 'MAP OFFLINE';
  },
);

(async () => {
  try {
    const map = await Promise.race([firstMapArrived, new Promise((r) => setTimeout(() => r(undefined), 3000))]);
    const plan = map && map.plan === null ? null : await api.getPlan();
    if (plan) {
      applyServerPlan(plan);
      state.tool = 'select';
    }
  } catch (err) {
    toast(`Could not load the saved plan: ${err.message}`, true);
  }
  render();
  if (state.plan) requestAnimationFrame(fit);
})();

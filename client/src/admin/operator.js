// Security operator view: a top-down floor plan of the live map with every
// device and where it is looking, beside a wall of every device's camera.
// Pure 2D (canvas + DOM), so it stays fast while the 3D scene is paused.

const RED = '#d71921';
const LIME = '#c8ff3a';
const STALE_MS = 5000;

// Rotate v by quaternion q = [x, y, z, w].
function rotate([qx, qy, qz, qw], [vx, vy, vz]) {
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

/**
 * Clockwise quarter-turns that make a frame upright. Frames arrive in the
 * camera sensor's landscape orientation; ARKit camera space has +x toward the
 * phone's bottom edge and +y toward its right edge (seen from the front), so
 * where world "up" falls in the image tells how the phone was held.
 */
export function uprightTurns(q) {
  if (!Array.isArray(q) || q.length !== 4) return 0;
  const xUp = rotate(q, [1, 0, 0])[1];
  const yUp = rotate(q, [0, 1, 0])[1];
  if (Math.hypot(xUp, yUp) < 0.2) return null; // pointing straight up/down: no reliable "up"
  const turns = Math.round(-Math.atan2(xUp, yUp) / (Math.PI / 2));
  return ((turns % 4) + 4) % 4;
}

// Top-down heading of a camera: where it looks, on the floor plane (x right, z down).
function heading(q) {
  let [fx, , fz] = rotate(q, [0, 0, -1]);
  // Held flat, forward has no useful heading: use the phone's top edge instead.
  if (Math.hypot(fx, fz) < 0.35) [fx, , fz] = rotate(q, [-1, 0, 0]);
  const len = Math.hypot(fx, fz) || 1;
  return [fx / len, fz / len];
}

const pad = (n) => String(n).padStart(2, '0');

export class OperatorView {
  constructor(root) {
    this.root = root;
    this.map = null;
    this.devices = [];
    this.frames = new Map(); // id -> { bitmap, turns, at }
    this.selected = null;
    this.planImg = null;
    this.planUrl = null;
    this.tiles = new Map();
    this.lastLabels = 0;
    this.dirty = true;

    root.innerHTML = `
      <div class="op-head">
        <div class="op-counts">
          <div><b data-c="online">00</b><span>DEVICES ONLINE</span></div>
          <div><b data-c="live">00</b><span>LIVE FEEDS</span></div>
          <div><b data-c="rooms">00</b><span>ROOMS</span></div>
          <div><b data-c="walls">00</b><span>WALLS</span></div>
        </div>
      </div>
      <section class="op-plan">
        <h2>FLOOR PLAN</h2>
        <div class="op-canvas"><canvas aria-label="Top-down floor plan with every device and its view direction" role="img"></canvas>
          <p class="op-empty" hidden>NO MAP YET · SCAN A ROOM OR CREATE A GROUP</p></div>
      </section>
      <section class="op-wall">
        <h2><span class="dot on"></span>LIVE CAMERA FEEDS</h2>
        <div class="op-tiles"></div>
        <p class="op-empty op-nodevices">NO DEVICES CONNECTED</p>
      </section>`;
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.tilesEl = root.querySelector('.op-tiles');
    this.counts = Object.fromEntries([...root.querySelectorAll('[data-c]')].map((el) => [el.dataset.c, el]));

    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const hit = this.hitDevice(e.clientX - r.left, e.clientY - r.top);
      this.select(hit);
    });
    this.tilesEl.addEventListener('click', (e) => {
      const tile = e.target.closest('.op-tile');
      if (tile) this.select(tile.dataset.id);
    });
    this.tilesEl.addEventListener('keydown', (e) => {
      const tile = e.target.closest('.op-tile');
      if (tile && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.select(tile.dataset.id);
      }
    });
    new ResizeObserver(() => (this.dirty = true)).observe(root.querySelector('.op-canvas'));
    // Tile canvases are sized from layout: redraw frames when the wall reflows.
    new ResizeObserver(() => this.relayout()).observe(this.tilesEl);
  }

  select(id) {
    this.selected = id && id !== this.selected ? id : null;
    for (const [tid, t] of this.tiles) t.el.classList.toggle('selected', tid === this.selected);
    if (this.selected) this.tiles.get(this.selected)?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this.dirty = true;
  }

  setMap(map) {
    this.map = map;
    const url = map?.plan?.placement && map.plan.imageUrl ? map.plan.imageUrl : null;
    if (url !== this.planUrl) {
      this.planUrl = url;
      this.planImg = null;
      if (url) {
        const img = new Image();
        img.onload = () => {
          if (this.planUrl === url) {
            this.planImg = img;
            this.dirty = true;
          }
        };
        img.src = url;
      }
    }
    this.dirty = true;
  }

  setDevices(devices) {
    this.devices = devices;
    this.syncTiles();
    this.dirty = true;
  }

  setFrame(meta, bitmap) {
    // A frame can beat the first device list; it'd have no tile to show in.
    if (!this.devices.some((d) => d.id === meta.id)) return bitmap.close?.();
    const prev = this.frames.get(meta.id);
    prev?.bitmap.close?.();
    const turns = uprightTurns(meta.q);
    // Pointing straight up/down gives no "up": keep the last good orientation.
    this.frames.set(meta.id, { bitmap, turns: turns ?? prev?.turns ?? 0, at: performance.now() });
    this.syncTiles();
    this.drawTile(meta.id);
  }

  // --- video wall ----------------------------------------------------------

  syncTiles() {
    const ids = new Set();
    // Live feeds first, then by name, so the wall reads the same each time.
    const list = [...this.devices].sort((a, b) => Number(this.frames.has(b.id)) - Number(this.frames.has(a.id)) || a.name.localeCompare(b.name));
    for (const d of list) {
      ids.add(d.id);
      let t = this.tiles.get(d.id);
      if (!t) {
        const el = document.createElement('figure');
        el.className = 'op-tile';
        el.tabIndex = 0;
        el.dataset.id = d.id;
        el.innerHTML = `<div class="op-video"><canvas></canvas><span class="op-novideo">NO VIDEO</span></div>
          <figcaption><span class="dot"></span><span class="op-name"></span><span class="op-role"></span><span class="op-age"></span></figcaption>`;
        t = { el, canvas: el.querySelector('canvas'), name: el.querySelector('.op-name'), role: el.querySelector('.op-role'), age: el.querySelector('.op-age'), dot: el.querySelector('.dot') };
        this.tiles.set(d.id, t);
      }
      t.name.textContent = d.name;
      t.role.textContent = d.role ? d.role.toUpperCase() : d.kind === 'web' ? 'WEB' : '';
      t.el.classList.toggle('offline', !(d.online ?? d.live));
      t.el.classList.toggle('selected', d.id === this.selected);
      t.el.setAttribute('aria-label', `${d.name} camera`);
    }
    for (const [id, t] of this.tiles) {
      if (ids.has(id)) continue;
      t.el.remove();
      this.tiles.delete(id);
      this.frames.get(id)?.bitmap.close?.();
      this.frames.delete(id);
      if (this.selected === id) this.selected = null;
    }
    const order = list.map((d) => this.tiles.get(d.id).el);
    if (order.some((el, i) => this.tilesEl.children[i] !== el)) this.tilesEl.replaceChildren(...order);
    const n = order.length;
    this.tilesEl.dataset.n = String(Math.min(n, 6));
    this.root.querySelector('.op-nodevices').hidden = n > 0;
  }

  drawTile(id) {
    const t = this.tiles.get(id);
    const f = this.frames.get(id);
    if (!t || !f) return;
    const box = t.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(box.width * dpr));
    const h = Math.max(1, Math.round(box.height * dpr));
    if (t.canvas.width !== w || t.canvas.height !== h) {
      t.canvas.width = w;
      t.canvas.height = h;
    }
    const ctx = t.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#050707';
    ctx.fillRect(0, 0, w, h);
    const { bitmap, turns } = f;
    const sideways = turns % 2 === 1;
    const iw = sideways ? bitmap.height : bitmap.width;
    const ih = sideways ? bitmap.width : bitmap.height;
    const k = Math.min(w / iw, h / ih); // whole frame visible: an operator must see the edges
    ctx.translate(w / 2, h / 2);
    ctx.rotate((turns * Math.PI) / 2);
    ctx.drawImage(bitmap, (-bitmap.width * k) / 2, (-bitmap.height * k) / 2, bitmap.width * k, bitmap.height * k);
    t.el.classList.add('has-video');
  }

  updateLabels(now) {
    for (const d of this.devices) {
      const t = this.tiles.get(d.id);
      if (!t) continue;
      const f = this.frames.get(d.id);
      const age = f ? (now - f.at) / 1000 : null;
      const stale = !f || age * 1000 > STALE_MS;
      t.dot.classList.toggle('on', !stale);
      t.el.classList.toggle('stale', !!f && stale);
      t.age.textContent = !f ? 'NO VIDEO' : stale ? `LAST ${Math.round(age)}S AGO` : `LIVE · ${age.toFixed(1)}S`;
    }
    const online = this.devices.filter((d) => d.online ?? d.live).length;
    const live = [...this.frames.values()].filter((f) => now - f.at < STALE_MS).length;
    const rooms = this.map?.rooms?.length ?? 0;
    const walls = this.map?.walls?.length ?? 0;
    this.counts.online.textContent = pad(online);
    this.counts.live.textContent = pad(live);
    this.counts.rooms.textContent = pad(rooms);
    this.counts.walls.textContent = pad(walls);
  }

  // --- floor plan ------------------------------------------------------------

  bounds() {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const grow = (x, z) => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    };
    for (const r of this.map?.rooms ?? []) {
      for (const [x1, z1, x2, z2] of r.walls ?? []) { grow(x1, z1); grow(x2, z2); }
      for (const [x, z] of r.floor ?? []) grow(x, z);
    }
    const plan = this.map?.plan;
    if (plan?.placement && plan.widthM > 0) {
      for (const [px, pz] of [[0, 0], [plan.widthM, 0], [0, plan.heightM], [plan.widthM, plan.heightM]]) grow(...this.planToMap(px, pz));
    }
    if (this.map?.origin) grow(0, 0);
    for (const d of this.devices) if (d.pose) grow(d.pose.p[0], d.pose.p[2]);
    if (!Number.isFinite(minX)) return null;
    const padM = 1;
    return { minX: minX - padM, minZ: minZ - padM, maxX: maxX + padM, maxZ: maxZ + padM };
  }

  planToMap(px, pz) {
    const { yaw, t } = this.map.plan.placement;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [c * px + s * pz + t[0], -s * px + c * pz + t[2]];
  }

  hitDevice(x, y) {
    if (!this.view) return null;
    let best = null, bestD = 22;
    for (const d of this.devices) {
      if (!d.pose) continue;
      const [sx, sy] = this.toScreen(d.pose.p[0], d.pose.p[2]);
      const dist = Math.hypot(sx - x, sy - y);
      if (dist < bestD) { bestD = dist; best = d.id; }
    }
    return best;
  }

  toScreen(x, z) {
    const v = this.view;
    return [v.ox + x * v.k, v.oy + z * v.k];
  }

  drawPlan() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(box.width * dpr));
    const H = Math.max(1, Math.round(box.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const b = this.bounds();
    this.root.querySelector('.op-plan .op-empty').hidden = !!b;
    if (!b) {
      this.view = null;
      return;
    }
    // Fit: metres -> CSS px, centred.
    const cw = box.width, ch = box.height;
    const k = Math.min(cw / (b.maxX - b.minX), ch / (b.maxZ - b.minZ));
    const ox = (cw - (b.maxX - b.minX) * k) / 2 - b.minX * k;
    const oy = (ch - (b.maxZ - b.minZ) * k) / 2 - b.minZ * k;
    this.view = { k, ox, oy };
    ctx.scale(dpr, dpr);

    // Dot grid, 1 m.
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    for (let x = Math.ceil(b.minX); x <= b.maxX; x++) {
      for (let z = Math.ceil(b.minZ); z <= b.maxZ; z++) {
        const [sx, sy] = this.toScreen(x, z);
        ctx.fillRect(sx - 0.75, sy - 0.75, 1.5, 1.5);
      }
    }

    // The uploaded plan, faint, under everything.
    const plan = this.map?.plan;
    if (this.planImg && plan?.placement && plan.widthM > 0) {
      const { yaw, t } = plan.placement;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const sc = plan.widthM / this.planImg.naturalWidth;
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.setTransform(dpr * k * c * sc, dpr * -k * s * sc, dpr * k * s * sc, dpr * k * c * sc, dpr * (ox + k * t[0]), dpr * (oy + k * t[2]));
      ctx.drawImage(this.planImg, 0, 0);
      ctx.restore();
    }

    const rooms = this.map?.rooms ?? [];
    // Floors.
    for (const r of rooms) {
      if (!(r.floor?.length >= 3)) continue;
      ctx.beginPath();
      r.floor.forEach(([x, z], i) => (i ? ctx.lineTo(...this.toScreen(x, z)) : ctx.moveTo(...this.toScreen(x, z))));
      ctx.closePath();
      ctx.fillStyle = 'rgba(53,224,122,0.06)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(53,224,122,0.28)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // Walls, brighter the more scans confirmed them.
    ctx.lineCap = 'round';
    for (const r of rooms) {
      (r.walls ?? []).forEach(([x1, z1, x2, z2], i) => {
        const seen = r.seen?.[i] ?? 1;
        ctx.strokeStyle = `rgba(245,245,245,${seen >= 3 ? 1 : seen === 2 ? 0.78 : 0.55})`;
        ctx.lineWidth = Math.max(2, 0.12 * k);
        ctx.beginPath();
        ctx.moveTo(...this.toScreen(x1, z1));
        ctx.lineTo(...this.toScreen(x2, z2));
        ctx.stroke();
      });
    }
    // Doors and windows, drawn over their walls.
    for (const r of rooms) {
      for (const o of r.openings ?? []) {
        const [x1, z1, x2, z2] = o.s;
        ctx.strokeStyle = o.kind === 'door' ? RED : '#ffffff';
        ctx.lineWidth = Math.max(3, 0.16 * k);
        ctx.setLineDash(o.kind === 'window' ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(...this.toScreen(x1, z1));
        ctx.lineTo(...this.toScreen(x2, z2));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Room names in each room's top-left corner, clear of the devices in the
    // middle. A placed floor plan already carries its own names.
    if (!this.planImg) {
      ctx.font = '700 10px "Space Mono", ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(157,252,208,0.75)';
      for (const r of rooms) {
        const pts = r.floor?.length ? r.floor : (r.walls ?? []).flatMap(([x1, z1, x2, z2]) => [[x1, z1], [x2, z2]]);
        if (!pts.length) continue;
        const [sx, sy] = this.toScreen(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])));
        ctx.fillText(String(r.name ?? '').toUpperCase(), sx + 10, sy + 18);
      }
    }
    // Map origin.
    if (this.map?.origin) {
      const [sx, sy] = this.toScreen(0, 0);
      ctx.strokeStyle = RED;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx - 7, sy); ctx.lineTo(sx + 7, sy);
      ctx.moveTo(sx, sy - 7); ctx.lineTo(sx, sy + 7);
      ctx.stroke();
    }

    // Devices with view cones.
    const now = performance.now();
    for (const d of this.devices) {
      if (!d.pose) continue;
      const [sx, sy] = this.toScreen(d.pose.p[0], d.pose.p[2]);
      const [fx, fz] = heading(d.pose.q);
      const online = d.online ?? d.live;
      const placed = d.kind !== 'lidar' || d.aligned !== false;
      const f = this.frames.get(d.id);
      const streaming = f && now - f.at < STALE_MS;
      const sel = d.id === this.selected;
      ctx.globalAlpha = online && placed ? 1 : 0.35;
      // ~60° wedge, 1.6 m long.
      const r = Math.max(28, 1.6 * k);
      const a = Math.atan2(fz, fx);
      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      grad.addColorStop(0, sel ? 'rgba(215,25,33,0.55)' : 'rgba(200,255,58,0.45)');
      grad.addColorStop(1, 'rgba(200,255,58,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, r, a - Math.PI / 6, a + Math.PI / 6);
      ctx.closePath();
      ctx.fill();
      // Body.
      ctx.beginPath();
      ctx.arc(sx, sy, sel ? 8 : 6, 0, Math.PI * 2);
      ctx.fillStyle = sel ? RED : LIME;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      if (streaming) {
        ctx.beginPath();
        ctx.arc(sx + 9, sy - 9, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = RED;
        ctx.fill();
      }
      // Name label on the side away from the cone, kept inside the canvas.
      ctx.font = '700 10px "Space Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      const text = `${d.name.toUpperCase()}${placed ? '' : ' · ?'}`;
      const tw = ctx.measureText(text).width;
      const lx = Math.min(Math.max(sx, tw / 2 + 6), cw - tw / 2 - 6);
      const ly = Math.min(Math.max(sy + (fz > 0 ? -16 : 22), 14), ch - 6);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(lx - tw / 2 - 5, ly - 11, tw + 10, 15);
      ctx.fillStyle = sel ? RED : LIME;
      ctx.fillText(text, lx, ly);
      ctx.globalAlpha = 1;
    }
  }

  render(now) {
    // Floor plan: redraw when data changed (devices move at ~5 Hz).
    if (this.dirty) {
      this.dirty = false;
      this.drawPlan();
    }
    if (now - this.lastLabels > 250) {
      this.lastLabels = now;
      this.updateLabels(now);
      this.drawPlan(); // stale/streaming markers age with time, not messages
    }
  }

  // Tile canvases are sized from layout; redraw them after the wall reflows.
  relayout() {
    for (const id of this.frames.keys()) this.drawTile(id);
    this.dirty = true;
  }
}

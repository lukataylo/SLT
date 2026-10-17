import { convexHull, fuseSegments, invert, polygonWalls, reinforce, register, sameWall, segLength, transformSegment } from '../shared/planes.js';

// Walls confirmed by at least this many scan sessions anchor alignment, once
// there are enough of them to align against.
const REINFORCED_SEEN = 2;
const MIN_ANCHOR_LENGTH = 4; // metres
const CLOUD_VOXEL = 0.05; // metres: one splat per 5 cm cell
const MAX_CLOUD_POINTS = 300000; // per room

const round = (v, k = 1000) => Math.round(v * k) / k;

function emptyRoom({ id, name, origin, planRoomId = null, createdAt }) {
  return { id, name, origin, planRoomId, createdAt, base: [], openings: [], floor: [], cloud: new Map() };
}

// Doors and windows are reinforced like walls: the same opening seen again
// bumps `seen` once per session and widens its height range.
function reinforceOpenings(base, observed) {
  const out = base.map((o) => ({ ...o, s: [...o.s] }));
  const confirmed = new Set();
  for (const o of observed) {
    const hit = out.find((b) => b.kind === o.kind && sameWall(b.s, o.s));
    if (!hit) {
      out.push({ kind: o.kind, s: [...o.s], y0: o.y0, y1: o.y1, seen: 1 });
      continue;
    }
    hit.s = fuseSegments(hit.s, o.s, segLength(hit.s) * Math.min(hit.seen, 20), segLength(o.s));
    hit.y0 = Math.min(hit.y0, o.y0);
    hit.y1 = Math.max(hit.y1, o.y1);
    if (!confirmed.has(hit)) {
      confirmed.add(hit);
      hit.seen += 1;
    }
  }
  return out;
}

// The shared floor plan, in one fixed map frame, organised into rooms.
//
// `origin` records the scan that founded the frame; once set it only goes away
// with an explicit map reset. Each room has its own local origin (where the
// phone stood when the room was created) and, optionally, a link to a room on
// an uploaded floor plan. Within a room, `base` walls/openings carry a `seen`
// count of the scan sessions that confirmed them; phones currently scanning
// contribute live observations on top, committed into the base when they leave.
export class LiveMap {
  constructor({ rooms = [], walls = null, origin = null, plan = null, onChange = null, onCloudChange = null } = {}) {
    this.origin = origin;
    this.plan = plan;
    this.onChange = onChange;
    this.onCloudChange = onCloudChange;
    this.contributions = new Map();
    this.version = 0;
    this.rooms = rooms.map((r) => ({
      ...emptyRoom(r),
      base: (r.walls ?? []).map((w) => (Array.isArray(w) ? { s: w, seen: 1 } : w)),
      openings: r.openings ?? [],
      floor: r.floor ?? [],
      cloud: cloudFromFlat(r.cloud ?? []),
    }));
    // Files written before rooms existed held one flat wall list.
    if (walls?.length && !this.rooms.length) {
      this.rooms.push({ ...emptyRoom({ id: 'r1', name: 'Room 1', origin: [0, 0], createdAt: origin?.at ?? null }), base: walls.map((w) => (Array.isArray(w) ? { s: w, seen: 1 } : w)) });
    }
    this.nextRoom = 1 + Math.max(0, ...this.rooms.map((r) => Number(String(r.id).slice(1)) || 0));
    this.current = new Map();
    this.rebuild({ silent: true });
  }

  room(id) {
    return this.rooms.find((r) => r.id === id) ?? null;
  }

  get walls() {
    return [...this.current.values()].flatMap((c) => c.walls.map((w) => w.s));
  }

  found(origin) {
    if (this.origin) throw new Error('map origin is already fixed');
    this.origin = origin;
    if (!this.rooms.length) this.createRoom({ name: 'Room 1', origin: [0, 0], at: origin.at });
    this.changed();
  }

  createRoom({ name, origin, planRoomId = null, at = new Date().toISOString() }) {
    const id = `r${this.nextRoom++}`;
    const room = emptyRoom({ id, name: String(name || `Room ${this.nextRoom - 1}`).slice(0, 40), origin, planRoomId, createdAt: at });
    this.rooms.push(room);
    this.rebuild();
    return room;
  }

  // The room a point on the floor belongs to: the one whose scanned floor
  // contains it, else the room whose origin is nearest.
  roomAt([x, z]) {
    const inside = this.rooms.find((r) => r.floor.length >= 3 && pointInHull([x, z], r.floor));
    if (inside) return inside;
    let best = null;
    let bestD = Infinity;
    for (const r of this.rooms) {
      const d = Math.hypot(r.origin[0] - x, r.origin[1] - z);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  // Walls to align `peerId` against: everyone else's evidence across all
  // rooms, preferring walls that several sessions have confirmed.
  anchorsFor(peerId) {
    const all = this.rooms.flatMap((room) => {
      const others = [...this.contributions].filter(([id, c]) => id !== peerId && c.roomId === room.id).flatMap(([, c]) => c.walls);
      return reinforce(room.base, others);
    });
    const strong = all.filter((w) => w.seen >= REINFORCED_SEEN);
    const strongLength = strong.reduce((sum, w) => sum + segLength(w.s), 0);
    return (strongLength >= MIN_ANCHOR_LENGTH ? strong : all).map((w) => w.s);
  }

  setContribution(peerId, contribution) {
    this.contributions.set(peerId, contribution);
    this.rebuild();
  }

  commit(peerId) {
    const c = this.contributions.get(peerId);
    if (!c) return;
    this.contributions.delete(peerId);
    const room = this.room(c.roomId);
    if (room) {
      room.base = reinforce(room.base, c.walls);
      room.openings = reinforceOpenings(room.openings, c.openings);
      room.floor = convexHull([...room.floor, ...c.floor]);
    }
    this.rebuild();
  }

  commitAll() {
    for (const id of [...this.contributions.keys()]) this.commit(id);
  }

  resetRoom(roomId) {
    const room = this.room(roomId);
    if (!room) return false;
    Object.assign(room, { base: [], openings: [], floor: [], cloud: new Map() });
    for (const [id, c] of this.contributions) if (c.roomId === roomId) this.contributions.delete(id);
    this.rebuild();
    return true;
  }

  resetAll() {
    this.origin = null;
    this.rooms = [];
    this.nextRoom = 1;
    this.contributions.clear();
    if (this.plan) this.plan.placement = null;
    this.rebuild();
  }

  // Adds coloured LiDAR points (map frame) to a room's cloud, one per 5 cm
  // voxel. Each point is [x, y, z, r, g, b, nx, ny, nz]: true camera colour and
  // the surface normal (×127), so viewers can draw it as an oriented splat.
  // A voxel seen again blends its colour. Returns only new points.
  addCloud(roomId, points, colors = [], normals = []) {
    const room = this.room(roomId);
    const added = { points: [], colors: [], normals: [] };
    if (!room) return added;
    for (let i = 0; i + 2 < points.length; i += 3) {
      const [x, y, z] = [points[i], points[i + 1], points[i + 2]];
      if (![x, y, z].every(Number.isFinite)) continue;
      const rgb = [0, 1, 2].map((k) => clampInt(colors[i + k], 0, 255, 150));
      const n = [0, 1, 2].map((k) => clampInt(normals[i + k], -127, 127, 0));
      const key = `${Math.round(x / CLOUD_VOXEL)},${Math.round(y / CLOUD_VOXEL)},${Math.round(z / CLOUD_VOXEL)}`;
      const prev = room.cloud.get(key);
      if (prev) {
        for (let k = 0; k < 3; k++) prev[3 + k] = Math.round(prev[3 + k] * 0.7 + rgb[k] * 0.3);
        continue;
      }
      if (room.cloud.size >= MAX_CLOUD_POINTS) continue;
      const p = [round(x, 1000), round(y, 1000), round(z, 1000)];
      room.cloud.set(key, [...p, ...rgb, ...n]);
      added.points.push(...p);
      added.colors.push(...rgb);
      added.normals.push(...n);
    }
    if (added.points.length) this.onCloudChange?.(this);
    return added;
  }

  // Per-room clouds as flat arrays, for shared/cloud.js encodeClouds.
  cloudRooms() {
    return this.rooms.map((r) => {
      const pts = [...r.cloud.values()];
      return { id: r.id, points: pts.flatMap((p) => p.slice(0, 3)), colors: pts.flatMap((p) => p.slice(3, 6)), normals: pts.flatMap((p) => p.slice(6, 9)) };
    });
  }

  loadClouds(rooms) {
    for (const { id, points, colors, normals } of rooms) {
      const room = this.room(id);
      if (!room) continue;
      for (let i = 0; i + 2 < points.length; i += 3) {
        const p = [points[i], points[i + 1], points[i + 2], colors[i], colors[i + 1], colors[i + 2], normals[i], normals[i + 1], normals[i + 2]];
        room.cloud.set(p.slice(0, 3).map((v) => Math.round(v / CLOUD_VOXEL)).join(','), p);
      }
    }
  }

  // --- Floor plan link -------------------------------------------------------

  setPlan(plan) {
    this.plan = plan;
    this.changed();
  }

  setPlacement(placement) {
    if (!this.plan) return false;
    this.plan.placement = placement;
    this.changed();
    return true;
  }

  // Lays the plan onto the scanned map by matching scanned walls (partial)
  // into the plan's room outlines (complete), then inverting.
  autoPlace() {
    if (!this.plan?.rooms?.length) return { error: 'The plan has no rooms drawn yet' };
    const scanned = this.walls;
    if (scanned.length < 2) return { error: 'Scan at least two walls first' };
    const planWalls = polygonWalls(this.plan.rooms.map((r) => r.polygon));
    const fit = register(scanned, planWalls);
    if (!fit) return { error: 'Scanned walls do not cover two directions yet' };
    if (fit.ambiguous || fit.inlierFraction < 0.6) {
      return { error: 'No confident match yet; scan more walls', inlierFraction: fit.inlierFraction, ambiguous: fit.ambiguous };
    }
    const placement = invert({ yaw: fit.yaw, t: [fit.t[0], 0, fit.t[2]] });
    placement.t[1] = 0;
    // Remembered so the designer can show how confident a saved placement is.
    this.plan.match = { inlierFraction: fit.inlierFraction, at: new Date().toISOString() };
    this.setPlacement(placement);
    return { placement, inlierFraction: fit.inlierFraction, ambiguous: false };
  }

  // Plan room outlines in map coordinates (once the plan is placed).
  planRoomWalls(planRoomId) {
    const room = this.plan?.rooms?.find((r) => r.id === planRoomId);
    if (!room || !this.plan.placement) return [];
    return polygonWalls([room.polygon]).map((s) => transformSegment(s, this.plan.placement));
  }

  // --- State -------------------------------------------------------------------

  // Each live session previews as one more confirmation of what it sees.
  rebuild({ silent = false } = {}) {
    this.current = new Map(
      this.rooms.map((room) => {
        let walls = room.base;
        let openings = room.openings;
        let floor = room.floor;
        for (const c of this.contributions.values()) {
          if (c.roomId !== room.id) continue;
          walls = reinforce(walls, c.walls);
          openings = reinforceOpenings(openings, c.openings);
          floor = c.floor.length ? convexHull([...floor, ...c.floor]) : floor;
        }
        return [room.id, { walls, openings, floor }];
      }),
    );
    this.version++;
    if (!silent) this.onChange?.(this);
  }

  changed() {
    this.version++;
    this.onChange?.(this);
  }

  toJSON() {
    const rooms = this.rooms.map((room) => {
      const cur = this.current.get(room.id) ?? { walls: [], openings: [], floor: [] };
      return {
        id: room.id,
        name: room.name,
        origin: room.origin,
        planRoomId: room.planRoomId,
        createdAt: room.createdAt,
        walls: cur.walls.map((w) => w.s.map((v) => round(v))),
        seen: cur.walls.map((w) => w.seen),
        openings: cur.openings.map((o) => ({ kind: o.kind, s: o.s.map((v) => round(v)), y0: round(o.y0), y1: round(o.y1), seen: o.seen })),
        floor: cur.floor.map(([x, z]) => [round(x), round(z)]),
        cloudPoints: room.cloud.size,
      };
    });
    return {
      version: this.version,
      origin: this.origin,
      plan: this.plan,
      rooms,
      walls: rooms.flatMap((r) => r.walls),
      seen: rooms.flatMap((r) => r.seen),
    };
  }

  // What gets saved: only committed evidence, never live previews.
  toFile() {
    return {
      origin: this.origin,
      plan: this.plan,
      rooms: this.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        origin: r.origin,
        planRoomId: r.planRoomId,
        createdAt: r.createdAt,
        walls: r.base,
        openings: r.openings,
        floor: r.floor,
      })),
    };
  }
}

// Older map files kept an uncoloured xyz cloud inline.
function cloudFromFlat(flat) {
  const cloud = new Map();
  for (let i = 0; i + 2 < flat.length; i += 3) {
    const p = [flat[i], flat[i + 1], flat[i + 2], 150, 150, 150, 0, 0, 0];
    cloud.set(p.slice(0, 3).map((v) => Math.round(v / CLOUD_VOXEL)).join(','), p);
  }
  return cloud;
}

function clampInt(v, lo, hi, fallback) {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback;
}

function pointInHull(p, hull) {
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) return false;
  }
  return true;
}

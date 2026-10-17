// Floor-plan geometry shared by the server, the web client and the tests.
//
// Walls are vectorised as 2D segments [x1, z1, x2, z2] on the floor plane
// (metres, map frame, Y up dropped). An alignment maps a phone's own tracking
// frame onto the map: rotate by `yaw` about +Y, then translate by `t` [x, y, z].
// Rotation follows three.js/ARKit: yaw > 0 turns counter-clockwise from above.

const DEG = Math.PI / 180;

export const IDENTITY = Object.freeze({ yaw: 0, t: [0, 0, 0] });

export function transformPoint2(x, z, { yaw, t }) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c * x + s * z + t[0], -s * x + c * z + t[2]];
}

export function transformSegment(seg, T) {
  return [...transformPoint2(seg[0], seg[1], T), ...transformPoint2(seg[2], seg[3], T)];
}

function quatMul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function transformPose(pose, T) {
  const [x, y, z] = pose.p;
  const [px, pz] = transformPoint2(x, z, T);
  const h = T.yaw / 2;
  return { ...pose, p: [px, y + T.t[1], pz], q: quatMul([0, Math.sin(h), 0, Math.cos(h)], pose.q) };
}

export function isValidSegment(s) {
  return Array.isArray(s) && s.length === 4 && s.every(Number.isFinite) && segLength(s) > 0;
}

export const segLength = (s) => Math.hypot(s[2] - s[0], s[3] - s[1]);
const segAngle = (s) => Math.atan2(s[3] - s[1], s[2] - s[0]);
const segMid = (s) => [(s[0] + s[2]) / 2, (s[1] + s[3]) / 2];

// Smallest difference between two angles when directions repeat every `period`.
function angleDiff(a, b, period) {
  const d = (((a - b) % period) + period) % period;
  return Math.min(d, period - d);
}

// --- Vectorisation: merge overlapping collinear wall observations ----------

function canMerge(a, b, { angleTol, distTol, gapTol }) {
  if (angleDiff(segAngle(a), segAngle(b), Math.PI) > angleTol) return false;
  const [ref, other] = segLength(a) >= segLength(b) ? [a, b] : [b, a];
  const ang = segAngle(ref);
  const u = [Math.cos(ang), Math.sin(ang)];
  const n = [-u[1], u[0]];
  const o = [ref[0], ref[1]];
  const along = (x, z) => (x - o[0]) * u[0] + (z - o[1]) * u[1];
  const across = (x, z) => Math.abs((x - o[0]) * n[0] + (z - o[1]) * n[1]);
  if (across(other[0], other[1]) > distTol || across(other[2], other[3]) > distTol) return false;
  const r = [along(ref[0], ref[1]), along(ref[2], ref[3])].sort((p, q) => p - q);
  const s = [along(other[0], other[1]), along(other[2], other[3])].sort((p, q) => p - q);
  return Math.max(s[0] - r[1], r[0] - s[1]) < gapTol;
}

// Weighted best-fit line through both segments, spanning their union. Weights
// default to length; reinforcement passes heavier weights for confirmed walls.
function fuse(a, b, wa = segLength(a), wb = segLength(b)) {
  const la = wa;
  const lb = wb;
  // Average directions on the doubled angle so opposite-facing segments agree.
  const sa = 2 * segAngle(a);
  const sb = 2 * segAngle(b);
  const ang = Math.atan2(la * Math.sin(sa) + lb * Math.sin(sb), la * Math.cos(sa) + lb * Math.cos(sb)) / 2;
  const u = [Math.cos(ang), Math.sin(ang)];
  const ma = segMid(a);
  const mb = segMid(b);
  const c = [(ma[0] * la + mb[0] * lb) / (la + lb), (ma[1] * la + mb[1] * lb) / (la + lb)];
  const ends = [
    [a[0], a[1]],
    [a[2], a[3]],
    [b[0], b[1]],
    [b[2], b[3]],
  ];
  const ts = ends.map(([x, z]) => (x - c[0]) * u[0] + (z - c[1]) * u[1]);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  return [c[0] + u[0] * t0, c[1] + u[1] * t0, c[0] + u[0] * t1, c[1] + u[1] * t1];
}

export function mergeSegments(segments, { angleTol = 10 * DEG, distTol = 0.25, gapTol = 0.5, minLength = 0.3 } = {}) {
  const out = segments.filter((s) => isValidSegment(s) && segLength(s) >= minLength).map((s) => [...s]);
  const opts = { angleTol, distTol, gapTol };
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (canMerge(out[i], out[j], opts)) {
          out[i] = fuse(out[i], out[j]);
          out.splice(j, 1);
          changed = true;
          break;
        }
      }
    }
  }
  return out;
}

// --- Reinforcement: walls confirmed by repeated scans ----------------------
//
// Map walls are { s: [x1, z1, x2, z2], seen } where `seen` counts the separate
// scan sessions that observed the wall. A session that sees a wall again bumps
// `seen` once and nudges its position, weighted so one pass can't drag a wall
// that many sessions agree on.

const MAX_SEEN_WEIGHT = 20;

export function reinforce(base, observed, opts = {}) {
  const tol = { angleTol: 10 * DEG, distTol: 0.25, gapTol: 0.5, ...opts };
  const walls = base.map((w) => ({ s: [...w.s], seen: w.seen }));
  const confirmed = new Set();
  for (const seg of mergeSegments(observed, opts)) {
    const hit = walls.findIndex((w) => canMerge(w.s, seg, tol));
    if (hit < 0) {
      walls.push({ s: seg, seen: 1 });
      continue;
    }
    const w = walls[hit];
    w.s = fuse(w.s, seg, segLength(w.s) * Math.min(w.seen, MAX_SEEN_WEIGHT), segLength(seg));
    if (!confirmed.has(w)) {
      confirmed.add(w);
      w.seen += 1;
    }
  }
  // Grown walls can now overlap each other; fold them together, keeping the
  // stronger count (they describe the same evidence, so don't add them).
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < walls.length && !changed; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        if (!canMerge(walls[i].s, walls[j].s, tol)) continue;
        const [a, b] = [walls[i], walls[j]];
        a.s = fuse(a.s, b.s, segLength(a.s) * Math.min(a.seen, MAX_SEEN_WEIGHT), segLength(b.s) * Math.min(b.seen, MAX_SEEN_WEIGHT));
        a.seen = Math.max(a.seen, b.seen);
        walls.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  return walls;
}

// --- Registration: where is this phone's floor plan within the map? --------

// Buildings are mostly rectilinear, so wall directions repeat every 90°.
function dominantAngle(segs) {
  let sx = 0;
  let sy = 0;
  for (const s of segs) {
    const w = segLength(s);
    sx += w * Math.cos(4 * segAngle(s));
    sy += w * Math.sin(4 * segAngle(s));
  }
  return Math.atan2(sy, sx) / 4;
}

function pointSegDist(px, pz, s) {
  const dx = s[2] - s[0];
  const dz = s[3] - s[1];
  const l2 = dx * dx + dz * dz;
  const k = Math.max(0, Math.min(1, ((px - s[0]) * dx + (pz - s[1]) * dz) / l2));
  return Math.hypot(px - (s[0] + k * dx), pz - (s[1] + k * dz));
}

function samplePoints(segs, step) {
  const pts = [];
  for (const s of segs) {
    const n = Math.max(1, Math.round(segLength(s) / step));
    const ang = segAngle(s);
    for (let i = 0; i < n; i++) {
      const k = (i + 0.5) / n;
      pts.push({ x: s[0] + k * (s[2] - s[0]), z: s[1] + k * (s[3] - s[1]), ang });
    }
  }
  return pts;
}

// Nearest map wall running the same way as the sample, within `maxDist`.
function match(p, T, map, maxDist, angleTol) {
  const [x, z] = transformPoint2(p.x, p.z, T);
  const ang = p.ang - T.yaw;
  let best = null;
  let bestD = maxDist;
  for (const m of map) {
    if (angleDiff(ang, m.ang, Math.PI) > angleTol) continue;
    const d = pointSegDist(x, z, m.s);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best && { x, z, m: best, d: bestD };
}

function evaluate(samples, T, map, step, inlierDist, angleTol) {
  let inliers = 0;
  let sq = 0;
  for (const p of samples) {
    const hit = match(p, T, map, inlierDist, angleTol);
    if (hit) {
      inliers++;
      sq += hit.d * hit.d;
    }
  }
  return {
    inlierFraction: inliers / samples.length,
    inlierLength: inliers * step,
    rms: inliers ? Math.sqrt(sq / inliers) : Infinity,
  };
}

function solve3(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-9) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

// Point-to-line ICP in the floor plane, linearised in (dyaw, dx, dz).
function refine(samples, T, map, maxDist, angleTol, iterations = 15) {
  let cur = T;
  for (let it = 0; it < iterations; it++) {
    const A = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const b = [0, 0, 0];
    for (const p of samples) {
      const hit = match(p, cur, map, maxDist, angleTol);
      if (!hit) continue;
      const { n, d } = hit.m;
      const r = n[0] * hit.x + n[1] * hit.z - d;
      const J = [n[0] * hit.z - n[1] * hit.x, n[0], n[1]];
      for (let i = 0; i < 3; i++) {
        b[i] -= J[i] * r;
        for (let k = 0; k < 3; k++) A[i][k] += J[i] * J[k];
      }
    }
    const delta = solve3(A, b);
    if (!delta) break;
    const [dyaw, dx, dz] = delta;
    const [tx, tz] = transformPoint2(cur.t[0], cur.t[2], { yaw: dyaw, t: [dx, 0, dz] });
    cur = { yaw: cur.yaw + dyaw, t: [tx, cur.t[1], tz] };
    if (Math.abs(dyaw) < 1e-5 && Math.hypot(dx, dz) < 1e-4) break;
  }
  return cur;
}

// Strongest offsets along a wall normal: each pair of parallel local/map walls
// votes for how far the phone's walls must shift to land on the map's.
function offsetPeaks(votes, bin = 0.1, k = 4) {
  const hist = new Map();
  for (const { c, w } of votes) {
    const i = Math.round(c / bin);
    for (const j of [i - 1, i, i + 1]) hist.set(j, (hist.get(j) ?? 0) + (j === i ? w : w / 2));
  }
  const peaks = [];
  for (const [i] of [...hist].sort((a, b) => b[1] - a[1])) {
    if (peaks.every((p) => Math.abs(p - i * bin) > 0.3)) peaks.push(i * bin);
    if (peaks.length === k) break;
  }
  return peaks;
}

const MIN_DECISIVE_LENGTH = 1; // metres

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Finds the yaw + translation that lays a phone's wall segments (its own
 * frame) onto the map's wall segments. Returns null when the phone hasn't seen
 * enough wall in two directions to pin down both axes.
 */
export function register(local, map, { initial = null, step = 0.2, inlierDist = 0.3, angleTol = 15 * DEG } = {}) {
  local = local.filter(isValidSegment);
  map = map.filter(isValidSegment);
  if (!local.length || !map.length) return null;

  const mapEntries = map.map((s) => {
    const ang = segAngle(s);
    const n = [-Math.sin(ang), Math.cos(ang)];
    const [mx, mz] = segMid(s);
    return { s, ang, n, d: n[0] * mx + n[1] * mz };
  });
  const samples = samplePoints(local, step);
  const domLocal = dominantAngle(local);
  const domMap = dominantAngle(map);
  const uA = [Math.cos(domMap), Math.sin(domMap)];
  const families = [
    { n: [-uA[1], uA[0]], ang: domMap },
    { n: uA, ang: domMap + Math.PI / 2 },
  ];

  const hypotheses = [];
  if (initial) hypotheses.push(initial);
  for (let k = 0; k < 4; k++) {
    const yaw = wrapAngle(domLocal - domMap + (k * Math.PI) / 2);
    const peaks = families.map((f) => {
      const votes = [];
      for (const l of local) {
        if (angleDiff(segAngle(l) - yaw, f.ang, Math.PI) > angleTol) continue;
        const [lx, lz] = transformPoint2(...segMid(l), { yaw, t: [0, 0, 0] });
        for (const m of mapEntries) {
          if (angleDiff(m.ang, f.ang, Math.PI) > angleTol) continue;
          const [mx, mz] = segMid(m.s);
          const c = f.n[0] * (mx - lx) + f.n[1] * (mz - lz);
          votes.push({ c, w: Math.min(segLength(l), segLength(m.s)) });
        }
      }
      return offsetPeaks(votes);
    });
    // Both wall directions are needed; one direction leaves the other axis free.
    if (!peaks[0].length || !peaks[1].length) continue;
    for (const a of peaks[0]) {
      for (const b of peaks[1]) {
        const t = [a * families[0].n[0] + b * families[1].n[0], 0, a * families[0].n[1] + b * families[1].n[1]];
        hypotheses.push({ yaw, t });
      }
    }
  }
  if (!hypotheses.length) return null;

  const scored = hypotheses
    .map((T) => ({ T, ...evaluate(samples, T, mapEntries, step, inlierDist, angleTol) }))
    .sort((a, b) => b.inlierFraction - a.inlierFraction || a.rms - b.rms)
    .slice(0, 6)
    .map(({ T }) => {
      const R = refine(samples, T, mapEntries, inlierDist * 2, angleTol);
      return { T: R, ...evaluate(samples, R, mapEntries, step, inlierDist, angleTol) };
    })
    .sort((a, b) => b.inlierFraction - a.inlierFraction || a.rms - b.rms);

  const [best, ...rest] = scored;
  // A symmetric room fits several placements equally well; report that rather
  // than guess, so the phone can keep scanning until something breaks the tie.
  // Judge by metres of wall that only the best placement explains: a single
  // interior wall is enough to tell an otherwise symmetric room apart.
  const ambiguous = rest.some(
    (r) =>
      best.inlierLength - r.inlierLength < MIN_DECISIVE_LENGTH &&
      (angleDiff(r.T.yaw, best.T.yaw, 2 * Math.PI) > 10 * DEG ||
        Math.hypot(r.T.t[0] - best.T.t[0], r.T.t[2] - best.T.t[2]) > 0.5),
  );
  return { yaw: wrapAngle(best.T.yaw), t: best.T.t, inlierFraction: best.inlierFraction, inlierLength: best.inlierLength, rms: best.rms, ambiguous };
}

// --- Helpers for rooms, openings, floors and plans -------------------------

const DEFAULT_TOL = { angleTol: 10 * DEG, distTol: 0.25, gapTol: 0.5 };

// Whether two segments are observations of the same wall line.
export function sameWall(a, b, tol = DEFAULT_TOL) {
  return canMerge(a, b, tol);
}

export function fuseSegments(a, b, wa, wb) {
  return fuse(a, b, wa, wb);
}

// Inverse of an alignment: maps the target frame back onto the source frame.
export function invert({ yaw, t }) {
  const [x, z] = transformPoint2(t[0], t[2], { yaw: -yaw, t: [0, 0, 0] });
  return { yaw: -yaw, t: [-x, -(t[1] ?? 0), -z] };
}

// Andrew's monotone chain; points are [x, z]. Returns the hull counter-clockwise.
export function convexHull(points) {
  const pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function pointInPolygon([x, z], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Room outlines drawn on a floor plan, as wall segments (shared edges merged).
export function polygonWalls(polygons) {
  const segs = [];
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      segs.push([a[0], a[1], b[0], b[1]]);
    }
  }
  return mergeSegments(segs, { distTol: 0.15, gapTol: 0.1 });
}

// --- Doorways ---------------------------------------------------------------
//
// LiDAR sees an open door as a gap in a wall: two pieces of the same wall
// line with a door-sized space between them. A gap that a scanned door
// surface covers is a closed door; otherwise it's open.

const DOOR_MIN = 0.55; // metres
const DOOR_MAX = 1.8;

export function findDoorways(walls, doorOpenings = []) {
  const out = [];
  const segs = walls.filter(isValidSegment);
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [ref, other] = segLength(segs[i]) >= segLength(segs[j]) ? [segs[i], segs[j]] : [segs[j], segs[i]];
      if (angleDiff(segAngle(ref), segAngle(other), Math.PI) > 8 * DEG) continue;
      const ang = segAngle(ref);
      const u = [Math.cos(ang), Math.sin(ang)];
      const n = [-u[1], u[0]];
      const o = [ref[0], ref[1]];
      const along = (x, z) => (x - o[0]) * u[0] + (z - o[1]) * u[1];
      const across = (x, z) => Math.abs((x - o[0]) * n[0] + (z - o[1]) * n[1]);
      if (across(other[0], other[1]) > 0.15 || across(other[2], other[3]) > 0.15) continue;
      const r = [along(ref[0], ref[1]), along(ref[2], ref[3])].sort((p, q) => p - q);
      const s = [along(other[0], other[1]), along(other[2], other[3])].sort((p, q) => p - q);
      const [g0, g1] = s[0] >= r[1] ? [r[1], s[0]] : r[0] >= s[1] ? [s[1], r[0]] : [0, 0];
      const width = g1 - g0;
      if (width < DOOR_MIN || width > DOOR_MAX) continue;
      const seg = [o[0] + u[0] * g0, o[1] + u[1] * g0, o[0] + u[0] * g1, o[1] + u[1] * g1];
      // A third piece of wall lying across the gap means it isn't a gap.
      const mid = [(seg[0] + seg[2]) / 2, (seg[1] + seg[3]) / 2];
      const bridged = segs.some((w) => w !== ref && w !== other && pointSegDist(mid[0], mid[1], w) < 0.15);
      if (bridged || out.some((d) => Math.hypot((d.s[0] + d.s[2]) / 2 - mid[0], (d.s[1] + d.s[3]) / 2 - mid[1]) < 0.3)) continue;
      const closed = doorOpenings.some((d) => pointSegDist(mid[0], mid[1], d) < 0.4);
      out.push({ s: seg.map((v) => Math.round(v * 1000) / 1000), width: Math.round(width * 100) / 100, state: closed ? 'closed' : 'open' });
    }
  }
  return out;
}

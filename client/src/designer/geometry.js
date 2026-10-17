import { mergeSegments } from '../../../shared/planes.js';

// Placements are rigid 2D transforms on the floor, in the same convention as
// shared/planes.js: apply(x, z) = [c*x + s*z + tx, -s*x + c*z + tz]. Here they
// are kept as a 2x2 matrix + translation so they compose and invert easily.

export function fromPlacement({ yaw, t }) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { m: [c, s, -s, c], t: [t[0], t[2]] };
}

export function toPlacement(T) {
  return { yaw: Math.atan2(T.m[1], T.m[0]), t: [T.t[0], 0, T.t[1]] };
}

export function apply(T, [x, z]) {
  return [T.m[0] * x + T.m[1] * z + T.t[0], T.m[2] * x + T.m[3] * z + T.t[1]];
}

// F ∘ G: apply G first, then F.
export function compose(F, G) {
  const [a, b, c, d] = F.m;
  const [e, f, g, h] = G.m;
  return { m: [a * e + b * g, a * f + b * h, c * e + d * g, c * f + d * h], t: apply(F, G.t) };
}

export function invert(T) {
  const [a, b, c, d] = T.m;
  const m = [a, c, b, d]; // rotations: inverse is the transpose
  return { m, t: [-(m[0] * T.t[0] + m[1] * T.t[1]), -(m[2] * T.t[0] + m[3] * T.t[1])] };
}

export const translation = (dx, dz) => ({ m: [1, 0, 0, 1], t: [dx, dz] });

// Rotation by `theta` about point c, in the placement convention.
export function rotationAbout(theta, [cx, cz]) {
  const r = fromPlacement({ yaw: theta, t: [0, 0, 0] });
  return compose(translation(cx, cz), compose(r, translation(-cx, -cz)));
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % poly.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

export function polygonCentroid(poly) {
  const n = poly.length || 1;
  return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
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

// Room outlines as wall segments; shared edges between rooms collapse into one.
export function planWalls(rooms) {
  const edges = rooms.flatMap((r) => r.polygon.map((p, i) => [...p, ...r.polygon[(i + 1) % r.polygon.length]]));
  return mergeSegments(edges);
}

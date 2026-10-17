// Architectural door symbols for the server's `doorways`: door-sized gaps
// between pieces of the same wall line, `state` 'open' or 'closed'.
// Coordinates are map metres on the floor plane (x right, z down on a plan).

export function pointInPolygon([x, z], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const insideAnyRoom = (p, rooms) => rooms.some((r) => r.floor?.length >= 3 && pointInPolygon(p, r.floor));

/**
 * Hinge at the doorway's first end, the leaf standing at 90° into a room and
 * a quarter-circle swing to the other end. The leaf opens into whichever side
 * of the wall a scanned floor covers; if neither (or both), the first side.
 */
export function doorSwing(d, rooms = []) {
  const [x1, z1, x2, z2] = d.s;
  const w = Math.hypot(x2 - x1, z2 - z1) || d.width || 0.9;
  const ux = (x2 - x1) / w;
  const uz = (z2 - z1) / w;
  let nx = -uz;
  let nz = ux;
  const mx = (x1 + x2) / 2;
  const mz = (z1 + z2) / 2;
  const probe = (s) => [mx + s * nx * w * 0.5, mz + s * nz * w * 0.5];
  if (!insideAnyRoom(probe(1), rooms) && insideAnyRoom(probe(-1), rooms)) {
    nx = -nx;
    nz = -nz;
  }
  const from = Math.atan2(nz, nx); // leaf direction
  const to = Math.atan2(uz, ux); // closed position, along the wall
  let sweep = to - from;
  sweep = Math.atan2(Math.sin(sweep), Math.cos(sweep)); // ±90°
  return { hinge: [x1, z1], leaf: [x1 + nx * w, z1 + nz * w], end: [x2, z2], radius: w, from, sweep };
}

/** Points along the swing arc, hinge-centred, for line-based renderers. */
export function swingArc(sw, steps = 16) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = sw.from + (sw.sweep * i) / steps;
    pts.push([sw.hinge[0] + Math.cos(a) * sw.radius, sw.hinge[1] + Math.sin(a) * sw.radius]);
  }
  return pts;
}

// A closed doorway where a door surface was already scanned is drawn once,
// as that scanned door.
export function coveredByScannedDoor(d, rooms = []) {
  const mx = (d.s[0] + d.s[2]) / 2;
  const mz = (d.s[1] + d.s[3]) / 2;
  return rooms.some((r) =>
    (r.openings ?? []).some((o) => o.kind === 'door' && Math.hypot((o.s[0] + o.s[2]) / 2 - mx, (o.s[1] + o.s[3]) / 2 - mz) < 0.4),
  );
}

// Synthesises server -> admin messages (see the contract in main.js) so the
// portal can be developed and demoed without phones. Everything goes through
// the same `handle` function as live WebSocket messages.

const H = 2.6;

const ROOMS = [
  {
    id: 'r1',
    name: 'LIVING',
    origin: [0, 0],
    walls: [[0, 0, 5, 0], [5, 0, 5, 3], [0, 4.5, 3, 4.5], [4, 4.5, 5, 4.5], [0, 4.5, 0, 0]],
    openings: [
      { kind: 'window', s: [1, 0, 3.6, 0], y0: 0.9, y1: 2.2, seen: 2 },
      { kind: 'door', s: [3, 4.5, 4, 4.5], y0: 0, y1: 2.1, seen: 3 },
    ],
    floor: [[0, 0], [5, 0], [5, 4.5], [0, 4.5]],
  },
  {
    id: 'r2',
    name: 'KITCHEN',
    origin: [5, 0],
    walls: [[5, 0, 9, 0], [9, 0, 9, 7], [5, 7, 9, 7], [5, 3, 6.5, 3], [7.5, 3, 9, 3], [5, 4.5, 5, 7]],
    openings: [
      { kind: 'door', s: [6.5, 3, 7.5, 3], y0: 0, y1: 2.1, seen: 2 },
      { kind: 'window', s: [9, 4, 9, 6], y0: 1.0, y1: 2.2, seen: 1 },
    ],
    floor: [[5, 0], [9, 0], [9, 7], [5, 7]],
  },
  {
    id: 'r3',
    name: 'BEDROOM',
    origin: [0, 4.5],
    walls: [[0, 4.5, 0, 7], [0, 7, 5, 7], [5, 4.5, 5, 7]],
    openings: [{ kind: 'window', s: [0, 5, 0, 6.5], y0: 1.0, y1: 2.2, seen: 1 }],
    floor: [[0, 4.5], [5, 4.5], [5, 7], [0, 7]],
  },
];

// Furniture blobs give the cloud some mid-height structure, in real colours.
const FURNITURE = [
  { room: 'r1', x: [0.6, 2.6], z: [1.2, 2.1], h: 0.8, rgb: [92, 96, 104] }, // charcoal sofa
  { room: 'r1', x: [3.4, 4.6], z: [0.3, 0.8], h: 1.9, rgb: [176, 132, 88] }, // oak bookcase
  { room: 'r2', x: [5.2, 8.8], z: [0.2, 0.8], h: 0.95, rgb: [236, 236, 230] }, // white counter
  { room: 'r2', x: [6.4, 7.6], z: [4.6, 5.8], h: 0.75, rgb: [120, 84, 52] }, // walnut table
  { room: 'r3', x: [0.3, 2.3], z: [5.2, 6.8], h: 0.5, rgb: [214, 214, 220] }, // bed linen
];

// Painted walls per room, a rug, and oak floorboards.
const WALL_RGB = { r1: [174, 190, 170], r2: [238, 236, 228], r3: [206, 178, 150] };
const RUG = { room: 'r1', x: [1.2, 3.6], z: [2.4, 3.8], rgb: [168, 64, 52] };

const PATHS = [
  [[1.5, 1.5], [4, 1.5], [4, 3.8], [1.2, 3.8]],
  [[6, 1.5], [8.2, 1.5], [8.2, 5.5], [6, 5.5], [7, 3.5]],
  [[1, 5.6], [4, 5.6], [4, 6.4], [1, 6.4]],
  [[7.5, 6.2], [5.8, 6.2], [5.8, 4.2], [7.5, 4.2]],
];

const rand = (a, b) => a + Math.random() * (b - a);
const noise = (n) => (Math.random() * 2 - 1) * n;

let planUrl = null;
function planImage() {
  if (planUrl) return planUrl;
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 700;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 900, 700);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 6;
  for (const r of ROOMS) for (const [x1, z1, x2, z2] of r.walls) {
    ctx.beginPath();
    ctx.moveTo(x1 * 100, z1 * 100);
    ctx.lineTo(x2 * 100, z2 * 100);
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.font = '28px monospace';
  for (const r of ROOMS) ctx.fillText(r.name, r.floor[0][0] * 100 + 30, r.floor[0][1] * 100 + 50);
  planUrl = c.toDataURL('image/png');
  return planUrl;
}

function mapJson(version, seenBoost) {
  const rooms = ROOMS.map((r, ri) => ({
    id: r.id,
    name: r.name,
    origin: r.origin,
    createdAt: new Date(Date.now() - (3 - ri) * 3600e3).toISOString(),
    walls: r.walls,
    seen: r.walls.map((_, i) => Math.min(1 + ((i + ri + seenBoost) % 4), 5)),
    openings: r.openings,
    floor: r.floor,
    planRoomId: `plan-${r.id}`,
  }));
  return {
    version,
    origin: { by: 'IPHONE 17 PRO', at: new Date(Date.now() - 3 * 3600e3).toISOString() },
    rooms,
    walls: rooms.flatMap((r) => r.walls),
    seen: rooms.flatMap((r) => r.seen),
    plan: {
      id: 'plan-1',
      name: 'FLAT 4B',
      imageUrl: planImage(),
      widthM: 9,
      heightM: 7,
      rooms: ROOMS.map((r) => ({ id: `plan-${r.id}`, name: r.name, polygon: r.floor })),
      placement: { yaw: 0, t: [0, 0, 0] },
    },
  };
}

const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const N = 127;

// Points, colours and normals for one room, like a LiDAR phone sends them:
// one sample per 5 cm voxel of every surface, with a little tracking noise.
const STEP = 0.05;
function sampleRoom(room) {
  const points = [];
  const colors = [];
  const normals = [];
  const push = (x, y, z, rgb, nrm, jitter = 10) => {
    points.push(x + noise(0.008), y + noise(0.008), z + noise(0.008));
    const shade = noise(jitter);
    colors.push(clamp8(rgb[0] + shade), clamp8(rgb[1] + shade), clamp8(rgb[2] + shade));
    normals.push(...nrm);
  };
  const [[minX, minZ], , [maxX, maxZ]] = room.floor;
  const wallRgb = WALL_RGB[room.id] ?? [200, 200, 200];
  for (const [x1, z1, x2, z2] of room.walls) {
    const len = Math.hypot(x2 - x1, z2 - z1);
    // Wall normal points into the room (towards its floor centre).
    let nx = -(z2 - z1) / len;
    let nz = (x2 - x1) / len;
    const mx = (x1 + x2) / 2;
    const mz = (z1 + z2) / 2;
    if (nx * ((minX + maxX) / 2 - mx) + nz * ((minZ + maxZ) / 2 - mz) < 0) [nx, nz] = [-nx, -nz];
    const nrm = [Math.round(nx * N), 0, Math.round(nz * N)];
    for (let t = STEP / 2; t < len; t += STEP) {
      const x = x1 + ((x2 - x1) * t) / len;
      const z = z1 + ((z2 - z1) * t) / len;
      for (let y = STEP / 2; y < H; y += STEP) {
        const opening = room.openings.find((o) => {
          const [a1, b1, a2, b2] = o.s;
          const along = Math.hypot(x - a1, z - b1) + Math.hypot(x - a2, z - b2) - Math.hypot(a2 - a1, b2 - b1);
          return along < 0.05 && y > o.y0 && y < o.y1;
        });
        if (opening?.kind === 'window') push(x, y, z, [186 + y * 18, 214 + y * 8, 238], nrm, 6); // sky through glass
        else if (opening) continue;
        else if (y < 0.1) push(x, y, z, [52, 48, 44], nrm, 4); // dark skirting
        else push(x, y, z, wallRgb, nrm, 7);
      }
    }
  }
  for (let x = minX + STEP / 2; x < maxX; x += STEP) {
    for (let z = minZ + STEP / 2; z < maxZ; z += STEP) {
      const rug = RUG.room === room.id && x > RUG.x[0] && x < RUG.x[1] && z > RUG.z[0] && z < RUG.z[1];
      // Oak boards 18 cm wide, each a slightly different tone, with dark seams.
      const board = Math.floor(x / 0.18);
      const tone = ((board * 37) % 11) - 5;
      const seam = !rug && x / 0.18 - board < 0.12;
      const rgb = rug ? RUG.rgb : seam ? [104, 76, 50] : [168 + tone * 4, 122 + tone * 3, 78 + tone * 2];
      push(x, rug ? 0.012 : 0, z, rgb, [0, N, 0], rug ? 14 : 6);
    }
  }
  for (const f of FURNITURE.filter((f) => f.room === room.id)) {
    for (let x = f.x[0]; x <= f.x[1]; x += STEP) for (let z = f.z[0]; z <= f.z[1]; z += STEP) push(x, f.h, z, f.rgb, [0, N, 0], 8);
    for (let y = STEP / 2; y < f.h; y += STEP) {
      for (let x = f.x[0]; x <= f.x[1]; x += STEP) {
        push(x, y, f.z[0], f.rgb.map((c) => c * 0.78), [0, 0, -N], 8);
        push(x, y, f.z[1], f.rgb.map((c) => c * 0.78), [0, 0, N], 8);
      }
      for (let z = f.z[0]; z <= f.z[1]; z += STEP) {
        push(f.x[0], y, z, f.rgb.map((c) => c * 0.7), [-N, 0, 0], 8);
        push(f.x[1], y, z, f.rgb.map((c) => c * 0.7), [N, 0, 0], 8);
      }
    }
  }
  return { points, colors, normals };
}

// A fake camera frame: what a phone in this room might see. A phone held in
// portrait still delivers a landscape sensor image, rotated a quarter-turn
// anticlockwise from upright, exactly as ARKit's camera does.
async function fakeFrame(room, name, t, portrait = false) {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 240;
  const ctx = c.getContext('2d');
  if (portrait) {
    const up = await uprightPortrait(room, name, t);
    const out = document.createElement('canvas');
    out.width = 320;
    out.height = 240;
    const o = out.getContext('2d');
    o.translate(0, 240);
    o.rotate(-Math.PI / 2);
    o.drawImage(up, 0, 0);
    const blob = await new Promise((res) => out.toBlob(res, 'image/jpeg', 0.8));
    return new Uint8Array(await blob.arrayBuffer());
  }
  const [r, g, b] = WALL_RGB[room?.id] ?? [180, 180, 180];
  const wall = ctx.createLinearGradient(0, 0, 0, 150);
  wall.addColorStop(0, `rgb(${r - 30},${g - 30},${b - 30})`);
  wall.addColorStop(1, `rgb(${r},${g},${b})`);
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, 320, 150);
  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = `rgb(${160 + (i % 3) * 8},${116 + (i % 3) * 6},${74 + (i % 3) * 4})`;
    ctx.beginPath();
    ctx.moveTo(160 + (i - 9) * 6, 150);
    ctx.lineTo(160 + (i - 8) * 6, 150);
    ctx.lineTo(160 + (i - 8) * 40, 240);
    ctx.lineTo(160 + (i - 9) * 40, 240);
    ctx.fill();
  }
  ctx.fillStyle = '#c4def0';
  ctx.fillRect(40 + (Math.sin(t / 2000) * 30), 40, 90, 70); // a window, drifting as the phone turns
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  ctx.strokeRect(40 + (Math.sin(t / 2000) * 30), 40, 90, 70);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 214, 320, 26);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px monospace';
  ctx.fillText(`${name.toUpperCase()} · ${room?.name ?? '—'} · ${new Date(t).toLocaleTimeString()}`, 8, 232);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
  return new Uint8Array(await blob.arrayBuffer());
}

// What a portrait-held phone sees, upright (240 x 320): a tall doorway.
async function uprightPortrait(room, name, t) {
  const c = document.createElement('canvas');
  c.width = 240;
  c.height = 320;
  const ctx = c.getContext('2d');
  const [r, g, b] = WALL_RGB[room?.id] ?? [180, 180, 180];
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, 240, 230);
  ctx.fillStyle = '#8b6744';
  ctx.fillRect(0, 230, 240, 90);
  ctx.fillStyle = '#3a2a1c';
  ctx.fillRect(70 + Math.sin(t / 1800) * 12, 40, 100, 190); // door
  ctx.fillStyle = '#d8c070';
  ctx.beginPath();
  ctx.arc(155 + Math.sin(t / 1800) * 12, 140, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, 240, 26);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 12px monospace';
  ctx.fillText(`▲ UP · ${name.toUpperCase()} · PORTRAIT`, 8, 17);
  return c;
}

// q_a * q_b for [x, y, z, w] quaternions.
function qmul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
// Camera of a phone held upright in portrait, looking ahead along -Z: camera
// +x (towards the phone's bottom edge) points down; a -90° roll about Z.
const PORTRAIT = [0, 0, -Math.SQRT1_2, Math.SQRT1_2];

export function startMock(handle, handleFrame) {
  let version = 1;
  handle({ t: 'admin', map: mapJson(version, 0), devices: [] });

  const devices = [
    { id: 'p1', name: 'iPhone 17 Pro', kind: 'lidar', role: 'move', aligned: true, roomId: 'r1', live: true },
    { id: 'p2', name: 'Pixel Web', kind: 'web', aligned: true, roomId: 'r2', live: true },
    { id: 'p3', name: 'iPad mini', kind: 'lidar', role: 'move', aligned: false, roomId: null, live: true },
    { id: 'p4', name: 'Tom', kind: 'lidar', role: 'still', aligned: true, roomId: 'r2', live: true, portrait: true },
  ];
  const state = devices.map(() => ({ seg: 0, k: 0 }));
  const roomAt = (x, z) => ROOMS.find((r) => x >= r.floor[0][0] && x <= r.floor[2][0] && z >= r.floor[0][1] && z <= r.floor[2][1])?.id ?? null;

  setInterval(() => {
    devices.forEach((d, i) => {
      const path = PATHS[i];
      const s = state[i];
      const [a, b] = [path[s.seg % path.length], path[(s.seg + 1) % path.length]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      s.k += 0.25 / len;
      if (s.k >= 1) {
        s.k = 0;
        s.seg++;
      }
      const x = a[0] + (b[0] - a[0]) * s.k;
      const z = a[1] + (b[1] - a[1]) * s.k;
      const yaw = Math.atan2(-(b[0] - a[0]), -(b[1] - a[1]));
      const turn = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
      d.pose = { p: [x, 1.4, z], q: d.portrait ? qmul(turn, PORTRAIT) : turn };
      if (d.aligned) d.roomId = roomAt(x, z);
    });
    handle({ t: 'devices', devices: devices.map(({ portrait, ...d }) => ({ ...d })) });
  }, 200);

  // Each room's scan streams in over a few seconds, in slices like the phone sends.
  const queue = ROOMS.map((room) => ({ room, cloud: sampleRoom(room), at: 0 }));
  const SLICE = 6000;
  const feed = setInterval(() => {
    const q = queue.find((e) => e.at < e.cloud.points.length / 3);
    if (!q) return clearInterval(feed);
    const from = q.at * 3;
    const to = Math.min(q.cloud.points.length, from + SLICE * 3);
    q.at = to / 3;
    handle({
      t: 'cloud',
      roomId: q.room.id,
      points: q.cloud.points.slice(from, to),
      colors: q.cloud.colors.slice(from, to),
      normals: q.cloud.normals.slice(from, to),
    });
  }, 120);

  // Camera frames per streaming device, like the server sends admins.
  setInterval(async () => {
    for (const d of devices) {
      if (!d.pose || !d.live) continue;
      const room = ROOMS.find((r) => r.id === d.roomId);
      handleFrame?.({ id: d.id, ts: Date.now(), ...d.pose }, await fakeFrame(room, d.name, Date.now(), d.portrait));
    }
  }, 500);

  // Walls get reinforced as scans repeat.
  setInterval(() => handle({ t: 'map', ...mapJson(++version, version) }), 6000);

  // Exercise cloud-reset now and then, as a room re-scan would, then re-stream it.
  setInterval(() => {
    handle({ t: 'cloud-reset', roomId: 'r3' });
    const q = queue.find((e) => e.room.id === 'r3');
    const { points, colors, normals } = q.cloud;
    handle({ t: 'cloud', roomId: 'r3', points, colors, normals });
  }, 60000);
}

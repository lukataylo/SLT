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

// Furniture blobs give the cloud some mid-height structure.
const FURNITURE = [
  { room: 'r1', x: [0.6, 2.6], z: [1.2, 2.1], h: 0.8 },
  { room: 'r1', x: [3.4, 4.6], z: [0.3, 0.8], h: 1.9 },
  { room: 'r2', x: [5.2, 8.8], z: [0.2, 0.8], h: 0.95 },
  { room: 'r2', x: [6.4, 7.6], z: [4.6, 5.8], h: 0.75 },
  { room: 'r3', x: [0.3, 2.3], z: [5.2, 6.8], h: 0.5 },
];

const PATHS = [
  [[1.5, 1.5], [4, 1.5], [4, 3.8], [1.2, 3.8]],
  [[6, 1.5], [8.2, 1.5], [8.2, 5.5], [6, 5.5], [7, 3.5]],
  [[1, 5.6], [4, 5.6], [4, 6.4], [1, 6.4]],
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

function sampleRoom(room, n) {
  const pts = [];
  const lens = room.walls.map(([x1, z1, x2, z2]) => Math.hypot(x2 - x1, z2 - z1));
  const total = lens.reduce((a, b) => a + b, 0);
  const [[minX, minZ], , [maxX, maxZ]] = room.floor;
  const furniture = FURNITURE.filter((f) => f.room === room.id);
  for (let i = 0; i < n; i++) {
    const r = Math.random();
    if (r < 0.5) {
      // Walls (skipping openings, roughly).
      let pick = Math.random() * total;
      let w = 0;
      while (pick > lens[w]) pick -= lens[w++];
      const [x1, z1, x2, z2] = room.walls[w];
      const k = pick / lens[w];
      const x = x1 + (x2 - x1) * k;
      const z = z1 + (z2 - z1) * k;
      const y = rand(0, H);
      const inOpening = room.openings.some((o) => {
        const [a1, b1, a2, b2] = o.s;
        const along = Math.hypot(x - a1, z - b1) + Math.hypot(x - a2, z - b2) - Math.hypot(a2 - a1, b2 - b1);
        return along < 0.05 && y > o.y0 && y < o.y1;
      });
      if (!inOpening) pts.push(x + noise(0.03), y, z + noise(0.03));
    } else if (r < 0.8 || !furniture.length) {
      pts.push(rand(minX, maxX), Math.abs(noise(0.02)), rand(minZ, maxZ));
    } else {
      const f = furniture[Math.floor(Math.random() * furniture.length)];
      const top = Math.random() < 0.6;
      pts.push(rand(...f.x), top ? f.h + noise(0.02) : rand(0, f.h), rand(...f.z));
    }
  }
  return pts;
}

export function startMock(handle) {
  let version = 1;
  handle({ t: 'admin', map: mapJson(version, 0), devices: [], clouds: {} });

  const devices = [
    { id: 'p1', name: 'iPhone 17 Pro', kind: 'lidar', aligned: true, roomId: 'r1', live: true },
    { id: 'p2', name: 'Pixel Web', kind: 'web', aligned: true, roomId: 'r2', live: true },
    { id: 'p3', name: 'iPad mini', kind: 'lidar', aligned: false, roomId: null, live: true },
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
      d.pose = { p: [x, 1.4, z], q: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] };
      if (d.aligned) d.roomId = roomAt(x, z);
    });
    handle({ t: 'devices', devices: devices.map((d) => ({ ...d })) });
  }, 200);

  // The cloud fills in over time, fastest in the room each LiDAR phone is in.
  let total = 0;
  setInterval(() => {
    if (total > 90000) return;
    const room = ROOMS[Math.floor(Math.random() * ROOMS.length)];
    const points = sampleRoom(room, 500);
    total += points.length / 3;
    handle({ t: 'cloud', roomId: room.id, points });
  }, 150);

  // Walls get reinforced as scans repeat.
  setInterval(() => handle({ t: 'map', ...mapJson(++version, version) }), 6000);

  // Exercise cloud-reset now and then, as a room re-scan would.
  setInterval(() => handle({ t: 'cloud-reset', roomId: 'r3' }), 45000);
}

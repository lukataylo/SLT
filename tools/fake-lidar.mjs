// Simulates the iOS LiDAR app for testing without an iPhone: joins with
// frame=local, walks through a floor plan in its own (rotated, offset) ARKit
// frame, and reports the walls it has "seen" so far, like ARKit plane anchors.
//
//   node tools/fake-lidar.mjs --server http://localhost:8787 --name Phone1 --yaw 0 --tx 0 --tz 0
//   node tools/fake-lidar.mjs --name Phone2 --yaw 1.2 --tx 3 --tz -2 --start 3
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import { transformPoint2, transformPose, transformSegment } from '../shared/planes.js';

const { values: args } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://localhost:8787' },
    name: { type: 'string', default: 'FakeLiDAR' },
    yaw: { type: 'string', default: '0' },
    tx: { type: 'string', default: '0' },
    tz: { type: 'string', default: '0' },
    start: { type: 'string', default: '0' },
    seconds: { type: 'string', default: '0' },
  },
});

// Ground-truth floor plan, metres. The phone never sees these coordinates.
const PLAN = [
  [0, 0, 9, 0], [9, 0, 9, 7], [9, 7, 0, 7], [0, 7, 0, 0],
  [5, 0, 5, 3], [5, 3, 6.5, 3], [7.5, 3, 9, 3],
  [0, 4.5, 3, 4.5], [4, 4.5, 5, 4.5], [5, 4.5, 5, 7],
];
const PATH = [[2, 2], [4, 2], [4, 5.7], [7, 5.7], [7, 4], [7, 1.5], [3, 1.5]];
const SIGHT = 4.5; // metres a phone "scans" around itself
const FLOOR_Y = -1.35; // ARKit origin is where the session started, ~chest height

// Where the phone's ARKit frame sits relative to the plan.
const truth = { yaw: +args.yaw, t: [+args.tx, 0, +args.tz] };
const toLocal = (() => {
  const [x, z] = transformPoint2(truth.t[0], truth.t[2], { yaw: -truth.yaw, t: [0, 0, 0] });
  return { yaw: -truth.yaw, t: [-x, 0, -z] };
})();

const seen = PLAN.map(() => null);
function look(px, pz) {
  PLAN.forEach((s, i) => {
    // Visible part of a wall: points within SIGHT of the phone.
    const pts = [];
    for (let k = 0; k <= 40; k++) {
      const x = s[0] + ((s[2] - s[0]) * k) / 40;
      const z = s[1] + ((s[3] - s[1]) * k) / 40;
      if (Math.hypot(x - px, z - pz) < SIGHT) pts.push([x, z]);
    }
    if (pts.length < 4) return;
    const [a, b] = [pts[0], pts.at(-1)];
    const prev = seen[i];
    // Plane anchors grow as more of the wall is scanned.
    seen[i] = prev ? growTo(prev, a, b, s) : [...a, ...b];
  });
}
function growTo(prev, a, b, s) {
  const dir = [s[2] - s[0], s[3] - s[1]];
  const t = ([x, z]) => (x - s[0]) * dir[0] + (z - s[1]) * dir[1];
  const ends = [[prev[0], prev[1]], [prev[2], prev[3]], a, b].sort((p, q) => t(p) - t(q));
  return [...ends[0], ...ends.at(-1)];
}
const noise = () => (Math.random() * 2 - 1) * 0.03;

const url = new URL('/ws', args.server.replace(/^http/, 'ws'));
url.searchParams.set('name', args.name);
url.searchParams.set('frame', 'local');
const ws = new WebSocket(url);

let step = +args.start;
let along = 0;
let tick = 0;
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(data.toString());
  if (msg.t === 'align') {
    const a = msg.alignment;
    console.log(`[${args.name}] ${msg.aligned ? 'ALIGNED' : 'searching'} via ${msg.method ?? '-'} ` +
      `yaw=${a.yaw.toFixed(3)} t=[${a.t.map((v) => v.toFixed(2)).join(', ')}] ` +
      `match=${msg.inlierFraction?.toFixed(2) ?? '-'}${msg.ambiguous ? ' AMBIGUOUS' : ''} walls=${msg.walls}`);
  }
});

ws.on('open', () => {
  console.log(`[${args.name}] connected; true frame offset yaw=${truth.yaw} t=[${truth.t[0]}, ${truth.t[2]}]`);
  const timer = setInterval(() => {
    const [a, b] = [PATH[step % PATH.length], PATH[(step + 1) % PATH.length]];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    along += 0.12; // ~1.2 m/s at 10 Hz
    if (along >= seg) {
      along = 0;
      step++;
    }
    const k = along / seg;
    const px = a[0] + (b[0] - a[0]) * k;
    const pz = a[1] + (b[1] - a[1]) * k;
    look(px, pz);

    // Pose in plan coordinates (looking along the path), then into ARKit frame.
    const heading = Math.atan2(-(b[0] - a[0]), -(b[1] - a[1]));
    const h = heading / 2;
    const planPose = { p: [px, 1.4 + FLOOR_Y, pz], q: [0, Math.sin(h), 0, Math.cos(h)], fov: 50, aspect: 4 / 3 };
    ws.send(JSON.stringify({ t: 'pose', ...transformPose(planPose, toLocal) }));

    if (tick++ % 10 === 0) {
      const walls = seen.filter(Boolean).map((s) => transformSegment(s, toLocal).map((v) => v + noise()));
      ws.send(JSON.stringify({ t: 'planes', walls, floorY: FLOOR_Y }));
    }
  }, 100);
  if (+args.seconds) setTimeout(() => (clearInterval(timer), ws.close()), +args.seconds * 1000);
});
ws.on('close', () => process.exit(0));

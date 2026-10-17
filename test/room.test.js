import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transformSegment } from '../shared/planes.js';
import { decodeFrame, encodeFrame } from '../shared/protocol.js';
import { LiveMap } from '../server/livemap.js';
import { MAX_BUFFERED_BYTES, Room } from '../server/room.js';

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(data) {
    this.sent.push(data);
  }
  get json() {
    return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d));
  }
  get frames() {
    return this.sent.filter((d) => typeof d !== 'string').map(decodeFrame);
  }
}

const pose = { p: [1, 1.5, 2], q: [0, 0, 0, 1], fov: 50, aspect: 1.5 };
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function setup() {
  const room = new Room({ now: () => 1000 });
  const a = new FakeSocket();
  const b = new FakeSocket();
  const idA = room.join(a, { name: 'Ana' });
  const idB = room.join(b, { name: 'Ben' });
  return { room, a, b, idA, idB };
}

test('joining sends a welcome with existing peers and announces the newcomer', () => {
  const { a, b, idA, idB } = setup();
  assert.deepEqual(a.json[0], { t: 'welcome', id: idA, name: 'Ana', peers: [], map: { version: 1, origin: null, plan: null, rooms: [], walls: [], seen: [] } });
  assert.equal(b.json[0].peers[0].id, idA);
  assert.deepEqual(a.json[1], { t: 'join', id: idB, name: 'Ben' });
});

test('frames go to everyone except the sender, stamped with server id and time', () => {
  const { room, a, b, idA } = setup();
  room.handleFrame(idA, encodeFrame({ ...pose, id: 'spoofed', ts: 1 }, jpeg));
  assert.equal(a.frames.length, 0);
  assert.equal(b.frames.length, 1);
  assert.deepEqual(b.frames[0].meta, { id: idA, ts: 1000, ...pose });
  assert.deepEqual([...b.frames[0].jpeg], [...jpeg]);
});

test('late joiners immediately get the last frame of each feed', () => {
  const { room, idA } = setup();
  room.handleFrame(idA, encodeFrame(pose, jpeg));
  const c = new FakeSocket();
  room.join(c, { name: 'Cy' });
  assert.equal(c.frames.length, 1);
  assert.equal(c.frames[0].meta.id, idA);
  assert.equal(c.json[0].peers.find((p) => p.id === idA).live, true);
});

test('frames are dropped for congested receivers', () => {
  const { room, b, idA } = setup();
  b.bufferedAmount = MAX_BUFFERED_BYTES + 1;
  room.handleFrame(idA, encodeFrame(pose, jpeg));
  assert.equal(b.frames.length, 0);
  assert.equal(room.stats.framesDropped, 1);
});

test('pose updates are relayed; invalid poses and junk are ignored', () => {
  const { room, a, b, idA } = setup();
  room.handleText(idA, JSON.stringify({ t: 'pose', ...pose }));
  room.handleText(idA, JSON.stringify({ t: 'pose', p: [1], q: [0, 0, 0, 1] }));
  room.handleText(idA, 'not json');
  room.handleFrame(idA, new Uint8Array([0, 99]));
  const poses = b.json.filter((m) => m.t === 'pose');
  assert.deepEqual(poses, [{ t: 'pose', id: idA, ...pose }]);
  assert.equal(a.json.filter((m) => m.t === 'pose').length, 0);
});

test('leaving is announced once', () => {
  const { room, b, idA } = setup();
  room.leave(idA);
  room.leave(idA);
  assert.deepEqual(b.json.filter((m) => m.t === 'leave'), [{ t: 'leave', id: idA }]);
});

test('names are sanitised', () => {
  const room = new Room();
  const s = new FakeSocket();
  room.join(s, { name: '<script>alert(1)</script>' });
  assert.equal(s.json[0].name, 'scriptalert1script');
  const t = new FakeSocket();
  const id = room.join(t, { name: '   ' });
  assert.equal(t.json[0].name, id);
});

// --- LiDAR peers ----------------------------------------------------------

const ROOM = [
  [0, 0, 6, 0],
  [6, 0, 6, 4],
  [6, 4, 0, 4],
  [0, 4, 0, 0],
  [2, 0, 2, 1.5],
];
const planes = (walls, floorY = -1.3) => JSON.stringify({ t: 'planes', walls, floorY });
const last = (sock, type) => sock.json.filter((m) => m.t === type).at(-1);

test('the first LiDAR phone defines the map frame and seeds the floor plan', () => {
  const room = new Room({ now: () => 1000 });
  const viewer = new FakeSocket();
  room.join(viewer, { name: 'web' });
  const phone = new FakeSocket();
  const id = room.join(phone, { name: 'iPhone', frame: 'local' });

  room.handleFrame(id, encodeFrame(pose, jpeg));
  assert.equal(viewer.frames.length, 0, 'unaligned frames are held back');

  room.handleText(id, planes(ROOM));
  const align = last(phone, 'align');
  assert.equal(align.aligned, true);
  assert.equal(align.method, 'origin');
  assert.deepEqual(align.alignment.t, [0, 1.3, 0], 'floor lifted to y = 0');
  assert.equal(last(viewer, 'map').walls.length, ROOM.length);

  room.handleFrame(id, encodeFrame(pose, jpeg));
  assert.equal(viewer.frames.length, 1);
  assert.deepEqual(viewer.frames[0].meta.p, [1, 2.8, 2], 'pose moved into the map frame');
});

test('a second LiDAR phone is aligned to the map from the walls it sees', () => {
  const room = new Room({ now: () => 1000 });
  const first = new FakeSocket();
  const idA = room.join(first, { name: 'A', frame: 'local' });
  room.handleText(idA, planes(ROOM));

  // Phone B tracks in its own frame: turned 90° and offset from phone A's.
  const truth = { yaw: Math.PI / 2, t: [3, 0, -1] };
  const inv = { yaw: -Math.PI / 2, t: [-1, 0, -3] };
  const seen = [ROOM[0], ROOM[1], ROOM[4]].map((s) => transformSegment(s, inv));
  const second = new FakeSocket();
  const idB = room.join(second, { name: 'B', frame: 'local' });
  room.handleText(idB, planes(seen, -1.1));

  const align = last(second, 'align');
  assert.equal(align.aligned, true);
  assert.equal(align.method, 'walls');
  assert.ok(Math.abs(align.alignment.yaw - truth.yaw) < 0.02, `yaw ${align.alignment.yaw}`);
  assert.ok(Math.abs(align.alignment.t[0] - truth.t[0]) < 0.05, `tx ${align.alignment.t[0]}`);
  assert.ok(Math.abs(align.alignment.t[2] - truth.t[2]) < 0.05, `tz ${align.alignment.t[2]}`);
  assert.ok(Math.abs(align.alignment.t[1] - 1.1) < 1e-9);
});

test('a LiDAR phone that sees too little stays unaligned and silent', () => {
  const room = new Room({ now: () => 1000 });
  const idA = room.join(new FakeSocket(), { name: 'A', frame: 'local' });
  room.handleText(idA, planes(ROOM));
  const viewer = new FakeSocket();
  room.join(viewer, { name: 'web' });
  const second = new FakeSocket();
  const idB = room.join(second, { name: 'B', frame: 'local' });
  room.handleText(idB, planes([[0, 0, 3, 0]]));
  assert.equal(last(second, 'align').aligned, false);
  room.handleText(idB, JSON.stringify({ t: 'pose', ...pose }));
  assert.equal(viewer.json.filter((m) => m.t === 'pose').length, 0);
});

test("a leaving phone's walls stay in the map", () => {
  const room = new Room({ now: () => 1000 });
  const idA = room.join(new FakeSocket(), { name: 'A', frame: 'local' });
  room.handleText(idA, planes(ROOM));
  room.leave(idA);
  assert.equal(room.map.walls.length, ROOM.length);
  assert.equal(room.map.contributions.size, 0);
});

test('browser peers cannot send planes', () => {
  const { room, idA } = setup();
  room.handleText(idA, planes(ROOM));
  assert.equal(room.map.walls.length, 0);
});

// --- Fixed origin and reinforcement ----------------------------------------

test('the origin is founded once and survives a restart', () => {
  const first = new Room({ now: () => 1000 });
  const idA = first.join(new FakeSocket(), { name: 'Founder', frame: 'local' });
  first.handleText(idA, planes(ROOM));
  first.leave(idA);
  const saved = JSON.parse(JSON.stringify(first.map.toFile()));
  assert.equal(saved.origin.by, 'Founder');

  // After a restart, a phone that starts elsewhere must align to the saved
  // origin instead of founding a new one.
  const room = new Room({ map: new LiveMap(saved) });
  const inv = { yaw: -Math.PI / 2, t: [-1, 0, -3] };
  const phone = new FakeSocket();
  const id = room.join(phone, { name: 'Later', frame: 'local' });
  room.handleText(id, planes([ROOM[0], ROOM[1], ROOM[4]].map((s) => transformSegment(s, inv))));
  const align = last(phone, 'align');
  assert.equal(align.method, 'walls');
  assert.equal(align.origin.by, 'Founder');
  assert.ok(Math.abs(align.alignment.yaw - Math.PI / 2) < 0.02);
});

test('a phone founds the map from the floor alone, no walls needed', () => {
  const room = new Room();
  const phone = new FakeSocket();
  const id = room.join(phone, { name: 'A', frame: 'local' });
  room.handleText(id, planes([]));
  assert.equal(room.map.origin.by, 'A');
  assert.equal(last(phone, 'align').aligned, true);
});

test('pairing: collaboration data is relayed between LiDAR phones and a paired phone is placed', () => {
  const room = new Room();
  const a = new FakeSocket();
  const idA = room.join(a, { name: 'A', frame: 'local' });
  const b = new FakeSocket();
  const idB = room.join(b, { name: 'B', frame: 'local' });
  const web = new FakeSocket();
  room.join(web, { name: 'web' });

  room.handleText(idA, JSON.stringify({ t: 'collab', data: 'AAEC' }));
  assert.deepEqual(last(b, 'collab'), { t: 'collab', from: idA, data: 'AAEC' });
  assert.equal(last(a, 'collab'), undefined, 'not echoed back');
  assert.equal(last(web, 'collab'), undefined, 'browsers do not get ARKit data');

  room.handleText(idB, JSON.stringify({ t: 'pair', alignment: { yaw: 1, t: [2, 1.3, 3] } }));
  assert.equal(last(b, 'align'), undefined, 'no map yet, nothing to pair into');

  room.handleText(idA, planes(ROOM));
  room.handleText(idB, JSON.stringify({ t: 'pair', alignment: { yaw: 1, t: [2, 1.3, 3] } }));
  const align = last(b, 'align');
  assert.equal(align.method, 'paired');
  assert.deepEqual(align.alignment, { yaw: 1, t: [2, 1.3, 3] });
  room.handleText(idB, JSON.stringify({ t: 'pose', p: [0, 0, 0], q: [0, 0, 0, 1] }));
  assert.ok(last(web, 'pose'), 'paired phone poses are relayed');
});

test('walls confirmed by more sessions gain weight', () => {
  const room = new Room();
  for (const name of ['A', 'B', 'C']) {
    const id = room.join(new FakeSocket(), { name, frame: 'local' });
    room.handleText(id, planes(ROOM));
    room.leave(id);
  }
  assert.deepEqual(room.map.toJSON().seen, ROOM.map(() => 3));
});

test('placed phones take small blended corrections and resist one-off jumps', () => {
  const room = new Room();
  const idA = room.join(new FakeSocket(), { name: 'A', frame: 'local' });
  room.handleText(idA, planes(ROOM));
  const phone = new FakeSocket();
  const id = room.join(phone, { name: 'B', frame: 'local' });
  room.handleText(id, planes(ROOM));
  assert.equal(last(phone, 'align').correction, 'locked');

  // Tracking drift of 0.2 m: corrected halfway per update.
  const drift = ROOM.map((s) => transformSegment(s, { yaw: 0, t: [-0.2, 0, 0] }));
  room.handleText(id, planes(drift));
  assert.equal(last(phone, 'align').correction, 'refined');
  assert.ok(Math.abs(last(phone, 'align').alignment.t[0] - 0.1) < 0.02);

  // A sudden 2 m jump is held until it repeats.
  const jump = ROOM.map((s) => transformSegment(s, { yaw: 0, t: [-2, 0, 0] }));
  room.handleText(id, planes(jump));
  assert.equal(last(phone, 'align').correction, 'held');
  room.handleText(id, planes(jump));
  room.handleText(id, planes(jump));
  assert.equal(last(phone, 'align').correction, 'relocated');
  assert.ok(Math.abs(last(phone, 'align').alignment.t[0] - 2) < 0.05);
});

// --- Grounding, rooms, openings, cloud, admin -------------------------------

test('a phone must find the floor before it can found or join the map', () => {
  const room = new Room();
  const phone = new FakeSocket();
  const id = room.join(phone, { name: 'A', frame: 'local' });
  room.handleText(id, JSON.stringify({ t: 'planes', walls: ROOM }));
  assert.equal(last(phone, 'align').needsFloor, true);
  assert.equal(room.map.origin, null);
  room.handleText(id, planes(ROOM, -1.2));
  assert.equal(last(phone, 'align').aligned, true);
  assert.equal(last(phone, 'align').roomId, 'r1', 'founding creates Room 1');
});

test('doors, windows and the floor outline land in the phone\'s room', () => {
  const room = new Room();
  const phone = new FakeSocket();
  const id = room.join(phone, { name: 'A', frame: 'local' });
  room.handleText(id, JSON.stringify({
    t: 'planes', walls: ROOM, floorY: -1.3,
    openings: [{ kind: 'door', s: [3, 4, 3.9, 4], y0: -1.3, y1: 0.7 }, { kind: 'bogus', s: [0, 0, 1, 0], y0: 0, y1: 1 }],
    floor: [[0.2, 0.2], [5.8, 0.2], [5.8, 3.8], [0.2, 3.8], [3, 2]],
  }));
  const r1 = room.map.toJSON().rooms[0];
  assert.equal(r1.openings.length, 1);
  assert.equal(r1.openings[0].kind, 'door');
  assert.ok(Math.abs(r1.openings[0].y0) < 1e-9 && Math.abs(r1.openings[0].y1 - 2) < 1e-9, 'heights grounded on the floor');
  assert.equal(r1.floor.length, 4, 'floor outline is a hull');
});

test('a new room starts at the phone and keeps earlier walls in the old room', () => {
  const room = new Room();
  const phone = new FakeSocket();
  const id = room.join(phone, { name: 'A', frame: 'local' });
  room.handleText(id, planes(ROOM));
  room.handleText(id, JSON.stringify({ t: 'pose', p: [4, 0.1, 2], q: [0, 0, 0, 1] }));
  room.handleText(id, JSON.stringify({ t: 'room', action: 'new', name: 'Kitchen' }));
  assert.deepEqual(last(phone, 'reset'), { t: 'reset', scope: 'room', roomId: 'r2' });
  const rooms = room.map.toJSON().rooms;
  assert.deepEqual(rooms.map((r) => [r.id, r.name, r.walls.length]), [['r1', 'Room 1', 5], ['r2', 'Kitchen', 0]]);
  assert.deepEqual(rooms[1].origin, [4, 2]);

  room.handleText(id, planes([[6, 0, 9, 0], [9, 0, 9, 4], [6, 0, 6, 4]]));
  assert.equal(room.map.toJSON().rooms[1].walls.length, 3);
  assert.equal(room.map.toJSON().rooms[0].walls.length, 5);
});

test('resetting a room clears it; resetting the map clears the origin and alignments', () => {
  const room = new Room();
  const phone = new FakeSocket();
  const id = room.join(phone, { name: 'A', frame: 'local' });
  room.handleText(id, planes(ROOM));
  room.handleText(id, JSON.stringify({ t: 'room', action: 'reset-room' }));
  assert.equal(room.map.toJSON().rooms[0].walls.length, 0);
  assert.equal(room.map.origin.by, 'A', 'the origin survives a room reset');

  room.handleText(id, JSON.stringify({ t: 'room', action: 'reset-map' }));
  assert.equal(room.map.origin, null);
  assert.equal(room.map.rooms.length, 0);
  assert.deepEqual(last(phone, 'reset'), { t: 'reset', scope: 'map' });
  assert.equal(last(phone, 'align').aligned, false);
});

test('admins get a snapshot, map updates, devices and cloud deltas; peers never see admins', () => {
  const room = new Room({ now: () => 1000 });
  const admin = new FakeSocket();
  room.join(admin, { role: 'admin' });
  assert.equal(admin.json[0].t, 'admin');
  const phone = new FakeSocket();
  const id = room.join(phone, { name: 'A', frame: 'local' });
  assert.equal(phone.json[0].peers.length, 0, 'admin is invisible to peers');

  room.handleText(id, planes(ROOM));
  assert.ok(last(admin, 'map'));
  const viewer = new FakeSocket();
  room.join(viewer, { name: 'web' });
  room.handleText(id, JSON.stringify({
    t: 'cloud',
    points: [1, -1.3, 1, 1.02, -1.3, 1.01, 2, 0, 2],
    colors: [200, 100, 50, 0, 0, 0, 999, -5, 'x'],
    normals: [127, 0, 0, 0, 0, 0, 0, 127, 0],
  }));
  const cloud = last(admin, 'cloud');
  assert.equal(cloud.roomId, 'r1');
  assert.equal(cloud.points.length, 6, 'points within one voxel are deduplicated');
  assert.ok(Math.abs(cloud.points[1]) < 1e-9, 'cloud is grounded on the floor');
  assert.deepEqual(cloud.colors, [200, 100, 50, 255, 0, 150], 'colours clamped, bad values greyed');
  assert.deepEqual(cloud.normals.slice(0, 3), [127, 0, 0]);
  assert.deepEqual(last(viewer, 'cloud').points, cloud.points, 'web viewers get the cloud too');
  assert.equal(last(phone, 'cloud'), undefined, 'LiDAR phones do not');

  room.broadcastDevices();
  const dev = last(admin, 'devices').devices[0];
  assert.deepEqual([dev.kind, dev.aligned, dev.roomId], ['lidar', true, 'r1']);
});

test('an uploaded plan is placed onto the scan automatically', () => {
  const room = new Room();
  // Plan frame: the same ROOM, but drawn rotated 90° and shifted on the page.
  const toPlan = { yaw: Math.PI / 2, t: [2, 0, 8] };
  // An L-shaped room: unlike a plain rectangle it only fits the plan one way.
  const L = [[0, 0], [6, 0], [6, 2], [3, 2], [3, 4], [0, 4]];
  const poly = L.map(([x, z]) => {
    const c = Math.cos(toPlan.yaw), s = Math.sin(toPlan.yaw);
    return [c * x + s * z + toPlan.t[0], -s * x + c * z + toPlan.t[2]];
  });
  room.map.setPlan({ id: 'plan1', name: 'Flat', rooms: [{ id: 'pr1', name: 'Lounge', polygon: poly }], placement: null });
  const id = room.join(new FakeSocket(), { name: 'A', frame: 'local' });
  room.handleText(id, planes(L.map((p, i) => [...p, ...L[(i + 1) % L.length]])));
  const placement = room.map.plan.placement;
  assert.ok(placement, 'placed');
  // Plan → map must undo toPlan: plan corner (2, 8) is map (0, 0).
  const [x, z] = [Math.cos(placement.yaw) * 2 + Math.sin(placement.yaw) * 8 + placement.t[0], -Math.sin(placement.yaw) * 2 + Math.cos(placement.yaw) * 8 + placement.t[2]];
  assert.ok(Math.hypot(x, z) < 0.1, `plan corner maps to ${x}, ${z}`);
});

test('QR pairing: a shown code can be claimed once fresh, and the shower hears when pairing is done', () => {
  let now = 1000;
  const room = new Room({ now: () => now });
  const a = new FakeSocket();
  const idA = room.join(a, { name: 'Ana', frame: 'local' });
  const b = new FakeSocket();
  const idB = room.join(b, { name: 'Ben', frame: 'local' });
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 1, 3, 1];

  room.handleText(idA, JSON.stringify({ t: 'pairing', action: 'show', code: 'abc', m }));
  room.handleText(idB, JSON.stringify({ t: 'pairing', action: 'claim', code: 'abc' }));
  assert.equal(last(b, 'pairing').action, 'unknown', 'an unplaced phone cannot show a code');

  room.handleText(idA, planes(ROOM));
  room.handleText(idA, JSON.stringify({ t: 'pairing', action: 'show', code: 'abc', m }));
  room.handleText(idB, JSON.stringify({ t: 'pairing', action: 'claim', code: 'abc' }));
  assert.deepEqual(last(b, 'pairing'), { t: 'pairing', action: 'pose', code: 'abc', m, by: 'Ana' });

  room.handleText(idB, JSON.stringify({ t: 'pair', alignment: { yaw: 0.2, t: [1, 1.3, 2] } }));
  assert.deepEqual(last(a, 'pairing'), { t: 'pairing', action: 'done', by: 'Ben' });

  now += 5000;
  room.handleText(idB, JSON.stringify({ t: 'pairing', action: 'claim', code: 'abc' }));
  assert.equal(last(b, 'pairing').action, 'unknown', 'stale codes expire');
});

test('rooms can be renamed and linked to a plan room', () => {
  const room = new Room();
  room.map.setPlan({ id: 'p', name: 'Plan', rooms: [{ id: 'pr1', name: 'Lounge', polygon: [[0, 0], [1, 0], [1, 1]] }], placement: null });
  const id = room.join(new FakeSocket(), { name: 'A', frame: 'local' });
  room.handleText(id, planes(ROOM));
  room.handleText(id, JSON.stringify({ t: 'room', action: 'rename', roomId: 'r1', name: 'Living room', planRoomId: 'pr1' }));
  assert.deepEqual([room.map.rooms[0].name, room.map.rooms[0].planRoomId], ['Living room', 'pr1']);
  room.handleText(id, JSON.stringify({ t: 'room', action: 'rename', roomId: 'r1', planRoomId: 'nope' }));
  assert.equal(room.map.rooms[0].planRoomId, null);
});

test('pair needs a claim or another located phone, and codes cannot be hijacked', () => {
  const room = new Room();
  const a = new FakeSocket();
  const idA = room.join(a, { name: 'A', frame: 'local' });
  room.handleText(idA, planes(ROOM));
  room.leave(idA);

  const lone = new FakeSocket();
  const idL = room.join(lone, { name: 'L', frame: 'local' });
  room.handleText(idL, JSON.stringify({ t: 'pair', alignment: { yaw: 0, t: [0, 0, 0] } }));
  assert.equal(last(lone, 'align'), undefined, 'nobody vouches for it');

  const b = new FakeSocket();
  const idB = room.join(b, { name: 'B', frame: 'local' });
  room.handleText(idB, planes(ROOM));
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  room.handleText(idB, JSON.stringify({ t: 'pairing', action: 'show', code: 'x', m }));
  room.handleText(idL, JSON.stringify({ t: 'pairing', action: 'show', code: 'x', m: m.map((v) => v * 2) }));
  assert.deepEqual(room.pairingCodes.get('x').m, m, 'only the owner can update a code');
});

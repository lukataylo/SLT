import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transformSegment } from '../shared/planes.js';
import { decodeFrame, encodeFrame } from '../shared/protocol.js';
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
  assert.deepEqual(a.json[0], { t: 'welcome', id: idA, name: 'Ana', peers: [], map: { version: 0, walls: [] } });
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

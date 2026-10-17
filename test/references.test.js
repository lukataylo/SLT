import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { encodeFrame } from '../shared/protocol.js';
import { referenceApi, referenceFiles } from '../server/references.js';
import { Room } from '../server/room.js';

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
}

// A plain rectangle: walls alone fit it two ways round.
const RECT = [
  [0, 0, 5, 0],
  [5, 0, 5, 3.5],
  [5, 3.5, 0, 3.5],
  [0, 3.5, 0, 0],
];
const planes = (walls, floorY = -1.3) => JSON.stringify({ t: 'planes', walls, floorY });
// The first phone starts the group, which founds the map where it stands.
const CREATE = JSON.stringify({ t: 'group', action: 'create' });
const last = (sock, type) => sock.json.filter((m) => m.t === type).at(-1);
const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const settle = () => new Promise((r) => setTimeout(r, 30));
const rotate = ([x1, z1, x2, z2], yaw, [tx, tz]) => {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * x1 + s * z1 + tx, -s * x1 + c * z1 + tz, c * x2 + s * z2 + tx, -s * x2 + c * z2 + tz];
};

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'slt-ref-'));
  const files = referenceFiles(dir);
  const room = new Room({ references: files });
  room.map.onReferenceRemoved = (file) => files.remove(file);
  const handle = referenceApi({ map: room.map, dir });
  const server = createServer(async (req, res) => (await handle(req, res)) || res.writeHead(404).end());
  await new Promise((r) => server.listen(0, r));
  return { room, dir, base: `http://localhost:${server.address().port}`, close: () => server.close() };
}

test('a scanning phone keeps one reference photo per wall direction; resetting the room drops them', async () => {
  const { room, dir, base, close } = await setup();
  try {
    const viewer = new FakeSocket();
    room.join(viewer, { name: 'web' });
    const phone = new FakeSocket();
    const id = room.join(phone, { name: 'Ana', frame: 'local' });
    const photo = (slot) => encodeFrame({ p: [2, 0.2, 1], q: [0, 0, 0, 1], fov: 50, aspect: 4 / 3, keyframe: true, slot }, jpeg);

    room.handleFrame(id, photo(0));
    await settle();
    assert.equal(room.map.toJSON().rooms.length, 0, 'ignored before the phone is on the map');

    room.handleText(id, CREATE);
    room.handleText(id, planes(RECT));
    room.handleFrame(id, photo(0));
    room.handleFrame(id, photo(2));
    room.handleFrame(id, photo(7)); // no such wall
    await settle();
    const refs = room.map.toJSON().rooms[0].references;
    assert.deepEqual(refs.map((r) => r.slot), [0, 2]);
    assert.deepEqual(refs[0].p, [2, 1.5, 1], 'pose on the map (floor at 0)');
    assert.equal(refs[0].file, undefined, 'file names stay private');
    assert.equal(viewer.sent.filter((d) => typeof d !== 'string').length, 0, 'not relayed as video');

    const img = await fetch(`${base}/api/references/r1/${refs[0].id}.jpg`);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...new Uint8Array(await img.arrayBuffer())], [...jpeg]);
    assert.equal((await fetch(`${base}/api/references/r1/nope.jpg`)).status, 404);

    // A better photo of the same wall replaces the old one, file and all.
    room.handleFrame(id, photo(0));
    await settle();
    assert.equal((await readdir(path.join(dir, 'r1'))).length, 2);

    room.handleText(id, JSON.stringify({ t: 'room', action: 'reset-room' }));
    await settle();
    assert.equal(room.map.toJSON().rooms[0].references.length, 0);
    assert.equal((await readdir(path.join(dir, 'r1'))).length, 0);
  } finally {
    close();
  }
});

test('a heading from the reference photos lets a new phone locate in a room that fits two ways round', () => {
  const room = new Room();
  const a = new FakeSocket();
  const idA = room.join(a, { name: 'Ana', frame: 'local' });
  room.handleText(idA, CREATE);
  room.handleText(idA, planes(RECT));
  room.handleText(idA, JSON.stringify({ t: 'planes', walls: RECT, floorY: -1.3 }));

  // Ben's phone: its own frame is the map turned by 2.4 rad and shifted.
  const yaw = 2.4;
  const b = new FakeSocket();
  const idB = room.join(b, { name: 'Ben', frame: 'local' });
  const inv = (s) => rotate(s, -yaw, [0, 0]);
  const local = RECT.map((s) => inv(s.map((v, i) => v - (i % 2 ? -0.7 : 1.5))));
  room.handleText(idB, planes(local));
  assert.equal(last(b, 'align').aligned, false, 'walls alone are ambiguous');
  assert.equal(last(b, 'align').ambiguous, true);

  // Recognised, but its walls aren't in yet: it's in the room already.
  const c = new FakeSocket();
  const idC = room.join(c, { name: 'Cy', frame: 'local' });
  room.handleText(idC, JSON.stringify({ t: 'heading', yaw: 1, roomId: 'r1' }));
  assert.deepEqual([last(c, 'align').aligned, last(c, 'align').roomId], [false, 'r1']);
  assert.equal(room.devices().find((d) => d.id === idC).roomId, 'r1', 'the operator sees which room');

  room.handleText(idB, JSON.stringify({ t: 'heading', yaw: yaw + 0.08, roomId: 'r1' }));
  const align = last(b, 'align');
  assert.equal(align.aligned, true);
  assert.ok(Math.abs(Math.atan2(Math.sin(align.alignment.yaw - yaw), Math.cos(align.alignment.yaw - yaw))) < 0.02, `yaw ${align.alignment.yaw}`);
  assert.ok(Math.hypot(align.alignment.t[0] - 1.5, align.alignment.t[2] + 0.7) < 0.05, `t ${align.alignment.t}`);
  assert.equal(align.roomId, 'r1');
  assert.equal(room.peers.get(idB).headingHint, null, 'used up');
});

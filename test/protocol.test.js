import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, isValidPose, pickPose } from '../shared/protocol.js';

test('frame round-trips meta and jpeg bytes', () => {
  const meta = { p: [1, 2, 3], q: [0, 0, 0, 1], fov: 50 };
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const out = decodeFrame(encodeFrame(meta, jpeg));
  assert.deepEqual(out.meta, meta);
  assert.deepEqual([...out.jpeg], [...jpeg]);
});

test('decodes a Node Buffer that is a view into a larger pool', () => {
  const frame = encodeFrame({ p: [0, 0, 0], q: [0, 0, 0, 1] }, new Uint8Array([9, 9]));
  const pool = Buffer.alloc(frame.length + 10);
  pool.set(frame, 5);
  const view = pool.subarray(5, 5 + frame.length);
  assert.deepEqual([...decodeFrame(view).jpeg], [9, 9]);
});

test('rejects short and truncated frames', () => {
  assert.throws(() => decodeFrame(new Uint8Array([1])), RangeError);
  assert.throws(() => decodeFrame(new Uint8Array([0, 50, 123])), RangeError);
});

test('validates poses', () => {
  assert.ok(isValidPose({ p: [0, 1, 2], q: [0, 0, 0, 1] }));
  assert.ok(!isValidPose({ p: [0, 1], q: [0, 0, 0, 1] }));
  assert.ok(!isValidPose({ p: [0, 1, NaN], q: [0, 0, 0, 1] }));
  assert.ok(!isValidPose(null));
});

test('pickPose drops out-of-range intrinsics and extra fields', () => {
  const pose = pickPose({ p: [0, 0, 0], q: [0, 0, 0, 1], fov: 500, aspect: 1.5, id: 'evil' });
  assert.deepEqual(pose, { p: [0, 0, 0], q: [0, 0, 0, 1], aspect: 1.5 });
});

test('cloud snapshots round-trip, including odd id lengths and missing colours', async () => {
  const { decodeClouds, encodeClouds } = await import('../shared/cloud.js');
  const rooms = [
    { id: 'r1', points: [1.5, 0, -2.25, 3, 2.5, 4], colors: [255, 0, 10, 1, 2, 3], normals: [127, 0, -127, 0, 127, 0] },
    { id: 'kitchen', points: [0.125, 1, 2], colors: [], normals: [] },
    { id: 'r3', points: [], colors: [], normals: [] },
  ];
  const out = decodeClouds(encodeClouds(rooms));
  assert.deepEqual(out[0], rooms[0]);
  assert.deepEqual(out[1], { id: 'kitchen', points: [0.125, 1, 2], colors: [150, 150, 150], normals: [0, 0, 0] });
  assert.deepEqual(out[2].points, []);
});

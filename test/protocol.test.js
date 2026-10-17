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

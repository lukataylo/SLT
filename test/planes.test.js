import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { mergeSegments, reinforce, register, transformPoint2, transformPose, transformSegment } from '../shared/planes.js';

const DEG = Math.PI / 180;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function inverse({ yaw, t }) {
  const [x, z] = transformPoint2(t[0], t[2], { yaw: -yaw, t: [0, 0, 0] });
  return { yaw: -yaw, t: [-x, -t[1], -z] };
}

// Deterministic jitter so failures reproduce.
function jitter(seed) {
  let s = seed;
  return (amp) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return ((s / 0x7fffffff) * 2 - 1) * amp;
  };
}

// An asymmetric flat: big living room, kitchen, bedroom and a corridor.
const FLAT = [
  [0, 0, 9, 0],
  [9, 0, 9, 7],
  [9, 7, 0, 7],
  [0, 7, 0, 0],
  [5, 0, 5, 3],
  [5, 3, 6.5, 3],
  [7.5, 3, 9, 3],
  [0, 4.5, 3, 4.5],
  [4, 4.5, 5, 4.5],
  [5, 4.5, 5, 7],
];

test('transformPose matches three.js rotation about +Y', () => {
  const T = { yaw: 0.7, t: [1, -0.2, 3] };
  const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3).toArray();
  const out = transformPose({ p: [2, 1.5, -1], q }, T);
  const rot = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), T.yaw);
  const expectP = new Vector3(2, 1.5, -1).applyQuaternion(rot).add(new Vector3(...T.t));
  near(out.p[0], expectP.x, 1e-9);
  near(out.p[1], expectP.y, 1e-9);
  near(out.p[2], expectP.z, 1e-9);
  const expectQ = rot.clone().multiply(new Quaternion().fromArray(q));
  out.q.forEach((v, i) => near(v, expectQ.toArray()[i], 1e-9));
});

test('mergeSegments fuses overlapping and nearly collinear pieces of one wall', () => {
  const merged = mergeSegments([
    [0, 0, 2, 0.05],
    [1.8, -0.05, 4, 0],
    [4.3, 0.02, 6, 0], // small gap: still the same wall
    [0, 3, 4, 3], // a different, parallel wall
    [6, 0, 6, 0.1], // too short to keep
  ]);
  assert.equal(merged.length, 2);
  const wall = merged.find((s) => Math.abs(s[1]) < 0.2);
  near(Math.min(wall[0], wall[2]), 0, 0.05, 'start');
  near(Math.max(wall[0], wall[2]), 6, 0.05, 'end');
});

test('mergeSegments treats opposite-direction observations as the same wall', () => {
  const merged = mergeSegments([
    [0, 0, 3, 0],
    [4, 0.05, 2, 0.05],
  ]);
  assert.equal(merged.length, 1);
  near(Math.abs(merged[0][2] - merged[0][0]), 4, 0.05);
});

for (const [name, truth] of [
  ['small turn', { yaw: 12 * DEG, t: [0.8, 0, -1.3] }],
  ['upside down', { yaw: 171 * DEG, t: [4, 0, 2] }],
  ['quarter turn', { yaw: -95 * DEG, t: [-3, 0, 6] }],
]) {
  test(`register recovers a phone's placement from a partial scan (${name})`, () => {
    // The phone saw the living room corner and part of the kitchen wall,
    // in pieces, with tracking noise.
    const seen = [
      [5.2, 0, 8.6, 0],
      [9, 0.3, 9, 2.4],
      [9, 2.6, 9, 6.5],
      [5, 0.4, 5, 2.8],
      [7.6, 3, 8.8, 3],
    ];
    const rnd = jitter(7);
    const local = seen.map((s) => transformSegment(s, inverse(truth)).map((v) => v + rnd(0.04)));
    const res = register(local, FLAT);
    assert.ok(res, 'expected an alignment');
    near(wrap(res.yaw - truth.yaw), 0, 2 * DEG, 'yaw');
    near(res.t[0], truth.t[0], 0.1, 'tx');
    near(res.t[2], truth.t[2], 0.1, 'tz');
    assert.ok(res.inlierFraction > 0.9, `inliers ${res.inlierFraction}`);
    assert.equal(res.ambiguous, false);
  });
}

test('register needs walls in two directions', () => {
  const local = [
    [0, 0, 4, 0],
    [0, 3, 4, 3],
  ];
  assert.equal(register(local, FLAT), null);
});

test('register flags a placement that symmetry cannot pin down', () => {
  const box = [
    [0, 0, 4, 0],
    [4, 0, 4, 4],
    [4, 4, 0, 4],
    [0, 4, 0, 0],
  ];
  const corner = [
    [0.5, 0, 3.5, 0],
    [4, 0.5, 4, 3.5],
  ];
  const res = register(corner, box);
  assert.ok(res);
  assert.equal(res.ambiguous, true);
});

test('register refines from a previous alignment', () => {
  const truth = { yaw: 30 * DEG, t: [2, 0, 1] };
  const local = FLAT.slice(0, 5).map((s) => transformSegment(s, inverse(truth)));
  const res = register(local, FLAT, { initial: { yaw: 27 * DEG, t: [2.3, 0, 0.8] } });
  near(wrap(res.yaw - truth.yaw), 0, 0.5 * DEG, 'yaw');
  near(res.t[0], 2, 0.03, 'tx');
  near(res.t[2], 1, 0.03, 'tz');
});

test('register tolerates clutter that is not in the map', () => {
  const truth = { yaw: -40 * DEG, t: [1.5, 0, -2] };
  const seen = [
    [0.3, 0, 4.7, 0],
    [0, 0.3, 0, 4.2],
    [0.4, 4.5, 2.8, 4.5],
    [5, 0.2, 5, 2.9],
  ];
  const clutter = [
    [1, 1, 2.6, 1.1], // sofa back
    [3.2, 2, 3.3, 3.4], // bookshelf
    [1.5, 3, 2.3, 3.8], // something diagonal
  ];
  const rnd = jitter(42);
  const local = [...seen, ...clutter].map((s) => transformSegment(s, inverse(truth)).map((v) => v + rnd(0.06)));
  const res = register(local, FLAT);
  assert.ok(res);
  near(wrap(res.yaw - truth.yaw), 0, 2 * DEG, 'yaw');
  near(res.t[0], truth.t[0], 0.15, 'tx');
  near(res.t[2], truth.t[2], 0.15, 'tz');
});

test('reinforce counts each session once and resists a single noisy pass', () => {
  let base = reinforce([], [[0, 0, 4, 0]]);
  for (let i = 0; i < 9; i++) base = reinforce(base, [[0, 0, 4, 0], [0.5, 0.02, 3, 0.02]]);
  assert.equal(base.length, 1);
  assert.equal(base[0].seen, 10);
  const nudged = reinforce(base, [[0, 0.2, 4, 0.2]]);
  assert.equal(nudged[0].seen, 11);
  assert.ok(Math.abs(nudged[0].s[1]) < 0.03, `moved to ${nudged[0].s[1]}`);
  assert.equal(reinforce(base, [[0, 3, 4, 3]]).length, 2, 'a new wall is added, not merged');
});

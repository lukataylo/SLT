import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Euler, Quaternion } from 'three';
import { headingCorrection, yawOf, yawTowards } from '../client/src/align.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

test('yawTowards matches three.js yaw convention', () => {
  close(yawTowards([0, 0], [0, -1]), 0); // -Z
  close(yawTowards([0, 0], [-1, 0]), Math.PI / 2); // -X is a left turn
  close(yawTowards([0, 0], [1, 0]), -Math.PI / 2);
});

test('yawOf ignores pitch and roll', () => {
  const q = new Quaternion().setFromEuler(new Euler(0.5, 1.2, 0.3, 'YXZ'));
  close(yawOf(q), 1.2);
});

test('headingCorrection rotates the device heading onto the target', () => {
  const device = new Quaternion().setFromEuler(new Euler(0.3, 2.0, 0, 'YXZ'));
  const target = yawTowards([0, 0], [-1, -1]);
  const fixed = headingCorrection(device, target).multiply(device);
  close(wrap(yawOf(fixed) - target), 0);
});

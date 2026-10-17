import { Quaternion, Vector3 } from 'three';

// Phones agree on "down" (gravity) but not on heading or position, so aligning
// a phone's local tracking frame to the map is a yaw rotation plus a placement.

const UP = new Vector3(0, 1, 0);
const tmpForward = new Vector3();

// Heading of a camera orientation around +Y. Yaw 0 looks down -Z; positive
// yaw turns left (counter-clockwise seen from above), matching three.js.
export function yawOf(q) {
  tmpForward.set(0, 0, -1).applyQuaternion(q);
  return Math.atan2(-tmpForward.x, -tmpForward.z);
}

// Yaw that faces from `from` towards `to`, both [x, z] map points.
export function yawTowards(from, to) {
  return Math.atan2(-(to[0] - from[0]), -(to[1] - from[1]));
}

// Rotation to pre-multiply onto device orientations so that the current
// device orientation `q` ends up facing `targetYaw`.
export function headingCorrection(q, targetYaw) {
  return new Quaternion().setFromAxisAngle(UP, targetYaw - yawOf(q));
}

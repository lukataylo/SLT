// Wire protocol shared by the server and the browser client.
//
// Text messages are JSON objects with a `t` (type) field.
// Video frames are binary: [u16 metaLen, big-endian][meta JSON, UTF-8][JPEG bytes]
// Frame meta carries the sender's pose at capture time so every frame can be
// placed in the shared map frame independently of the pose stream.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const MAX_META_BYTES = 0xffff;

export function encodeFrame(meta, jpeg) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  if (metaBytes.length > MAX_META_BYTES) throw new RangeError('frame meta too large');
  const body = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
  const out = new Uint8Array(2 + metaBytes.length + body.length);
  out[0] = metaBytes.length >> 8;
  out[1] = metaBytes.length & 0xff;
  out.set(metaBytes, 2);
  out.set(body, 2 + metaBytes.length);
  return out;
}

export function decodeFrame(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 2) throw new RangeError('frame too short');
  const metaLen = (bytes[0] << 8) | bytes[1];
  if (bytes.length < 2 + metaLen) throw new RangeError('frame truncated');
  const meta = JSON.parse(decoder.decode(bytes.subarray(2, 2 + metaLen)));
  return { meta, jpeg: bytes.subarray(2 + metaLen) };
}

const isFiniteArray = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);

// A pose is a position `p` [x, y, z] in metres and an orientation `q`
// [x, y, z, w] in the map frame (Y up, camera looks down -Z, three.js convention).
export function isValidPose(pose) {
  return pose != null && isFiniteArray(pose.p, 3) && isFiniteArray(pose.q, 4);
}

// Optional camera intrinsics that travel with a pose: vertical FOV in degrees
// and width/height aspect of the image.
export function pickPose(src) {
  const pose = { p: src.p, q: src.q };
  if (Number.isFinite(src.fov) && src.fov > 1 && src.fov < 179) pose.fov = src.fov;
  if (Number.isFinite(src.aspect) && src.aspect > 0.1 && src.aspect < 10) pose.aspect = src.aspect;
  return pose;
}

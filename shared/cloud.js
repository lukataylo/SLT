// Binary snapshot of the LiDAR splat clouds, per room (little-endian):
//   u32 magic 'SLTC', u32 version = 1, u32 roomCount, then per room:
//   u16 idLength, id (UTF-8), pad to 4 bytes, u32 count,
//   count*3 f32 xyz, count*3 u8 rgb, count*3 i8 normal (unit * 127), pad to 4.
// JSON for ~300k points per room would be tens of megabytes; this is ~15 B/point.

export const CLOUD_MAGIC = 0x43544c53; // 'SLTC' read as little-endian u32
const pad4 = (n) => (4 - (n % 4)) % 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// rooms: [{ id, points: number[] xyz, colors: number[] rgb, normals: number[] xyz }]
export function encodeClouds(rooms) {
  const ids = rooms.map((r) => encoder.encode(r.id));
  let size = 12;
  rooms.forEach((r, i) => {
    const n = r.points.length / 3;
    size += 2 + ids[i].length + pad4(2 + ids[i].length) + 4 + n * 12 + n * 6 + pad4(n * 6);
  });
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  view.setUint32(o, CLOUD_MAGIC, true);
  view.setUint32(o + 4, 1, true);
  view.setUint32(o + 8, rooms.length, true);
  o = 12;
  rooms.forEach((r, i) => {
    const n = r.points.length / 3;
    view.setUint16(o, ids[i].length, true);
    bytes.set(ids[i], o + 2);
    o += 2 + ids[i].length;
    o += pad4(o);
    view.setUint32(o, n, true);
    o += 4;
    for (let k = 0; k < n * 3; k++, o += 4) view.setFloat32(o, r.points[k], true);
    for (let k = 0; k < n * 3; k++) bytes[o++] = r.colors?.[k] ?? 150;
    for (let k = 0; k < n * 3; k++) view.setInt8(o++, r.normals?.[k] ?? 0);
    o += pad4(o);
  });
  return new Uint8Array(buf);
}

export function decodeClouds(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || view.getUint32(0, true) !== CLOUD_MAGIC) throw new Error('not a cloud snapshot');
  const rooms = [];
  let o = 12;
  for (let r = view.getUint32(8, true); r > 0; r--) {
    const idLen = view.getUint16(o, true);
    const id = decoder.decode(bytes.subarray(o + 2, o + 2 + idLen));
    o += 2 + idLen;
    o += pad4(o);
    const n = view.getUint32(o, true);
    o += 4;
    const points = new Array(n * 3);
    for (let k = 0; k < n * 3; k++, o += 4) points[k] = view.getFloat32(o, true);
    const colors = Array.from(bytes.subarray(o, o + n * 3));
    o += n * 3;
    const normals = new Array(n * 3);
    for (let k = 0; k < n * 3; k++) normals[k] = view.getInt8(o++);
    o += pad4(o);
    rooms.push({ id, points, colors, normals });
  }
  return rooms;
}

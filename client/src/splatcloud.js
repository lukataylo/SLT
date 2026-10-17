import { PackedSplats, SplatMesh, utils } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { decodeClouds } from '../../shared/cloud.js';

// The LiDAR scan as Gaussian splats: every 5 cm voxel the phones send becomes
// one surfel-shaped splat in its true camera colour, flattened along the
// surface normal, so dense regions blend into a continuous photographic surface.
// Shared by the admin bird's-eye view and the main web viewer.

const CHUNK = 16384; // splats per SplatMesh; new points fill the last chunk, then open a new one
const IN_PLANE = 0.042; // splat std-dev along the surface, metres: overlaps neighbouring 5 cm voxels
const THIN = 0.008; // ... and along the normal
const ROUND = 0.032; // when the normal is unknown
const OPACITY = 0.92;
const GREY = 150;

// Height -> colour: deep green at the floor, through teal and cyan, to blue at
// ceiling height (the depth gradient from the admin reference image).
export const DEPTH_STOPS = [
  [0.0, new THREE.Color(0x0a6b32)],
  [0.35, new THREE.Color(0x16b25c)],
  [1.1, new THREE.Color(0x19c9a6)],
  [1.9, new THREE.Color(0x27c6ea)],
  [2.8, new THREE.Color(0x2f6dff)],
];

export function depthColor(y, out = new THREE.Color()) {
  if (y <= DEPTH_STOPS[0][0]) return out.copy(DEPTH_STOPS[0][1]);
  for (let i = 1; i < DEPTH_STOPS.length; i++) {
    const [y1, c1] = DEPTH_STOPS[i];
    if (y <= y1) {
      const [y0, c0] = DEPTH_STOPS[i - 1];
      return out.copy(c0).lerp(c1, (y - y0) / (y1 - y0));
    }
  }
  return out.copy(DEPTH_STOPS.at(-1)[1]);
}

class Chunk {
  constructor(origin) {
    this.origin = origin;
    this.n = 0;
    this.pos = new Float32Array(CHUNK * 3); // relative to origin
    this.col = new Uint8Array(CHUNK * 3);
    this.nrm = new Int8Array(CHUNK * 3);
    this.packed = new PackedSplats({ maxSplats: CHUNK });
    this.packed.ensureSplats(CHUNK);
    this.mesh = new SplatMesh({ packedSplats: this.packed });
    // Centres are stored as half floats, so keep them local to the chunk.
    this.mesh.position.copy(origin);
    this.mesh.frustumCulled = false;
  }

  get full() {
    return this.n >= CHUNK;
  }

  packRange(from, to, mode, clipY) {
    const arr = this.packed.packedArray;
    const c = new THREE.Color();
    for (let i = from; i < to; i++) {
      const k = i * 3;
      const x = this.pos[k], y = this.pos[k + 1], z = this.pos[k + 2];
      let nx = this.nrm[k], ny = this.nrm[k + 1], nz = this.nrm[k + 2];
      const len = Math.hypot(nx, ny, nz);
      let qx = 0, qy = 0, qz = 0, qw = 1;
      let sx = ROUND, sy = ROUND, sz = ROUND;
      if (len > 1) {
        nx /= len; ny /= len; nz /= len;
        // Rotation taking +Z (the splat's thin axis) onto the normal.
        if (nz < -0.9999) {
          qx = 1; qw = 0;
        } else {
          qx = -ny; qy = nx; qz = 0; qw = 1 + nz;
          const ql = Math.hypot(qx, qy, qw);
          qx /= ql; qy /= ql; qw /= ql;
        }
        sx = sy = IN_PLANE;
        sz = THIN;
      }
      // Camera colours arrive as sRGB; the renderer works in linear and
      // encodes to sRGB on output, so convert here like any three.js colour.
      if (mode === 'depth') depthColor(y + this.origin.y, c);
      else c.setRGB(this.col[k] / 255, this.col[k + 1] / 255, this.col[k + 2] / 255, THREE.SRGBColorSpace);
      // Dollhouse cutaway: splats above the cut are kept but hidden.
      const opacity = clipY != null && y + this.origin.y > clipY ? 0 : OPACITY;
      utils.setPackedSplat(arr, i, x, y, z, sx, sy, sz, qx, qy, qz, qw, opacity, c.r, c.g, c.b);
    }
    this.packed.numSplats = this.n;
    this.packed.needsUpdate = true;
    this.mesh.needsUpdate = true;
  }

  dispose() {
    this.mesh.dispose();
    this.packed.dispose();
  }
}

export class SplatCloud {
  constructor({ mode = 'colour', opacity = 1 } = {}) {
    this.group = new THREE.Group();
    this.rooms = new Map();
    this.mode = mode;
    this.opacity = opacity;
    this.clipY = null;
    this.count = 0;
    this.box = new THREE.Box3();
    this.onChange = null;
  }

  // Replaces everything with a GET /api/cloud snapshot (format in shared/cloud.js).
  load(buffer) {
    this.reset(null);
    for (const r of decodeClouds(buffer)) this.append(r.id, r.points, r.colors, r.normals);
  }

  // points: flat xyz (metres, map frame); colors: flat rgb 0-255; normals:
  // flat xyz in -127..127. Missing colours/normals fall back to grey / round.
  append(roomId, points, colors, normals) {
    const total = Math.floor(points.length / 3);
    if (!total) return;
    let room = this.rooms.get(roomId);
    if (!room) this.rooms.set(roomId, (room = []));
    const v = new THREE.Vector3();
    let i = 0;
    while (i < total) {
      let chunk = room.at(-1);
      if (!chunk || chunk.full) {
        const origin = new THREE.Vector3(Math.round(points[i * 3]), 0, Math.round(points[i * 3 + 2]));
        chunk = new Chunk(origin);
        chunk.mesh.opacity = this.opacity;
        room.push(chunk);
        this.group.add(chunk.mesh);
      }
      const start = chunk.n;
      const take = Math.min(total - i, CHUNK - start);
      for (let j = 0; j < take; j++, i++) {
        const k = (start + j) * 3;
        const s = i * 3;
        chunk.pos[k] = points[s] - chunk.origin.x;
        chunk.pos[k + 1] = points[s + 1];
        chunk.pos[k + 2] = points[s + 2] - chunk.origin.z;
        chunk.col[k] = colors?.[s] ?? GREY;
        chunk.col[k + 1] = colors?.[s + 1] ?? GREY;
        chunk.col[k + 2] = colors?.[s + 2] ?? GREY;
        chunk.nrm[k] = normals?.[s] ?? 0;
        chunk.nrm[k + 1] = normals?.[s + 1] ?? 0;
        chunk.nrm[k + 2] = normals?.[s + 2] ?? 0;
        this.box.expandByPoint(v.set(points[s], points[s + 1], points[s + 2]));
      }
      chunk.n = start + take;
      chunk.packRange(start, chunk.n, this.mode, this.clipY);
      this.count += take;
    }
    this.onChange?.(this);
  }

  reset(roomId) {
    for (const [id, chunks] of this.rooms) {
      if (roomId != null && id !== roomId) continue;
      for (const c of chunks) {
        this.group.remove(c.mesh);
        c.dispose();
        this.count -= c.n;
      }
      this.rooms.delete(id);
    }
    this.box.makeEmpty();
    for (const chunks of this.rooms.values()) {
      for (const c of chunks) {
        for (let i = 0; i < c.n; i++) {
          this.box.expandByPoint(new THREE.Vector3(c.pos[i * 3] + c.origin.x, c.pos[i * 3 + 1], c.pos[i * 3 + 2] + c.origin.z));
        }
      }
    }
    this.onChange?.(this);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.repack();
  }

  // Hides everything above `y` metres (null shows all), to look into rooms from above.
  setCutaway(y) {
    if (y === this.clipY) return;
    this.clipY = y;
    this.repack();
  }

  repack() {
    for (const chunks of this.rooms.values()) for (const c of chunks) c.packRange(0, c.n, this.mode, this.clipY);
  }

  setOpacity(v) {
    this.opacity = v;
    for (const chunks of this.rooms.values()) for (const c of chunks) c.mesh.opacity = v;
  }
}

// Fetches the cloud snapshot, sending the admin token when the page has one.
export async function fetchCloudSnapshot() {
  const token = new URLSearchParams(location.search).get('token');
  const res = await fetch('/api/cloud', { headers: token ? { 'x-admin-token': token } : {} });
  if (!res.ok) throw new Error(`cloud snapshot: HTTP ${res.status}`);
  return res.arrayBuffer();
}

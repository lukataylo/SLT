import { IDENTITY, isValidSegment, register, transformPoint2, transformPose, transformSegment } from '../shared/planes.js';
import { decodeFrame, encodeFrame, isValidPose, pickPose } from '../shared/protocol.js';
import { LiveMap } from './livemap.js';

// Frames are dropped for a receiver whose socket already has this much queued,
// so one slow phone can't build up latency for itself or stall the relay.
export const MAX_BUFFERED_BYTES = 512 * 1024;
export const LIVE_WINDOW_MS = 3000;
export const MAX_WALLS_PER_PEER = 300;
const MAX_OPENINGS_PER_PEER = 100;
const MAX_FLOOR_POINTS = 400;
const MAX_CLOUD_PER_MESSAGE = 3 * 8000;
const ADMIN_FRAME_INTERVAL_MS = 500;
const PAIRING_CODE_TTL_MS = 3000;

// How sure registration must be before a phone's poses are trusted in the map.
const MIN_INLIER_FRACTION = 0.6;
const MIN_INLIER_LENGTH = 2; // metres of wall that agree with the map
const MAX_STEP_M = 0.5; // largest correction applied to a placed phone at once
const MAX_STEP_YAW = (5 * Math.PI) / 180;
const BLEND = 0.5; // move halfway to each new fit, smoothing scan noise
const JUMP_CONFIRMATIONS = 3;

const OPEN = 1;

function cleanName(name, fallback) {
  const s = String(name ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 24);
  return s || fallback;
}

// One shared space: every connected phone is both a feed and a viewer.
//
// Browser peers send poses already in the map frame. LiDAR peers (the iOS app)
// send poses in their own ARKit frame plus the wall planes they detect; the
// room aligns each one to the shared floor plan and converts its poses before
// relaying them. Until a LiDAR peer is aligned, its poses and frames are held back.
export class Room {
  constructor({ recorder = null, now = Date.now, map = new LiveMap() } = {}) {
    this.map = map;
    this.peers = new Map();
    this.admins = new Map();
    // QR pairing codes on display: code -> { peerId, name, m, at }.
    this.pairingCodes = new Map();
    this.nextId = 1;
    this.recorder = recorder;
    this.now = now;
    this.stats = { framesIn: 0, framesOut: 0, framesDropped: 0 };
  }

  join(socket, { name, frame, role } = {}) {
    const id = `p${this.nextId++}`;
    if (role === 'admin') {
      // Admin viewers watch everything but are not peers: nobody sees them.
      // Clouds are fetched separately as a binary snapshot (GET /api/cloud).
      this.admins.set(id, { id, socket, lastFrameSent: new Map() });
      this.sendJson({ socket }, { t: 'admin', map: this.map.toJSON(), devices: this.devices() });
      return id;
    }
    const peer = { id, name: cleanName(name, id), socket, pose: null, lastFrame: null, lastFrameAt: 0, lastSeenAt: this.now() };
    if (frame === 'local') {
      Object.assign(peer, { local: true, alignment: null, localWalls: [], localOpenings: [], localFloor: [], floorY: null, roomId: null });
    }
    this.sendJson(peer, { t: 'welcome', id, name: peer.name, peers: this.snapshot(id), map: this.map.toJSON() });
    for (const other of this.peers.values()) {
      if (other.lastFrame) this.sendBinary(peer, other.lastFrame);
    }
    this.peers.set(id, peer);
    this.broadcastJson({ t: 'join', id, name: peer.name }, id);
    return id;
  }

  leave(id) {
    if (this.admins.delete(id)) return;
    const peer = this.peers.get(id);
    if (!peer) return;
    for (const [code, shown] of this.pairingCodes) if (shown.peerId === id) this.pairingCodes.delete(code);
    this.peers.delete(id);
    this.broadcastJson({ t: 'leave', id }, id);
    if (peer.alignment) {
      this.map.commit(id);
      this.broadcastMap();
    }
  }

  // Poses from LiDAR peers are converted into the map frame, or dropped while
  // that peer is still unaligned.
  toMapPose(peer, pose) {
    if (!peer.local) return pose;
    return peer.alignment ? transformPose(pose, peer.alignment) : null;
  }

  handleText(id, text) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.lastSeenAt = this.now();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg?.t === 'pose' && isValidPose(msg)) {
      const pose = this.toMapPose(peer, pickPose(msg));
      if (!pose) return;
      peer.pose = pose;
      this.broadcastJson({ t: 'pose', id, ...pose }, id);
    } else if (msg?.t === 'planes' && peer.local && Array.isArray(msg.walls)) {
      peer.localWalls = msg.walls.filter(isValidSegment).slice(0, MAX_WALLS_PER_PEER);
      peer.localOpenings = (Array.isArray(msg.openings) ? msg.openings : [])
        .filter((o) => (o?.kind === 'door' || o?.kind === 'window') && isValidSegment(o.s) && Number.isFinite(o.y0) && Number.isFinite(o.y1))
        .slice(0, MAX_OPENINGS_PER_PEER);
      peer.localFloor = (Array.isArray(msg.floor) ? msg.floor : [])
        .filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
        .slice(0, MAX_FLOOR_POINTS);
      if (Number.isFinite(msg.floorY)) peer.floorY = msg.floorY;
      this.alignPeer(peer);
    } else if (msg?.t === 'cloud' && peer.local && Array.isArray(msg.points)) {
      const n = MAX_CLOUD_PER_MESSAGE;
      const list = (a) => (Array.isArray(a) ? a.slice(0, n) : []);
      this.addCloud(peer, msg.points.slice(0, n), list(msg.colors), list(msg.normals));
    } else if (msg?.t === 'room' && peer.local) {
      this.roomCommand(peer, msg);
    } else if (msg?.t === 'collab' && peer.local && typeof msg.data === 'string') {
      // ARKit collaboration data: opaque to us, relayed to the other LiDAR
      // phones so their sessions merge into one shared coordinate space.
      const text = JSON.stringify({ t: 'collab', from: id, data: msg.data });
      for (const p of this.peers.values()) if (p.local && p.id !== id && p.socket.readyState === OPEN) p.socket.send(text);
    } else if (msg?.t === 'pair' && peer.local) {
      this.pairPeer(peer, msg.alignment);
    } else if (msg?.t === 'pairing' && peer.local) {
      this.pairingMessage(peer, msg);
    }
  }

  // QR pairing. The phone showing a code streams where that code is on the
  // map (a 4x4 matrix, column-major, from its own tracking + alignment). The
  // phone that scans it measures the code in its own frame and claims it: the
  // two poses of one physical code give its alignment directly.
  pairingMessage(peer, msg) {
    const code = typeof msg.code === 'string' ? msg.code.slice(0, 64) : null;
    if (!code) return;
    if (msg.action === 'show') {
      const m = msg.m;
      if (!peer.alignment || !Array.isArray(m) || m.length !== 16 || !m.every(Number.isFinite)) return;
      const existing = this.pairingCodes.get(code);
      if (existing && existing.peerId !== peer.id) return; // someone else's code
      // Codes expire; keep the table small.
      for (const [c, shown] of this.pairingCodes) if (this.now() - shown.at > PAIRING_CODE_TTL_MS) this.pairingCodes.delete(c);
      if (!existing && this.pairingCodes.size >= 100) return;
      this.pairingCodes.set(code, { peerId: peer.id, name: peer.name, m, at: this.now() });
    } else if (msg.action === 'hide') {
      if (this.pairingCodes.get(code)?.peerId === peer.id) this.pairingCodes.delete(code);
    } else if (msg.action === 'claim') {
      const shown = this.pairingCodes.get(code);
      if (!shown || this.now() - shown.at > PAIRING_CODE_TTL_MS || shown.peerId === peer.id) {
        return this.sendJson(peer, { t: 'pairing', action: 'unknown', code });
      }
      peer.pairingWith = shown.peerId;
      this.sendJson(peer, { t: 'pairing', action: 'pose', code, m: shown.m, by: shown.name });
    }
  }

  // A phone whose ARKit session merged with an aligned phone's receives that
  // phone's map-origin anchor, and from it computes its own alignment exactly.
  pairPeer(peer, a) {
    const valid = a && Number.isFinite(a.yaw) && Array.isArray(a.t) && a.t.length === 3 && a.t.every(Number.isFinite);
    if (!valid || !this.map.origin) return;
    const vouched = peer.pairingWith || [...this.peers.values()].some((p) => p !== peer && p.local && p.alignment);
    if (!vouched) return;
    peer.alignment = { yaw: a.yaw, t: [...a.t] };
    peer.pendingJump = null;
    const shower = peer.pairingWith && this.peers.get(peer.pairingWith);
    if (shower) this.sendJson(shower, { t: 'pairing', action: 'done', by: peer.name });
    peer.pairingWith = null;
    if (!peer.roomId || !this.map.room(peer.roomId)) peer.roomId = this.map.roomAt(transformPoint2(0, 0, peer.alignment))?.id ?? null;
    this.sendAlign(peer, { method: 'paired', correction: 'locked' });
    this.broadcastMap();
  }

  // --- Rooms ------------------------------------------------------------------

  roomCommand(peer, msg) {
    if (msg.action === 'reset-map') {
      this.map.resetAll();
      for (const p of this.peers.values()) {
        if (!p.local) continue;
        Object.assign(p, { alignment: null, roomId: null, pendingJump: null });
        this.sendJson(p, { t: 'reset', scope: 'map' });
        this.sendAlign(p, null);
      }
      this.broadcastCloudReset(null);
      this.broadcastMap();
      return;
    }
    if (!peer.alignment) return;
    if (msg.action === 'new') {
      // A new room starts where this phone stands; its walls so far stay with
      // the room they were scanned in.
      this.map.commit(peer.id);
      const here = this.mapPosition(peer) ?? [0, 0];
      const planRoom = this.map.plan?.rooms?.find((r) => r.id === msg.planRoomId);
      const room = this.map.createRoom({
        name: msg.name || planRoom?.name,
        origin: here.map((v) => Math.round(v * 1000) / 1000),
        planRoomId: planRoom?.id ?? null,
        at: new Date(this.now()).toISOString(),
      });
      this.enterRoom(peer, room.id);
    } else if (msg.action === 'rename' && this.map.room(msg.roomId)) {
      const room = this.map.room(msg.roomId);
      if (typeof msg.name === 'string' && msg.name.trim()) room.name = msg.name.trim().slice(0, 40);
      if (msg.planRoomId !== undefined) room.planRoomId = this.map.plan?.rooms?.some((r) => r.id === msg.planRoomId) ? msg.planRoomId : null;
      this.map.changed();
      this.broadcastMap();
    } else if (msg.action === 'switch' && this.map.room(msg.roomId)) {
      this.map.commit(peer.id);
      this.enterRoom(peer, msg.roomId);
    } else if (msg.action === 'reset-room') {
      const roomId = this.map.room(msg.roomId) ? msg.roomId : peer.roomId;
      if (!this.map.resetRoom(roomId)) return;
      for (const p of this.peers.values()) {
        if (p.local && p.roomId === roomId) this.sendJson(p, { t: 'reset', scope: 'room', roomId });
      }
      this.broadcastCloudReset(roomId);
      this.broadcastMap();
    }
  }

  // The phone clears its local plane anchors on entering a room, so only what
  // it scans from here on is attributed to the new room. Tracking (and so the
  // alignment) carries over.
  enterRoom(peer, roomId) {
    peer.roomId = roomId;
    peer.localWalls = [];
    peer.localOpenings = [];
    peer.localFloor = [];
    this.sendJson(peer, { t: 'reset', scope: 'room', roomId });
    this.sendAlign(peer, null);
    this.broadcastMap();
  }

  mapPosition(peer) {
    return peer.pose ? [peer.pose.p[0], peer.pose.p[2]] : null;
  }

  addCloud(peer, flat, colors, normals) {
    if (!peer.alignment || !peer.roomId) return;
    const T = peer.alignment;
    const rot = { yaw: T.yaw, t: [0, 0, 0] };
    const out = new Array(flat.length);
    const outNormals = new Array(normals.length);
    for (let i = 0; i + 2 < flat.length; i += 3) {
      const [x, z] = transformPoint2(flat[i], flat[i + 2], T);
      out[i] = x;
      out[i + 1] = flat[i + 1] + T.t[1];
      out[i + 2] = z;
      if (i + 2 < normals.length) {
        // Normals only rotate.
        const [nx, nz] = transformPoint2(normals[i], normals[i + 2], rot);
        outNormals[i] = nx;
        outNormals[i + 1] = normals[i + 1];
        outNormals[i + 2] = nz;
      }
    }
    const added = this.map.addCloud(peer.roomId, out, colors, outNormals);
    if (!added.points.length) return;
    // Viewers (admins and browsers) draw the cloud; LiDAR phones don't need it.
    const text = JSON.stringify({ t: 'cloud', roomId: peer.roomId, ...added });
    for (const a of this.admins.values()) if (a.socket.readyState === OPEN) a.socket.send(text);
    for (const p of this.peers.values()) if (!p.local && p.socket.readyState === OPEN) p.socket.send(text);
  }

  alignPeer(peer) {
    // Ground first: the map's floor is y = 0, so a phone can't found or join
    // the map until it has found the floor it stands on.
    if (peer.floorY == null) return this.sendAlign(peer, { method: 'floor', correction: 'none' });
    const floorDy = -peer.floorY;
    let result = null;
    const anyoneElseAligned = [...this.peers.values()].some((p) => p !== peer && p.alignment);
    if (!this.map.origin && !peer.alignment && !anyoneElseAligned) {
      // No fixed origin yet: this phone founds the map frame where it stands,
      // grounded on its floor. The origin is saved and never re-founded.
      this.map.found({ by: peer.name, at: new Date(this.now()).toISOString() });
      peer.alignment = { yaw: 0, t: [0, floorDy, 0] };
      result = { method: 'origin', correction: 'locked' };
    } else {
      const anchors = this.map.anchorsFor(peer.id);
      const fit = anchors.length ? register(peer.localWalls, anchors, { initial: peer.alignment }) : null;
      const good = fit && !fit.ambiguous && fit.inlierFraction >= MIN_INLIER_FRACTION && fit.inlierLength >= MIN_INLIER_LENGTH;
      const correction = good ? this.correct(peer, { yaw: fit.yaw, t: [fit.t[0], floorDy, fit.t[2]] }) : 'none';
      result = { method: 'walls', ...fit, correction };
    }
    if (peer.alignment) {
      if (!peer.roomId || !this.map.room(peer.roomId)) {
        const T = peer.alignment;
        const here = this.mapPosition(peer) ?? transformPoint2(0, 0, T);
        peer.roomId = this.map.roomAt(here)?.id ?? null;
      }
      const T = peer.alignment;
      this.map.setContribution(peer.id, {
        roomId: peer.roomId,
        walls: peer.localWalls.map((s) => transformSegment(s, T)),
        openings: peer.localOpenings.map((o) => ({ kind: o.kind, s: transformSegment(o.s, T), y0: o.y0 + T.t[1], y1: o.y1 + T.t[1] })),
        floor: peer.localFloor.map(([x, z]) => transformPoint2(x, z, T)),
      });
      // Lay an uploaded floor plan onto the scan as soon as it fits.
      if (this.map.plan && !this.map.plan.placement && this.map.plan.rooms?.length) this.map.autoPlace();
      this.broadcastMap();
    }
    this.sendAlign(peer, result);
  }

  // Once placed, a phone only takes small, blended corrections, so map matches
  // refine its position locally instead of yanking it around. A large jump is
  // believed only after it repeats consistently (e.g. ARKit relocalised).
  correct(peer, next) {
    const cur = peer.alignment;
    if (!cur) {
      peer.alignment = next;
      return 'locked';
    }
    const dyaw = Math.atan2(Math.sin(next.yaw - cur.yaw), Math.cos(next.yaw - cur.yaw));
    const dx = next.t[0] - cur.t[0];
    const dz = next.t[2] - cur.t[2];
    if (Math.abs(dyaw) <= MAX_STEP_YAW && Math.hypot(dx, dz) <= MAX_STEP_M) {
      peer.alignment = { yaw: cur.yaw + dyaw * BLEND, t: [cur.t[0] + dx * BLEND, next.t[1], cur.t[2] + dz * BLEND] };
      peer.pendingJump = null;
      return 'refined';
    }
    const pending = peer.pendingJump;
    const same =
      pending &&
      Math.abs(Math.atan2(Math.sin(pending.yaw - next.yaw), Math.cos(pending.yaw - next.yaw))) < MAX_STEP_YAW &&
      Math.hypot(pending.t[0] - next.t[0], pending.t[2] - next.t[2]) < 0.2;
    peer.pendingJump = same ? { ...next, count: pending.count + 1 } : { ...next, count: 1 };
    if (peer.pendingJump.count < JUMP_CONFIRMATIONS) return 'held';
    peer.alignment = next;
    peer.pendingJump = null;
    return 'relocated';
  }

  sendAlign(peer, result) {
    this.sendJson(peer, {
      t: 'align',
      aligned: !!peer.alignment,
      alignment: peer.alignment ?? IDENTITY,
      origin: this.map.origin,
      walls: peer.localWalls.length,
      roomId: peer.roomId,
      needsFloor: peer.floorY == null,
      ...(result && {
        method: result.method,
        correction: result.correction,
        inlierFraction: result.inlierFraction,
        rms: Number.isFinite(result.rms) ? result.rms : undefined,
        ambiguous: result.ambiguous,
      }),
    });
  }

  broadcastMap() {
    const msg = { t: 'map', ...this.map.toJSON() };
    this.broadcastJson(msg);
    this.broadcastAdmins(msg);
  }

  broadcastCloudReset(roomId) {
    const msg = { t: 'cloud-reset', roomId };
    this.broadcastAdmins(msg);
    for (const p of this.peers.values()) if (!p.local) this.sendJson(p, msg);
  }

  broadcastAdmins(msg) {
    if (!this.admins.size) return;
    const text = JSON.stringify(msg);
    for (const a of this.admins.values()) if (a.socket.readyState === OPEN) a.socket.send(text);
  }

  devices() {
    const now = this.now();
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.local ? 'lidar' : 'web',
      pose: p.pose,
      aligned: p.local ? !!p.alignment : true,
      roomId: p.roomId ?? null,
      // live: streaming video; online: sent anything (pose, scan, frame) recently.
      live: now - p.lastFrameAt < LIVE_WINDOW_MS,
      online: now - p.lastSeenAt < LIVE_WINDOW_MS,
    }));
  }

  broadcastDevices() {
    this.broadcastAdmins({ t: 'devices', devices: this.devices() });
  }

  handleFrame(id, data) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.lastSeenAt = this.now();
    let frame;
    try {
      frame = decodeFrame(data);
    } catch {
      return;
    }
    if (!isValidPose(frame.meta) || frame.jpeg.length === 0) return;
    const pose = this.toMapPose(peer, pickPose(frame.meta));
    if (!pose) return;
    this.stats.framesIn++;
    peer.pose = pose;
    peer.lastFrameAt = this.now();
    // Re-stamp with the server's id and clock so clients can't spoof each other.
    const meta = { id, ts: peer.lastFrameAt, ...peer.pose };
    peer.lastFrame = encodeFrame(meta, frame.jpeg);
    for (const other of this.peers.values()) {
      if (other.id !== id) this.sendBinary(other, peer.lastFrame);
    }
    // Admins see each device's camera as a picture on its beacon: 2 fps is plenty.
    for (const admin of this.admins.values()) {
      if (peer.lastFrameAt - (admin.lastFrameSent.get(id) ?? 0) < ADMIN_FRAME_INTERVAL_MS) continue;
      admin.lastFrameSent.set(id, peer.lastFrameAt);
      this.sendBinary(admin, peer.lastFrame);
    }
    this.recorder?.write(id, meta, frame.jpeg);
  }

  snapshot(excludeId) {
    const now = this.now();
    return [...this.peers.values()]
      .filter((p) => p.id !== excludeId)
      .map((p) => ({ id: p.id, name: p.name, pose: p.pose, live: now - p.lastFrameAt < LIVE_WINDOW_MS }));
  }

  sendJson(peer, msg) {
    if (peer.socket.readyState === OPEN) peer.socket.send(JSON.stringify(msg));
  }

  broadcastJson(msg, excludeId) {
    const text = JSON.stringify(msg);
    for (const peer of this.peers.values()) {
      if (peer.id !== excludeId && peer.socket.readyState === OPEN) peer.socket.send(text);
    }
  }

  sendBinary(peer, bytes) {
    const { socket } = peer;
    if (socket.readyState !== OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.stats.framesDropped++;
      return;
    }
    socket.send(bytes);
    this.stats.framesOut++;
  }
}

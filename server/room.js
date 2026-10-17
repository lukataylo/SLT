import { IDENTITY, isValidSegment, register, transformPose, transformSegment } from '../shared/planes.js';
import { decodeFrame, encodeFrame, isValidPose, pickPose } from '../shared/protocol.js';
import { LiveMap } from './livemap.js';

// Frames are dropped for a receiver whose socket already has this much queued,
// so one slow phone can't build up latency for itself or stall the relay.
export const MAX_BUFFERED_BYTES = 512 * 1024;
export const LIVE_WINDOW_MS = 3000;
export const MAX_WALLS_PER_PEER = 300;

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
    this.nextId = 1;
    this.recorder = recorder;
    this.now = now;
    this.stats = { framesIn: 0, framesOut: 0, framesDropped: 0 };
  }

  join(socket, { name, frame } = {}) {
    const id = `p${this.nextId++}`;
    const peer = { id, name: cleanName(name, id), socket, pose: null, lastFrame: null, lastFrameAt: 0 };
    if (frame === 'local') Object.assign(peer, { local: true, alignment: null, localWalls: [], floorY: null });
    this.sendJson(peer, { t: 'welcome', id, name: peer.name, peers: this.snapshot(id), map: this.map.toJSON() });
    for (const other of this.peers.values()) {
      if (other.lastFrame) this.sendBinary(peer, other.lastFrame);
    }
    this.peers.set(id, peer);
    this.broadcastJson({ t: 'join', id, name: peer.name }, id);
    return id;
  }

  leave(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
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
      if (Number.isFinite(msg.floorY)) peer.floorY = msg.floorY;
      this.alignPeer(peer);
    }
  }

  alignPeer(peer) {
    const floorDy = -(peer.floorY ?? 0);
    let result = null;
    const anyoneElseAligned = [...this.peers.values()].some((p) => p !== peer && p.alignment);
    if (!this.map.origin && !peer.alignment && !anyoneElseAligned) {
      // No fixed origin yet: this phone's scan founds the map frame. The
      // origin is saved with the map and never re-founded afterwards.
      if (!peer.localWalls.length) return this.sendAlign(peer, null);
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
      this.map.setContribution(
        peer.id,
        peer.localWalls.map((s) => transformSegment(s, peer.alignment)),
      );
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
    this.broadcastJson({ t: 'map', ...this.map.toJSON() });
  }

  handleFrame(id, data) {
    const peer = this.peers.get(id);
    if (!peer) return;
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

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
    const floor = [0, -(peer.floorY ?? 0), 0];
    const others = this.map.wallsExcluding(peer.id);
    const anyoneElseAligned = [...this.peers.values()].some((p) => p !== peer && p.alignment);
    let result = null;
    if (!others.length && !anyoneElseAligned && !peer.alignment) {
      // First LiDAR phone in an empty map: its frame becomes the map frame.
      peer.alignment = { yaw: 0, t: floor };
      result = { method: 'origin' };
    } else if (others.length) {
      const fit = register(peer.localWalls, others, { initial: peer.alignment && { ...peer.alignment, t: [...peer.alignment.t] } });
      const good = fit && !fit.ambiguous && fit.inlierFraction >= MIN_INLIER_FRACTION && fit.inlierLength >= MIN_INLIER_LENGTH;
      if (good) peer.alignment = { yaw: fit.yaw, t: [fit.t[0], floor[1], fit.t[2]] };
      result = fit ? { method: 'walls', ...fit, accepted: good } : { method: 'walls', accepted: false };
    }
    if (peer.alignment) {
      this.map.setContribution(
        peer.id,
        peer.localWalls.map((s) => transformSegment(s, peer.alignment)),
      );
      this.broadcastMap();
    }
    this.sendJson(peer, {
      t: 'align',
      aligned: !!peer.alignment,
      alignment: peer.alignment ?? IDENTITY,
      walls: peer.localWalls.length,
      ...(result && {
        method: result.method,
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

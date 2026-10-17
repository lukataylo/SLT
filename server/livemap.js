import { reinforce } from '../shared/planes.js';

// Walls confirmed by at least this many scan sessions anchor alignment, once
// there are enough of them to align against.
const REINFORCED_SEEN = 2;
const MIN_ANCHOR_LENGTH = 4; // metres

const segLen = (s) => Math.hypot(s[2] - s[0], s[3] - s[1]);

// The shared floor plan, in a fixed map frame.
//
// `origin` records the scan that founded the frame; once set it never moves,
// across sessions and restarts (when persisted). `base` holds walls with a
// `seen` count of how many scan sessions confirmed them. Phones currently
// scanning contribute their live walls on top; when a phone leaves, its
// session is committed into the base, reinforcing what it confirmed.
export class LiveMap {
  constructor({ base = [], origin = null, onChange = null } = {}) {
    this.base = base.map((w) => (Array.isArray(w) ? { s: w, seen: 1 } : w));
    this.origin = origin;
    this.contributions = new Map();
    this.onChange = onChange;
    this.version = 0;
    this.current = this.base;
  }

  get walls() {
    return this.current.map((w) => w.s);
  }

  found(origin) {
    if (this.origin) throw new Error('map origin is already fixed');
    this.origin = origin;
    this.onChange?.(this);
  }

  // Walls to align `peerId` against: everyone else's evidence, preferring
  // walls that several sessions have confirmed.
  anchorsFor(peerId) {
    const others = [...this.contributions].filter(([id]) => id !== peerId).flatMap(([, segs]) => segs);
    const all = reinforce(this.base, others);
    const strong = all.filter((w) => w.seen >= REINFORCED_SEEN);
    const strongLength = strong.reduce((sum, w) => sum + segLen(w.s), 0);
    return (strongLength >= MIN_ANCHOR_LENGTH ? strong : all).map((w) => w.s);
  }

  setContribution(peerId, segments) {
    this.contributions.set(peerId, segments);
    this.rebuild();
  }

  commit(peerId) {
    const segs = this.contributions.get(peerId);
    if (!segs) return;
    this.contributions.delete(peerId);
    this.base = reinforce(this.base, segs);
    this.rebuild();
  }

  commitAll() {
    for (const id of [...this.contributions.keys()]) this.commit(id);
  }

  // Each live session previews as one more confirmation of what it sees.
  rebuild() {
    let walls = this.base;
    for (const segs of this.contributions.values()) walls = reinforce(walls, segs);
    this.current = walls;
    this.version++;
    this.onChange?.(this);
  }

  toJSON() {
    const r = (v) => Math.round(v * 1000) / 1000;
    return {
      version: this.version,
      origin: this.origin,
      walls: this.current.map((w) => w.s.map(r)),
      seen: this.current.map((w) => w.seen),
    };
  }

  // What gets saved: only committed evidence, never live previews.
  toFile() {
    return { origin: this.origin, walls: this.base.map((w) => ({ s: w.s, seen: w.seen })) };
  }
}

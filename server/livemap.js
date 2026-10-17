import { mergeSegments } from '../shared/planes.js';

// The shared, vectorised floor plan. Each aligned LiDAR phone contributes the
// walls it currently sees (in map coordinates). When a phone leaves, its walls
// are folded into the permanent base so the map keeps growing.
export class LiveMap {
  constructor({ base = [], onChange = null } = {}) {
    this.base = mergeSegments(base);
    this.contributions = new Map();
    this.onChange = onChange;
    this.version = 0;
    this.walls = this.base;
  }

  // Map walls as seen by everyone except `peerId`; used to align that peer
  // without it matching against its own contribution.
  wallsExcluding(peerId) {
    const others = [...this.contributions].filter(([id]) => id !== peerId).flatMap(([, segs]) => segs);
    return mergeSegments([...this.base, ...others]);
  }

  setContribution(peerId, segments) {
    this.contributions.set(peerId, segments);
    this.rebuild();
  }

  commit(peerId) {
    const segs = this.contributions.get(peerId);
    if (!segs) return;
    this.contributions.delete(peerId);
    this.base = mergeSegments([...this.base, ...segs]);
    this.rebuild();
  }

  rebuild() {
    this.walls = mergeSegments([...this.base, ...[...this.contributions.values()].flat()]);
    this.version++;
    this.onChange?.(this);
  }

  toJSON() {
    return { version: this.version, walls: this.walls.map((s) => s.map((v) => Math.round(v * 1000) / 1000)) };
  }
}

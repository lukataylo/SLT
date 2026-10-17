import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Writes every relayed frame to disk as <dir>/<session>/<peer>/<ts>.jpg plus a
// poses.jsonl per peer, so sessions can be replayed or fed back into splat
// training. Point RECORD_DIR at a VAST NFS/S3 mount to keep the archive there.
export class Recorder {
  constructor(dir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.root = path.join(dir, stamp);
    this.queues = new Map();
  }

  write(peerId, meta, jpeg) {
    const peerDir = path.join(this.root, peerId);
    const bytes = Buffer.from(jpeg);
    const prev = this.queues.get(peerId) ?? mkdir(peerDir, { recursive: true });
    const next = prev
      .then(() => writeFile(path.join(peerDir, `${meta.ts}.jpg`), bytes))
      .then(() => appendFile(path.join(peerDir, 'poses.jsonl'), JSON.stringify(meta) + '\n'))
      .catch((err) => console.error(`[recorder] ${peerId}:`, err.message));
    this.queues.set(peerId, next);
    return next;
  }
}

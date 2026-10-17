import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Wall reference photos on disk: one per wall direction per room, taken while
// the room was scanned (see LiveMap.setReference). A phone entering the room
// matches its camera against them to learn which way it faces.
//   GET /api/references/<roomId>/<id>.jpg

const MAX_JPEG = 200 * 1024;
const safe = (s) => /^[A-Za-z0-9_-]{1,40}$/.test(s);

export function referenceFiles(dir) {
  return {
    dir,
    // Writes a photo; resolves to its file name (relative to `dir`), or null.
    async save(roomId, jpeg) {
      if (!safe(roomId) || !jpeg.length || jpeg.length > MAX_JPEG) return null;
      const id = randomBytes(6).toString('hex');
      await mkdir(path.join(dir, roomId), { recursive: true });
      const file = path.join(roomId, `${id}.jpg`);
      await writeFile(path.join(dir, file), jpeg);
      return { id, file };
    },
    remove(file) {
      rm(path.join(dir, file), { force: true }).catch(() => {});
    },
  };
}

export function referenceApi({ map, dir }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/references/') || req.method !== 'GET') return false;
    const m = /^\/api\/references\/([^/]+)\/([^/]+)\.jpg$/.exec(url.pathname);
    const ref = m && safe(m[1]) && safe(m[2]) && map.room(m[1])?.references.find((r) => r?.id === m[2]);
    if (!ref) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'No such reference photo' }));
      return true;
    }
    // Ids are never reused, so a photo can be cached forever.
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' });
    createReadStream(path.join(dir, ref.file)).pipe(res);
    return true;
  };
}

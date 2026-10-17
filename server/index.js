import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { LiveMap } from './livemap.js';
import { Recorder } from './recorder.js';
import { Room } from './room.js';

const PORT = Number(process.env.PORT ?? 8787);
const STATIC_DIR = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const recorder = process.env.RECORD_DIR ? new Recorder(process.env.RECORD_DIR) : null;
const room = new Room({ recorder, map: loadMap(process.env.MAP_FILE) });

// The floor plan and its fixed origin survive restarts when MAP_FILE points at
// a persistent volume. Only committed scan sessions are saved.
function loadMap(file) {
  if (!file) return new LiveMap();
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`[map] loaded ${saved.walls?.length ?? 0} walls, origin ${saved.origin ? 'fixed' : 'unset'}`);
  } catch {}
  let timer = null;
  return new LiveMap({
    base: saved.walls ?? [],
    origin: saved.origin ?? null,
    onChange: (map) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        writeFile(file, JSON.stringify(map.toFile())).catch((err) => console.error('[map] save:', err.message));
      }, 2000);
    },
  });
}

// Railway stops containers with SIGTERM on redeploy: fold in the sessions of
// phones still scanning so their reinforcement isn't lost.
function shutdown() {
  room.map.commitAll();
  if (process.env.MAP_FILE) {
    try {
      writeFileSync(process.env.MAP_FILE, JSON.stringify(room.map.toFile()));
    } catch (err) {
      console.error('[map] save on exit:', err.message);
    }
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
};

// Vite fingerprints everything under /assets, so those can be cached forever;
// everything else (HTML, sw.js, manifest, maps) must revalidate on each load.
const cacheControl = (urlPath) =>
  urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';

// Minimal static server for the built client (production only; in dev Vite
// serves the client and proxies /ws here).
async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(STATIC_DIR, urlPath);
  if (!file.startsWith(STATIC_DIR)) return void res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const info = await stat(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': cacheControl(urlPath),
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ peers: room.peers.size, walls: room.map.walls.length, ...room.stats }));
  }
  if (req.url === '/map.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return void res.end(JSON.stringify(room.map));
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const id = room.join(ws, { name: params.get('name'), frame: params.get('frame') });
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data, isBinary) => (isBinary ? room.handleFrame(id, data) : room.handleText(id, data.toString())));
  ws.on('close', () => room.leave(id));
  console.log(`[room] ${id} joined (${room.peers.size} connected)`);
});

// Tunnels and mobile networks silently drop idle sockets; ping to detect them.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 15000).unref();

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}${recorder ? `, recording to ${recorder.root}` : ''}`);
});

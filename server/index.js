import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { decodeClouds, encodeClouds } from '../shared/cloud.js';
import { LiveMap } from './livemap.js';
import { planApi } from './plans.js';
import { Recorder } from './recorder.js';
import { Room } from './room.js';

const PORT = Number(process.env.PORT ?? 8787);
const STATIC_DIR = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const recorder = process.env.RECORD_DIR ? new Recorder(process.env.RECORD_DIR) : null;
const room = new Room({ recorder, map: loadMap(process.env.MAP_FILE) });
// Optional shared secret for the admin view and plan uploads.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const PLAN_DIR = process.env.MAP_FILE ? path.join(path.dirname(process.env.MAP_FILE), 'plans') : path.resolve('data/plans');
const handlePlan = planApi({ map: room.map, dir: PLAN_DIR, token: ADMIN_TOKEN, onChange: () => room.broadcastMap() });

// The floor plan and its fixed origin survive restarts when MAP_FILE points at
// a persistent volume. Only committed scan sessions are saved.
function loadMap(file) {
  if (!file) return new LiveMap();
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`[map] loaded ${saved.rooms?.length ?? 0} rooms, origin ${saved.origin ? 'fixed' : 'unset'}, plan ${saved.plan ? 'yes' : 'no'}`);
  } catch {}
  let timer = null;
  let cloudTimer = null;
  const map = new LiveMap({
    ...saved,
    onChange: (map) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        writeFile(file, JSON.stringify(map.toFile())).catch((err) => console.error('[map] save:', err.message));
      }, 2000);
    },
    // The coloured clouds are large, so they live in a binary file beside the
    // map and are written less eagerly.
    onCloudChange: (map) => {
      if (cloudTimer) return;
      cloudTimer = setTimeout(() => {
        cloudTimer = null;
        writeFile(cloudFile(file), encodeClouds(map.cloudRooms())).catch((err) => console.error('[cloud] save:', err.message));
      }, 10000);
    },
  });
  try {
    map.loadClouds(decodeClouds(readFileSync(cloudFile(file))));
    console.log(`[cloud] loaded ${map.rooms.reduce((n, r) => n + r.cloud.size, 0)} points`);
  } catch {}
  return map;
}

function cloudFile(mapFile) {
  return path.join(path.dirname(mapFile), 'cloud.bin');
}

// Railway stops containers with SIGTERM on redeploy: fold in the sessions of
// phones still scanning so their reinforcement isn't lost.
function shutdown() {
  room.map.commitAll();
  if (process.env.MAP_FILE) {
    try {
      writeFileSync(process.env.MAP_FILE, JSON.stringify(room.map.toFile()));
      writeFileSync(cloudFile(process.env.MAP_FILE), encodeClouds(room.map.cloudRooms()));
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
  '.mjs': 'text/javascript',
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

const server = createServer(async (req, res) => {
  if (await handlePlan(req, res)) return;
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ peers: room.peers.size, admins: room.admins.size, rooms: room.map.rooms.length, walls: room.map.walls.length, ...room.stats }));
  }
  // The splat cloud is what web viewers render, so it's as public as the app.
  if (req.url.startsWith('/api/cloud')) {
    const body = encodeClouds(room.map.cloudRooms());
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-cache' });
    return void res.end(body);
  }
  if (req.url === '/map.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return void res.end(JSON.stringify(room.map));
  }
  serveStatic(req, res);
});

// ARKit's first collaboration exchange between two phones can run to
// several megabytes, so the cap is generous.
const MAX_MESSAGE_BYTES = Number(process.env.MAX_MESSAGE_BYTES ?? 16 * 1024 * 1024);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const role = params.get('role');
  if (role === 'admin' && ADMIN_TOKEN && params.get('token') !== ADMIN_TOKEN) return void ws.close(4401, 'admin token required');
  const id = room.join(ws, { name: params.get('name'), frame: params.get('frame'), role });
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data, isBinary) => (isBinary ? room.handleFrame(id, data) : room.handleText(id, data.toString())));
  ws.on('close', () => room.leave(id));
  // One bad message (too large, malformed frame) must only cost that
  // connection; without a listener ws rethrows and the whole server dies.
  ws.on('error', (err) => {
    console.warn(`[room] ${id} socket error: ${err.code ?? err.message}`);
    ws.terminate();
  });
  console.log(`[room] ${id} joined (${room.peers.size} connected)`);
});

// Admin views follow every device at 5 Hz.
setInterval(() => room.broadcastDevices(), 200).unref();

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

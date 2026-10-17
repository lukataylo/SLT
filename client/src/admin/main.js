import { decodeFrame } from '../../../shared/protocol.js';
import { fetchCloudSnapshot } from '../splatcloud.js';
import { startMock } from './mock.js';
import { AdminScene } from './scene.js';

// Server -> admin contract (over /ws?role=admin):
//   {t:'admin', map, devices}                         once on connect; then GET /api/cloud
//   {t:'map', ...map}                                 map changed
//   {t:'devices', devices}                            ~5 Hz
//   {t:'cloud', roomId, points, colors, normals}      append splats (xyz m, rgb 0-255, normal x127)
//   {t:'cloud-reset', roomId}                         null = all rooms
//   binary video frames (shared/protocol.js)          <= 2 fps per device

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const scene = new AdminScene($('stage'));

const state = { map: null, devices: [], connected: false };
const pad = (n, w = 2) => String(n).padStart(w, '0');

function handle(msg) {
  switch (msg?.t) {
    case 'admin':
      setMap(msg.map);
      setDevices(msg.devices ?? []);
      if (msg.clouds) {
        scene.resetCloud(null);
        for (const [roomId, points] of Object.entries(msg.clouds)) scene.addCloud(roomId, points);
      } else if (!params.has('mock')) {
        fetchCloudSnapshot()
          .then((buf) => {
            scene.loadCloud(buf);
            renderStats();
          })
          .catch((err) => console.warn(err.message));
      }
      break;
    case 'map': {
      const { t, ...map } = msg;
      setMap(map);
      break;
    }
    case 'devices':
      setDevices(msg.devices ?? []);
      break;
    case 'cloud':
      if (Array.isArray(msg.points) && msg.points.length) scene.addCloud(msg.roomId ?? '_', msg.points, msg.colors, msg.normals);
      break;
    case 'cloud-reset':
      scene.resetCloud(msg.roomId ?? null);
      break;
    default:
      break;
  }
  renderStats();
}

// Latest camera frame per device: texture on its beacon and a list thumbnail.
const thumbs = new Map();
const decoding = new Set();
async function handleFrame(meta, jpeg) {
  if (!meta?.id || decoding.has(meta.id)) return;
  decoding.add(meta.id);
  try {
    const blob = new Blob([jpeg], { type: 'image/jpeg' });
    scene.setDeviceFrame(meta.id, await createImageBitmap(blob, { imageOrientation: 'flipY' }));
    const prev = thumbs.get(meta.id);
    if (prev) URL.revokeObjectURL(prev);
    const url = URL.createObjectURL(blob);
    thumbs.set(meta.id, url);
    const img = document.querySelector(`.device-row[data-id="${CSS.escape(meta.id)}"] img.thumb`);
    if (img) img.src = url;
  } catch (err) {
    console.warn('frame:', err.message);
  } finally {
    decoding.delete(meta.id);
  }
}

function setMap(map) {
  if (!map) return;
  state.map = map;
  scene.setMap(map);
  renderRooms();
  renderDevices();
}

function setDevices(devices) {
  state.devices = devices;
  scene.setDevices(devices);
  renderDevices();
}

// --- panels ------------------------------------------------------------

const roomName = (id) => state.map?.rooms?.find((r) => r.id === id)?.name ?? '—';

function renderDevices() {
  const list = $('devices');
  const rows = state.devices.map((d) => {
    const li = document.createElement('li');
    li.className = 'row device-row';
    li.tabIndex = 0;
    li.dataset.id = d.id;
    const status = d.kind === 'lidar' ? (d.aligned ? 'ALIGNED' : 'SEARCHING') : 'WEB';
    li.innerHTML = `
      <span class="dot ${(d.online ?? d.live) ? 'on' : ''}"></span>
      <img class="thumb" alt="" ${thumbs.has(d.id) ? `src="${thumbs.get(d.id)}"` : 'hidden'} />
      <span class="name"></span>
      <span class="chip ${d.kind}">${d.kind === 'lidar' ? 'LIDAR' : 'WEB'}</span>
      <span class="meta">${status} · ${roomName(d.roomId)}</span>`;
    li.querySelector('.name').textContent = d.name;
    const img = li.querySelector('img.thumb');
    img.addEventListener('load', () => (img.hidden = false));
    li.classList.toggle('dim', !(d.online ?? d.live) || (d.kind === 'lidar' && !d.aligned));
    return li;
  });
  list.replaceChildren(...rows);
  $('deviceCount').textContent = pad(state.devices.length);
  if (!rows.length) list.innerHTML = '<li class="empty">NO DEVICES CONNECTED</li>';
}

function renderRooms() {
  const rooms = state.map?.rooms ?? [];
  const rows = rooms.map((r) => {
    const doors = (r.openings ?? []).filter((o) => o.kind === 'door').length;
    const windows = (r.openings ?? []).filter((o) => o.kind === 'window').length;
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = `
      <span class="name"></span>
      <span class="meta">${pad(r.walls.length)} WALLS · ${doors} DOOR${doors === 1 ? '' : 'S'} · ${windows} WIN</span>
      <span class="meta origin">⊕ ${r.origin ? r.origin.map((v) => v.toFixed(1)).join(', ') : '—'}</span>`;
    li.querySelector('.name').textContent = r.name;
    return li;
  });
  $('rooms').replaceChildren(...rows);
  $('roomCount').textContent = pad(rooms.length);
  if (!rows.length) $('rooms').innerHTML = '<li class="empty">NO ROOMS SCANNED</li>';
  const o = state.map?.origin;
  $('origin').textContent = o ? `ORIGIN · ${o.by}`.toUpperCase() : 'NO ORIGIN YET';
}

function renderStats() {
  $('statWalls').textContent = pad(state.map?.walls?.length ?? 0);
  const pts = scene.cloudPoints;
  $('statPoints').textContent = pts >= 1000 ? `${(pts / 1000).toFixed(pts >= 1e5 ? 0 : 1)}K` : String(pts);
  $('statDevices').textContent = pad(state.devices.filter((d) => d.online ?? d.live).length);
}

$('devices').addEventListener('click', (e) => {
  const row = e.target.closest('.device-row');
  if (row) scene.focusOn(row.dataset.id);
});
$('devices').addEventListener('keydown', (e) => {
  const row = e.target.closest('.device-row');
  if (row && (e.key === 'Enter' || e.key === ' ')) scene.focusOn(row.dataset.id);
});
function setMode(mode) {
  scene.setMode(mode);
  document.body.dataset.mode = mode;
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  try {
    localStorage.setItem('slt.admin.mode', mode);
  } catch {}
}
for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
$('cutaway').addEventListener('click', () => {
  const on = $('cutaway').getAttribute('aria-pressed') !== 'true';
  $('cutaway').setAttribute('aria-pressed', String(on));
  scene.setCutaway(on);
});
// Height-coloured splats are the default look; true colour is one tap away.
let savedMode = 'depth';
try {
  savedMode = localStorage.getItem('slt.admin.mode') ?? 'depth';
} catch {}
setMode(savedMode === 'colour' ? 'colour' : 'depth');

for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => {
    document.body.dataset.tab = tab.dataset.tab;
    for (const t of document.querySelectorAll('[data-tab]')) t.setAttribute('aria-pressed', String(t === tab));
  });
}

function setConnected(on, label) {
  state.connected = on;
  $('conn').classList.toggle('on', on);
  $('connLabel').textContent = label;
}

// --- data source -------------------------------------------------------

if (params.has('mock')) {
  setConnected(true, 'MOCK');
  startMock(handle, handleFrame);
} else {
  let retry = 1000;
  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = params.get('token');
    const ws = new WebSocket(`${proto}://${location.host}/ws?role=admin${token ? `&token=${encodeURIComponent(token)}` : ''}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      retry = 1000;
      setConnected(true, 'LIVE');
    };
    ws.onmessage = (e) => {
      try {
        if (typeof e.data !== 'string') {
          const { meta, jpeg } = decodeFrame(e.data);
          handleFrame(meta, jpeg);
          return;
        }
        handle(JSON.parse(e.data));
      } catch (err) {
        console.warn('admin message:', err);
      }
    };
    ws.onclose = () => {
      setConnected(false, 'OFFLINE');
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 8000);
    };
  };
  connect();
}

renderDevices();
renderRooms();
renderStats();

const loop = (now) => {
  scene.render(now);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

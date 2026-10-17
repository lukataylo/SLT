import { startMock } from './mock.js';
import { AdminScene } from './scene.js';

// Server -> admin contract (JSON text over /ws?role=admin):
//   {t:'admin', map, devices, clouds:{[roomId]: [x,y,z,...]}}   once on connect
//   {t:'map', ...map}                                            map changed
//   {t:'devices', devices}                                       ~5 Hz
//   {t:'cloud', roomId, points:[x,y,z,...]}                      append points
//   {t:'cloud-reset', roomId}                                    null = all rooms

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const scene = new AdminScene($('stage'));

const state = { map: null, devices: [], connected: false };
const pad = (n, w = 2) => String(n).padStart(w, '0');

function handle(msg) {
  switch (msg?.t) {
    case 'admin':
      scene.resetCloud(null);
      setMap(msg.map);
      setDevices(msg.devices ?? []);
      for (const [roomId, points] of Object.entries(msg.clouds ?? {})) scene.addCloud(roomId, points);
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
      if (Array.isArray(msg.points) && msg.points.length) scene.addCloud(msg.roomId ?? '_', msg.points);
      break;
    case 'cloud-reset':
      scene.resetCloud(msg.roomId ?? null);
      break;
    default:
      break;
  }
  renderStats();
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
      <span class="name"></span>
      <span class="chip ${d.kind}">${d.kind === 'lidar' ? 'LIDAR' : 'WEB'}</span>
      <span class="meta">${status} · ${roomName(d.roomId)}</span>`;
    li.querySelector('.name').textContent = d.name;
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
  startMock(handle);
} else {
  let retry = 1000;
  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = params.get('token');
    const ws = new WebSocket(`${proto}://${location.host}/ws?role=admin${token ? `&token=${encodeURIComponent(token)}` : ''}`);
    ws.onopen = () => {
      retry = 1000;
      setConnected(true, 'LIVE');
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
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

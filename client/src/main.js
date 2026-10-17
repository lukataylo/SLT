import { yawTowards } from './align.js';
import { Camera } from './camera.js';
import { Minimap } from './minimap.js';
import { Net } from './net.js';
import { MotionPose } from './pose/motion.js';
import { SimPose } from './pose/sim.js';
import { World } from './scene.js';

const POSE_HZ = 15;
const FRAME_FPS = 8;

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker:', err));
}
$(isTouch ? 'modeMotion' : 'modeSim').checked = true;
$('share').checked = isTouch;
try {
  $('name').value = localStorage.getItem('slt.name') ?? '';
} catch {}

$('join').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('joinError').textContent = '';
  try {
    const mode = document.querySelector('input[name=mode]:checked').value;
    await start({ name: $('name').value.trim(), mode, share: $('share').checked });
    $('join').hidden = true;
  } catch (err) {
    console.error(err);
    $('joinError').textContent = err.message;
  }
});

async function start({ name, mode, share }) {
  try {
    localStorage.setItem('slt.name', name);
  } catch {}
  // Permission prompts must happen inside the Join tap, before any await on
  // network or file loading, or iOS rejects them.
  const pose = mode === 'motion' ? new MotionPose() : new SimPose($('world'));
  const camera = new Camera($('camera'));
  await Promise.all([pose.start(), share || mode === 'motion' ? camera.start() : null]);

  const map = await (await fetch('maps/default.json')).json();
  pose.setPosition(...(map.start ?? [0, 0]));
  await document.fonts.ready; // 3D labels are drawn with the UI fonts
  const world = new World($('world'));
  await world.loadMap(map);

  const minimap = new Minimap($('minimap'), map);
  const net = new Net(name);
  const peers = new Map();
  for (const id of ['hud', 'mapPanel', 'controls']) $(id).hidden = false;
  $('fpsBox').hidden = !share;

  // --- networking -----------------------------------------------------------
  net.addEventListener('status', ({ detail }) => {
    $('conn').classList.toggle('on', detail.connected);
    $('connLabel').textContent = detail.connected ? 'LIVE' : 'OFFLINE';
    if (!detail.connected) {
      for (const id of peers.keys()) world.removePeer(id);
      peers.clear();
    }
  });
  // Once LiDAR phones have vectorised real walls, they replace the blockout.
  let hasLiveMap = false;
  const applyLiveMap = ({ walls }) => {
    if (!walls?.length) return;
    const xs = walls.flatMap((w) => [w[0], w[2]]);
    const zs = walls.flatMap((w) => [w[1], w[3]]);
    const bounds = [Math.min(...xs) - 1, Math.min(...zs) - 1, Math.max(...xs) + 1, Math.max(...zs) + 1];
    world.setWalls(walls);
    world.setFloor(bounds);
    // The blockout's start point means nothing in a scanned map's frame.
    if (!hasLiveMap && pose.kind === 'sim') pose.setPosition((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2);
    hasLiveMap = true;
    minimap.setWalls(walls);
    minimap.setBounds(bounds);
  };
  net.addEventListener('map', ({ detail }) => applyLiveMap(detail));

  net.addEventListener('welcome', ({ detail }) => {
    applyLiveMap(detail.map ?? {});
    for (const p of detail.peers) {
      peers.set(p.id, { name: p.name, pose: p.pose });
      const card = world.peer(p.id, p.name);
      if (p.pose) card.setPose(p.pose);
    }
  });
  net.addEventListener('join', ({ detail }) => {
    peers.set(detail.id, { name: detail.name, pose: null });
    world.peer(detail.id, detail.name);
  });
  net.addEventListener('leave', ({ detail }) => {
    peers.delete(detail.id);
    world.removePeer(detail.id);
  });
  net.addEventListener('pose', ({ detail }) => {
    const peer = peers.get(detail.id);
    if (!peer) return;
    peer.pose = detail;
    world.peer(detail.id).setPose(detail);
  });
  net.addEventListener('frame', ({ detail: { meta, jpeg } }) => {
    const peer = peers.get(meta.id);
    if (!peer) return;
    peer.pose = meta;
    world.peer(meta.id).setFrame(meta, jpeg);
  });
  net.connect();

  // --- controls -------------------------------------------------------------
  const setXray = (on) => {
    document.body.classList.toggle('xray', on);
    $('xray').setAttribute('aria-pressed', String(on));
    world.setXray(on);
  };
  $('xray').disabled = !camera.ready;
  $('xray').addEventListener('click', () => setXray(!world.xray));
  setXray(camera.ready && mode === 'motion');

  $('opacity').addEventListener('input', (e) => {
    world.setWallOpacity(e.target.value / 100);
    $('opacityOut').value = e.target.value;
  });
  world.setWallOpacity($('opacity').value / 100);

  // Two taps on the map: where I stand, then what I'm facing.
  let placing = null;
  const hint = (text) => ($('hint').textContent = text);
  $('place').addEventListener('click', () => {
    placing = 'spot';
    hint("Tap where you're standing");
  });
  minimap.onPick = (pt) => {
    if (placing === 'spot') {
      pose.setPosition(pt[0], pt[1]);
      placing = 'facing';
      hint("Now tap what you're facing");
    } else if (placing === 'facing') {
      const here = [pose.position[0], pose.position[2]];
      pose.setHeading(yawTowards(here, pt));
      placing = null;
      hint('');
    }
  };
  if (mode === 'motion') {
    placing = 'spot';
    hint("Tap where you're standing");
  }

  // --- loop -----------------------------------------------------------------
  let last = performance.now();
  let lastPoseSent = 0;
  let lastFrameSent = 0;
  let sendingFrame = false;
  let framesSent = 0;
  let fpsWindowStart = last;
  let fpsOut = 0;

  const loop = (now) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const self = { ...pose.read(dt), fov: camera.ready ? camera.fov : 60, aspect: camera.aspect };
    // Portrait screens need a taller vertical FOV to keep a usable horizontal one.
    world.setViewPose(self, world.xray ? camera.fov : innerHeight > innerWidth ? 80 : 60);

    if (now - lastPoseSent > 1000 / POSE_HZ) {
      lastPoseSent = now;
      net.sendPose(self);
    }
    if (share && camera.ready && !sendingFrame && now - lastFrameSent > 1000 / FRAME_FPS) {
      lastFrameSent = now;
      sendingFrame = true;
      camera
        .grabJpeg()
        .then((jpeg) => jpeg && net.sendFrame(self, jpeg) && framesSent++)
        .finally(() => (sendingFrame = false));
    }
    if (now - fpsWindowStart > 1000) {
      fpsOut = framesSent;
      framesSent = 0;
      fpsWindowStart = now;
    }

    const list = [...peers.entries()].map(([id, p]) => {
      const card = world.peers.get(id);
      return { ...p, live: card && now - card.lastFrameAt < 3000 };
    });
    const live = list.filter((p) => p.live).length;
    const pad = (n) => String(n).padStart(2, '0');
    $('peerCount').textContent = pad(list.length);
    $('liveCount').textContent = pad(live);
    $('fpsOut').textContent = pad(share ? fpsOut : 0);
    $('coords').textContent = `${self.p[0].toFixed(1)}, ${self.p[2].toFixed(1)}`;
    minimap.draw(self, list, placing);
    world.render(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

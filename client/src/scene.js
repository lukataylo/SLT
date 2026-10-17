import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';

const CARD_DISTANCE = 2.5; // metres in front of a feed phone where its video is shown
const STALE_MS = 3000;

// The shared 3D world: the captured space (Gaussian splat, or blockout walls
// until a scan exists) plus one live video card per other phone.
export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 200);
    this.scene.add(new SparkRenderer({ renderer: this.renderer }));
    this.walls = [];
    this.splat = null;
    this.peers = new Map();
    this.xray = false;
    this.wallOpacity = 0.6;
    this.renderer.setClearColor(0x000000, 1);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const { innerWidth: w, innerHeight: h } = window;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async loadMap(map) {
    this.wallHeight = map.wallHeight ?? 2.6;
    this.wallMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
    this.edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true });
    this.setFloor(map.bounds);
    this.setWalls(map.walls ?? []);

    if (map.splat?.url) {
      const splat = new SplatMesh({ url: map.splat.url });
      const { position = [0, 0, 0], quaternion = [0, 0, 0, 1], scale = 1 } = map.splat;
      splat.position.fromArray(position);
      splat.quaternion.fromArray(quaternion);
      splat.scale.setScalar(scale);
      this.scene.add(splat);
      this.splat = splat;
      await splat.initialized;
    }
    this.setWallOpacity(this.wallOpacity);
  }

  setFloor(bounds) {
    if (this.floor) {
      this.scene.remove(this.floor);
      this.floor.geometry.dispose();
    }
    this.floor = dotFloor(bounds);
    this.scene.add(this.floor);
  }

  // Walls are [x1, z1, x2, z2] floor-plan segments, from the map file or
  // vectorised live from LiDAR phones.
  setWalls(segments) {
    for (const wall of this.walls) {
      this.scene.remove(wall);
      wall.geometry.dispose();
      wall.children[0].geometry.dispose();
    }
    this.walls = segments.map(([x1, z1, x2, z2]) => {
      const box = new THREE.BoxGeometry(Math.hypot(x2 - x1, z2 - z1), this.wallHeight, 0.1);
      const wall = new THREE.Mesh(box, this.wallMaterial);
      wall.add(new THREE.LineSegments(new THREE.EdgesGeometry(box), this.edgeMaterial));
      wall.position.set((x1 + x2) / 2, this.wallHeight / 2, (z1 + z2) / 2);
      wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      this.scene.add(wall);
      return wall;
    });
  }

  setWallOpacity(v) {
    this.wallOpacity = v;
    if (this.splat) this.splat.opacity = v;
    // Walls are mostly a faint fill with crisp edges, so the dot floor and
    // video cards behind them stay readable.
    if (this.wallMaterial) this.wallMaterial.opacity = (this.splat ? 0.05 : 0.14) * v;
    if (this.edgeMaterial) this.edgeMaterial.opacity = 0.15 + 0.7 * v;
  }

  setXray(on) {
    this.xray = on;
    this.renderer.setClearColor(0x000000, on ? 0 : 1);
  }

  setViewPose(pose, vfov) {
    this.camera.position.fromArray(pose.p);
    this.camera.quaternion.fromArray(pose.q);
    if (vfov && Math.abs(this.camera.fov - vfov) > 0.5) {
      this.camera.fov = vfov;
      this.camera.updateProjectionMatrix();
    }
  }

  peer(id, name) {
    let entry = this.peers.get(id);
    if (!entry) {
      entry = new PeerCard(id, name ?? id);
      this.peers.set(id, entry);
      this.scene.add(entry.group);
    } else if (name) {
      entry.setName(name);
    }
    return entry;
  }

  removePeer(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    this.scene.remove(entry.group);
    entry.dispose();
    this.peers.delete(id);
  }

  render(now) {
    for (const entry of this.peers.values()) entry.tick(now);
    this.renderer.render(this.scene, this.camera);
  }
}

// Floor as a field of dots, like the dot-matrix texture in the UI.
function dotFloor(bounds = [-10, -10, 10, 10]) {
  const [minX, minZ, maxX, maxZ] = bounds;
  const step = 0.5;
  const pts = [];
  for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) {
    for (let z = Math.ceil(minZ / step) * step; z <= maxZ; z += step) pts.push(x, 0, z);
  }
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.35 }));
}

function labelSprite(text) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000000e0';
  ctx.strokeStyle = '#ffffff55';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(2, 10, 252, 44, 22);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#d71921';
  ctx.beginPath();
  ctx.arc(30, 32, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f5f5f5';
  ctx.font = '700 22px "Space Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), 140, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(0.8, 0.2, 1);
  sprite.renderOrder = 12;
  return sprite;
}

// Another person's phone: a marker where they stand, their view frustum, and
// their latest frame on a card where their camera is looking. Drawn without
// depth testing so it shows through walls and splats - that's the x-ray.
class PeerCard {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.group = new THREE.Group();
    this.lastFrameAt = 0;
    this.pose = null;
    this.fov = 50;
    this.aspect = 16 / 9;

    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    this.marker.renderOrder = 11;

    this.texture = new THREE.Texture();
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false; // ImageBitmaps are decoded pre-flipped
    this.cardMat = new THREE.MeshBasicMaterial({
      map: this.texture,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: false,
      opacity: 0,
    });
    this.card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.cardMat);
    this.card.renderOrder = 10;

    this.frustum = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(8 * 3), 3)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false }),
    );
    this.frustum.renderOrder = 11;

    this.label = labelSprite(name);
    this.group.add(this.marker, this.card, this.frustum, this.label);
    this.group.visible = false;
    this.bitmap = null;
    this.decoding = false;
  }

  setName(name) {
    if (name === this.name) return;
    this.name = name;
    this.group.remove(this.label);
    this.label.material.map.dispose();
    this.label = labelSprite(name);
    this.group.add(this.label);
  }

  setPose(pose) {
    this.pose = pose;
    if (pose.fov) this.fov = pose.fov;
    if (pose.aspect) this.aspect = pose.aspect;
    this.layout();
  }

  async setFrame(meta, jpeg) {
    this.setPose(meta);
    this.lastFrameAt = performance.now();
    // Decoding can lag behind the network; drop frames rather than queue them.
    if (this.decoding) return;
    this.decoding = true;
    try {
      const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }), { imageOrientation: 'flipY' });
      this.bitmap?.close();
      this.bitmap = bitmap;
      this.texture.image = bitmap;
      this.texture.needsUpdate = true;
    } finally {
      this.decoding = false;
    }
  }

  layout() {
    const { p, q } = this.pose;
    const origin = new THREE.Vector3().fromArray(p);
    const rot = new THREE.Quaternion().fromArray(q);
    const h = 2 * CARD_DISTANCE * Math.tan(THREE.MathUtils.degToRad(this.fov) / 2);
    const w = h * this.aspect;
    this.marker.position.copy(origin);
    this.label.position.copy(origin).add(new THREE.Vector3(0, 0.3, 0));
    this.card.position.copy(origin).add(new THREE.Vector3(0, 0, -CARD_DISTANCE).applyQuaternion(rot));
    this.card.quaternion.copy(rot);
    this.card.scale.set(w, h, 1);

    const corners = [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ].map(([x, y]) => new THREE.Vector3(x, y, -CARD_DISTANCE).applyQuaternion(rot).add(origin));
    const pos = this.frustum.geometry.attributes.position;
    corners.forEach((c, i) => {
      pos.setXYZ(i * 2, origin.x, origin.y, origin.z);
      pos.setXYZ(i * 2 + 1, c.x, c.y, c.z);
    });
    pos.needsUpdate = true;
    this.frustum.geometry.computeBoundingSphere();
    this.group.visible = true;
  }

  tick(now) {
    const age = now - this.lastFrameAt;
    const live = this.lastFrameAt > 0 && age < STALE_MS;
    this.cardMat.opacity = live ? 0.95 : this.bitmap ? 0.25 : 0;
    this.marker.material.color.set(live ? 0xffffff : 0x555555);
  }

  dispose() {
    this.bitmap?.close();
    this.texture.dispose();
    this.cardMat.dispose();
    this.card.geometry.dispose();
    this.frustum.geometry.dispose();
    this.label.material.map.dispose();
  }
}

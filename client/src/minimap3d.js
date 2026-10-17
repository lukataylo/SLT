import * as THREE from 'three';
import { yawOf } from './align.js';

const WALL_HEIGHT = 2.6;
const RED = 0xd71921;
const q = new THREE.Quaternion();

// Line opacity by how many scan sessions confirmed a wall.
const seenOpacity = (seen = 1) => (seen >= 3 ? 1 : seen === 2 ? 0.75 : 0.45);

function sector(color, opacity) {
  // Flat view cone on the floor pointing down -Z (forward at yaw 0).
  const geo = new THREE.CircleGeometry(1.4, 12, Math.PI / 2 - 0.45, 0.9).rotateX(-Math.PI / 2);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
}

function phoneMarker(color) {
  const group = new THREE.Group();
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), new THREE.MeshBasicMaterial({ color }));
  dot.position.y = 0.22;
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }));
  stalk.position.y = 0.7;
  const head = dot.clone();
  head.position.y = 1.4;
  group.add(dot, stalk, head, sector(color, 0.3));
  return group;
}

// Fixed map origin: a red cross on the floor with a short vertical post.
function originMarker() {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: RED });
  const pts = [
    [-0.8, 0, 0], [0.8, 0, 0],
    [0, 0, -0.8], [0, 0, 0.8],
    [0, 0, 0], [0, 1, 0],
  ].map((p) => new THREE.Vector3(...p));
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat));
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.45, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: RED, side: THREE.DoubleSide }),
  );
  group.add(ring);
  return group;
}

// Three-quarter 3D preview of the floor plan: extruded walls (brighter the more
// scans confirmed them), the fixed origin, and every phone. Same interface as
// the old 2D minimap: taps are projected onto the floor for "set my spot".
export class Minimap {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 500);
    this.walls = new THREE.Group();
    this.scene.add(this.walls);
    this.origin = originMarker();
    this.origin.visible = false;
    this.scene.add(this.origin);
    this.self = phoneMarker(RED);
    this.scene.add(this.self);
    this.peers = new Map();
    this.fillMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, depthWrite: false });
    this.edgeMats = [1, 2, 3].map((s) => new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: seenOpacity(s) }));
    this.onPick = null;
    this.raycaster = new THREE.Raycaster();
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const hit = this.raycaster.ray.intersectPlane(this.floorPlane, new THREE.Vector3());
      if (hit) this.onPick?.([hit.x, hit.z]);
    });

    this.setBounds(map.bounds);
    this.setWalls(map.walls ?? []);
  }

  setBounds([minX, minZ, maxX, maxZ]) {
    this.bounds = [minX, minZ, maxX, maxZ];
    if (this.floor) {
      this.scene.remove(this.floor);
      this.floor.geometry.dispose();
    }
    const pts = [];
    for (let x = Math.ceil(minX); x <= maxX; x += 1) for (let z = Math.ceil(minZ); z <= maxZ; z += 1) pts.push(x, 0, z);
    this.floor = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
      new THREE.PointsMaterial({ color: 0xffffff, size: 1.5, sizeAttenuation: false, transparent: true, opacity: 0.3 }),
    );
    this.scene.add(this.floor);
    this.frame();
  }

  // Look down at ~40° from the south, far enough back to fit the whole plan.
  frame() {
    const [minX, minZ, maxX, maxZ] = this.bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ, 4);
    const dist = span / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    this.camera.position.set(cx, dist * 0.68, cz + dist * 0.78);
    this.camera.lookAt(cx, 0, cz + span * 0.04);
  }

  setWalls(walls, seen = []) {
    for (const child of [...this.walls.children]) {
      this.walls.remove(child);
      child.geometry.dispose();
      child.children[0]?.geometry.dispose();
    }
    walls.forEach(([x1, z1, x2, z2], i) => {
      const box = new THREE.BoxGeometry(Math.hypot(x2 - x1, z2 - z1), WALL_HEIGHT, 0.08);
      const wall = new THREE.Mesh(box, this.fillMat);
      wall.add(new THREE.LineSegments(new THREE.EdgesGeometry(box), this.edgeMats[Math.min(seen[i] ?? 1, 3) - 1]));
      wall.position.set((x1 + x2) / 2, WALL_HEIGHT / 2, (z1 + z2) / 2);
      wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      this.walls.add(wall);
    });
  }

  setOrigin(visible) {
    this.origin.visible = visible;
  }

  placeMarker(marker, pose) {
    marker.position.set(pose.p[0], 0, pose.p[2]);
    marker.rotation.y = yawOf(q.fromArray(pose.q));
  }

  draw(self, peers, pending) {
    const w = this.canvas.clientWidth;
    const h = Math.round(w * 0.8);
    if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.canvas.style.height = `${h}px`;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.frame();
    }
    this.canvas.classList.toggle('pending', !!pending);

    if (self) this.placeMarker(this.self, self);
    const live = new Set();
    for (const peer of peers) {
      if (!peer.pose) continue;
      live.add(peer.id);
      let m = this.peers.get(peer.id);
      if (!m) {
        m = phoneMarker(0xffffff);
        this.peers.set(peer.id, m);
        this.scene.add(m);
      }
      this.placeMarker(m, peer.pose);
      m.children[0].material.color.set(peer.live ? 0xffffff : 0x555555);
    }
    for (const [id, m] of this.peers) {
      if (!live.has(id)) {
        this.scene.remove(m);
        this.peers.delete(id);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }
}

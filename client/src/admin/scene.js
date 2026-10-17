import { SparkRenderer } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { DEPTH_STOPS, depthColor, SplatCloud } from '../splatcloud.js';
import { coveredByScannedDoor, doorSwing, swingArc } from './doors.js';

export { depthColor };

const WALL_HEIGHT = 2.6;
const BOX_CYAN = 0x2fd6e6;
const TILE_GREEN = 0xc8ff3a;
const FRAME_GREEN = 0x7dd23a;
const ORIGIN_RED = 0xd71921;
const GROUND_Y = -0.55; // the scan sits on a "curtain" above the ground frame

const gradientGlsl = DEPTH_STOPS.map(([, c]) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`);

// Translucent wall panels coloured by world height.
function wallMaterial(brightness) {
  return new THREE.ShaderMaterial({
    uniforms: { uBright: { value: brightness }, uAlpha: { value: 1 } },
    vertexShader: /* glsl */ `
      varying float vY;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vY = world.y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uBright;
      uniform float uAlpha;
      varying float vY;
      vec3 depth(float y) {
        if (y < 0.35) return mix(${gradientGlsl[0]}, ${gradientGlsl[1]}, clamp(y / 0.35, 0.0, 1.0));
        if (y < 1.1) return mix(${gradientGlsl[1]}, ${gradientGlsl[2]}, (y - 0.35) / 0.75);
        if (y < 1.9) return mix(${gradientGlsl[2]}, ${gradientGlsl[3]}, (y - 1.1) / 0.8);
        return mix(${gradientGlsl[3]}, ${gradientGlsl[4]}, clamp((y - 1.9) / 0.9, 0.0, 1.0));
      }
      void main() {
        float fade = 0.55 + 0.45 * (1.0 - clamp(vY / ${WALL_HEIGHT.toFixed(1)}, 0.0, 1.0));
        gl_FragColor = vec4(depth(vY) * uBright, 0.11 * fade * uBright * uAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function lineSegments(points, colors, opacity = 1) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  if (colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.LineBasicMaterial({
    vertexColors: !!colors,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.LineSegments(geo, mat);
}

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); });
    if (o.isCSS2DObject) o.element.remove();
  });
}

function label(text, cls) {
  const el = document.createElement('div');
  el.className = `label ${cls}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

// Grid texture for the floating device tiles.
function tileTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(200,255,58,0.18)';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(220,255,120,0.9)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= 8; i++) {
    const v = 4 + i * 15;
    ctx.beginPath(); ctx.moveTo(v, 4); ctx.lineTo(v, 124); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(4, v); ctx.lineTo(124, v); ctx.stroke();
  }
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(230,255,140,1)';
  ctx.strokeRect(3, 3, 122, 122);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A flat-on-floor cross with a short post: room origins and the map origin.
function cross(color, size, post) {
  const s = size;
  const pts = [-s, 0.02, 0, s, 0.02, 0, 0, 0.02, -s, 0, 0.02, s, 0, 0, 0, 0, post, 0];
  const obj = lineSegments(pts, null, 1);
  obj.material.color.set(color);
  return obj;
}

const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const yawOf = (q) => {
  _fwd.set(0, 0, -1).applyQuaternion(_q.fromArray(q));
  return Math.atan2(-_fwd.x, -_fwd.z);
};

// Wall split into panels around the openings that lie on it, in (t, y) space
// along the wall: doors leave a full-height gap, windows leave wall above and below.
function wallPanels(seg, openings) {
  const [x1, z1, x2, z2] = seg;
  const len = Math.hypot(x2 - x1, z2 - z1);
  const ux = (x2 - x1) / len;
  const uz = (z2 - z1) / len;
  const holes = [];
  for (const o of openings) {
    const [a1, b1, a2, b2] = o.s;
    const ol = Math.hypot(a2 - a1, b2 - b1);
    if (!ol) continue;
    const cosA = Math.abs(((a2 - a1) * ux + (b2 - b1) * uz) / ol);
    const mx = (a1 + a2) / 2 - x1;
    const mz = (b1 + b2) / 2 - z1;
    const across = Math.abs(mx * -uz + mz * ux);
    if (cosA < 0.95 || across > 0.3) continue;
    const t0 = Math.max(0, Math.min((a1 - x1) * ux + (b1 - z1) * uz, (a2 - x1) * ux + (b2 - z1) * uz));
    const t1 = Math.min(len, Math.max((a1 - x1) * ux + (b1 - z1) * uz, (a2 - x1) * ux + (b2 - z1) * uz));
    if (t1 - t0 > 0.05) holes.push({ t0, t1, y0: Math.max(0, o.y0 ?? 0), y1: Math.min(WALL_HEIGHT, o.y1 ?? WALL_HEIGHT) });
  }
  const cuts = [0, len, ...holes.flatMap((h) => [h.t0, h.t1])].sort((a, b) => a - b);
  const panels = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    if (b - a < 1e-3) continue;
    const mid = (a + b) / 2;
    const hole = holes.find((h) => mid > h.t0 && mid < h.t1);
    if (!hole) panels.push([a, b, 0, WALL_HEIGHT]);
    else {
      if (hole.y0 > 0.02) panels.push([a, b, 0, hole.y0]);
      if (hole.y1 < WALL_HEIGHT - 0.02) panels.push([a, b, hole.y1, WALL_HEIGHT]);
    }
  }
  return { panels, ux, uz };
}

export class AdminScene {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
    this.camera.position.set(16, 12, 16);
    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.45;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 120;
    let idle = null;
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false;
      clearTimeout(idle);
    });
    this.controls.addEventListener('end', () => {
      clearTimeout(idle);
      idle = setTimeout(() => (this.controls.autoRotate = true), 6000);
    });

    // The scan is Gaussian splats in a scene of their own, so they can be kept
    // out of the bloom: only the wireframe, frames and beacons glow, and the
    // splats keep their true camera colours. Both scenes share one depth
    // buffer in the final pass, so walls and splats occlude each other.
    this.splatScene = new THREE.Scene();
    this.splatScene.add(new SparkRenderer({ renderer: this.renderer }));
    this.cloud = new SplatCloud({ mode: 'colour' });
    this.splatScene.add(this.cloud.group);
    this.mode = 'colour';

    this.bloomComposer = new EffectComposer(this.renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomSplats = new RenderPass(this.splatScene, this.camera);
    this.bloomSplats.clear = false;
    this.bloomSplats.enabled = false; // depth mode only: glowing like the reference
    this.bloomComposer.addPass(this.bloomSplats);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.4, 0.42);
    this.bloomComposer.addPass(this.bloom);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const splatPass = new RenderPass(this.splatScene, this.camera);
    splatPass.clear = false;
    this.composer.addPass(splatPass);
    const mix = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: { baseTexture: { value: null }, bloomTexture: { value: this.bloomComposer.renderTarget2.texture } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader:
          'uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv;' +
          'void main() { gl_FragColor = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv); }',
      }),
      'baseTexture',
    );
    mix.needsSwap = true;
    this.composer.addPass(mix);
    this.composer.addPass(new OutputPass());

    this.mapGroup = new THREE.Group();
    this.deviceGroup = new THREE.Group();
    this.scene.add(this.mapGroup, this.deviceGroup);
    this.wallMats = [];
    this.wallEdges = [];
    this.devices = new Map();
    this.tileTex = tileTexture();

    this.box = this.buildBox();
    this.scene.add(this.box.group);
    this.ground = this.buildGround();
    this.scene.add(this.ground);
    // The scan floats on its own: no bounding box or ground frame around it.
    // (The box is still sized every frame; it sets the device tiles' height.)
    this.box.group.visible = false;
    this.ground.visible = false;
    this.bounds = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, WALL_HEIGHT, 1));
    this.boxNow = { min: this.bounds.min.clone(), max: this.bounds.max.clone() };
    this.framed = false;
    this.focus = null;

    this.highlighted = null;
    this.panel = false;
    this.sizer = new ResizeObserver(() => this.resize());
    this.sizer.observe(container);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  // Moves the one renderer (and its labels and controls) into another
  // container: the full-screen stage, or the operator's floor-plan panel.
  attach(container, { panel = false } = {}) {
    if (container === this.container) return;
    this.sizer.unobserve(this.container);
    this.container = container;
    this.panel = panel;
    container.append(this.renderer.domElement, this.labels.domElement);
    this.sizer.observe(container);
    this.resize();
    this.frameAll();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return; // hidden: keep the last size
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomComposer.setSize(w, h); // sizes the bloom pass in device pixels too
    this.camera.aspect = w / h;
    // Centre the scene in the space the panels leave free: above the bottom
    // sheet on phones, left of the side column on wider screens.
    this.narrow = w < 760;
    // In the operator panel nothing covers the view: centre it plainly.
    if (this.panel) this.camera.clearViewOffset();
    else if (this.narrow) this.camera.setViewOffset(w, h, 0, h * 0.17, w, h);
    else this.camera.setViewOffset(w, h, 160, 0, w, h);
    this.camera.updateProjectionMatrix();
    if (this.framed) this.frameAll();
  }

  // --- Bounding box: cyan wireframe, back-wall grids, dotted top edges ---
  buildBox() {
    const group = new THREE.Group();
    const e = [
      0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0,
      0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0,
      0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1,
    ];
    const edges = lineSegments(e, null, 0.7);
    edges.material.color.set(BOX_CYAN);
    group.add(edges);

    // One grid + dot row per vertical face; only faces behind the content
    // (facing away from the camera) are shown, like the reference image.
    const N = 14;
    const faces = [
      { n: new THREE.Vector3(0, 0, -1), at: (u, v) => [u, v, 0] },
      { n: new THREE.Vector3(0, 0, 1), at: (u, v) => [u, v, 1] },
      { n: new THREE.Vector3(-1, 0, 0), at: (u, v) => [0, v, u] },
      { n: new THREE.Vector3(1, 0, 0), at: (u, v) => [1, v, u] },
    ].map((f) => {
      const pts = [];
      for (let i = 1; i < N; i++) {
        const k = i / N;
        pts.push(...f.at(k, 0), ...f.at(k, 1), ...f.at(0, k), ...f.at(1, k));
      }
      const grid = lineSegments(pts, null, 0.13);
      grid.material.color.set(BOX_CYAN);
      const dots = [];
      for (let i = 0; i <= 40; i++) dots.push(...f.at(i / 40, 1.04));
      for (let i = 0; i <= 14; i++) dots.push(...f.at(-0.02, 1.04 - i / 12));
      const dotObj = new THREE.Points(
        new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(dots, 3)),
        new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.9 }),
      );
      const holder = new THREE.Group();
      holder.add(grid, dotObj);
      group.add(holder);
      return { ...f, holder };
    });
    return { group, faces };
  }

  // Green double frame on the ground under the scan.
  buildGround() {
    const g = new THREE.Group();
    const rect = (pad, y, opacity) => {
      const o = lineSegments([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0], null, opacity);
      o.material.color.set(FRAME_GREEN);
      o.userData = { pad, y };
      return o;
    };
    g.add(rect(0.4, GROUND_Y, 1), rect(0.9, GROUND_Y - 0.25, 0.45));
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0.5, 0, 0.5),
      new THREE.MeshBasicMaterial({ color: 0x0e2a12, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    fill.userData = { pad: 0.4, y: GROUND_Y - 0.01 };
    g.add(fill);
    return g;
  }

  // --- Map: rooms, walls, openings, floors, origins ---
  setMap(map) {
    disposeTree(this.mapGroup);
    this.mapGroup.clear();
    this.wallMats = [];
    this.wallEdges = [];
    const box = new THREE.Box3();
    const grow = (x, y, z) => box.expandByPoint(new THREE.Vector3(x, y, z));
    const rooms = map.rooms?.length
      ? map.rooms
      : [{ id: '_', name: '', walls: map.walls ?? [], seen: map.seen ?? [], openings: [], floor: [] }];

    const tmpC = new THREE.Color();
    for (const room of rooms) {
      const openings = room.openings ?? [];
      // Floor slab with glowing outline and a hairline "curtain" down to the ground frame.
      if (room.floor?.length >= 3) {
        const shape = new THREE.Shape(room.floor.map(([x, z]) => new THREE.Vector2(x, -z)));
        const slab = new THREE.Mesh(
          new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: 0x0f8a45, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
        );
        slab.position.y = 0.005;
        this.mapGroup.add(slab);
        const outline = [];
        room.floor.forEach(([x, z], i) => {
          const [nx, nz] = room.floor[(i + 1) % room.floor.length];
          outline.push(x, 0.02, z, nx, 0.02, nz);
          grow(x, 0, z);
        });
        const ol = lineSegments(outline, null, 0.75);
        ol.material.color.set(0x35e07a);
        this.mapGroup.add(ol);
      }

      room.walls.forEach((seg, i) => {
        const seen = room.seen?.[i] ?? 1;
        const bright = seen >= 3 ? 1 : seen === 2 ? 0.8 : 0.6;
        const [x1, z1] = seg;
        const { panels, ux, uz } = wallPanels(seg, openings);
        const mat = wallMaterial(bright);
        this.wallMats.push(mat);
        const edge = [];
        const edgeCol = [];
        const push = (t, y) => {
          edge.push(x1 + ux * t, y, z1 + uz * t);
          depthColor(y, tmpC).multiplyScalar(0.6 + 0.6 * bright);
          edgeCol.push(tmpC.r, tmpC.g, tmpC.b);
        };
        for (const [a, b, y0, y1] of panels) {
          const geo = new THREE.BufferGeometry();
          const p = (t, y) => [x1 + ux * t, y, z1 + uz * t];
          geo.setAttribute('position', new THREE.Float32BufferAttribute([...p(a, y0), ...p(b, y0), ...p(b, y1), ...p(a, y0), ...p(b, y1), ...p(a, y1)], 3));
          this.mapGroup.add(new THREE.Mesh(geo, mat));
          push(a, y0); push(b, y0); push(a, y1); push(b, y1);
          push(a, y0); push(a, y1); push(b, y0); push(b, y1);
        }
        const edges = lineSegments(edge, edgeCol, 1);
        this.wallEdges.push(edges);
        this.mapGroup.add(edges);
        grow(seg[0], WALL_HEIGHT, seg[1]);
        grow(seg[2], 0, seg[3]);
      });

      // Openings: doors yellow-green, windows cyan.
      for (const o of openings) {
        const [a1, b1, a2, b2] = o.s;
        const y0 = o.y0 ?? 0;
        const y1 = o.y1 ?? 2.1;
        const pts = [a1, y0, b1, a2, y0, b2, a2, y0, b2, a2, y1, b2, a2, y1, b2, a1, y1, b1, a1, y1, b1, a1, y0, b1];
        const obj = lineSegments(pts, null, 1);
        obj.material.color.set(o.kind === 'door' ? TILE_GREEN : 0x5ef0ff);
        this.mapGroup.add(obj);
      }

      if (room.origin) {
        const c = cross(0x9dfcd0, 0.3, 0.35);
        c.position.set(room.origin[0], 0, room.origin[1]);
        this.mapGroup.add(c);
      }
      // Name at the room's centre so it never collides with origin markers.
      const anchor = room.floor?.length
        ? room.floor.reduce((a, [x, z]) => [a[0] + x / room.floor.length, a[1] + z / room.floor.length], [0, 0])
        : room.origin;
      if (room.name && anchor) {
        const l = label(room.name, 'room');
        l.position.set(anchor[0], 0.15, anchor[1]);
        this.mapGroup.add(l);
      }
    }

    // Doorways: a red frame for a closed door, a faint swing arc for an open one.
    for (const d of map.doorways ?? []) {
      if (!Array.isArray(d?.s) || d.s.length !== 4) continue;
      if (d.state === 'closed') {
        if (coveredByScannedDoor(d, rooms)) continue;
        const [a1, b1, a2, b2] = d.s;
        const top = 2.05;
        const obj = lineSegments([a1, 0, b1, a1, top, b1, a1, top, b1, a2, top, b2, a2, top, b2, a2, 0, b2], null, 0.95);
        obj.material.color.set(ORIGIN_RED);
        this.mapGroup.add(obj);
        continue;
      }
      const sw = doorSwing(d, rooms);
      const arc = swingArc(sw);
      const pts = [sw.hinge[0], 0.03, sw.hinge[1], sw.leaf[0], 0.03, sw.leaf[1]];
      for (let i = 1; i < arc.length; i++) pts.push(arc[i - 1][0], 0.03, arc[i - 1][1], arc[i][0], 0.03, arc[i][1]);
      const obj = lineSegments(pts, null, 0.55);
      obj.material.color.set(ORIGIN_RED);
      this.mapGroup.add(obj);
    }

    if (map.plan?.placement) this.addPlan(map.plan, grow);

    if (map.origin) {
      const o = cross(ORIGIN_RED, 0.7, 1.2);
      const l = label('ORIGIN', 'origin');
      l.position.set(0, 1.5, 0);
      o.add(l);
      this.mapGroup.add(o);
      grow(0, 0, 0);
    }
    this.mapBox = box.isEmpty() ? null : box;
    this.applyMode();
    this.refit();
  }

  // TRUE COLOUR: the splats carry the room, so walls fade to faint edges.
  // DEPTH: the reference look, height-graded panels and glowing splats.
  setMode(mode) {
    this.mode = mode;
    this.cloud.setMode(mode);
    this.bloomSplats.enabled = mode === 'depth';
    this.applyMode();
  }

  setCutaway(on) {
    this.cutaway = on;
    this.cloud.setCutaway(on ? 1.4 : null);
  }

  applyMode() {
    const colour = this.mode === 'colour' && this.cloud.count > 0;
    for (const m of this.wallMats) m.uniforms.uAlpha.value = colour ? 0.15 : 1;
    for (const e of this.wallEdges) e.material.opacity = colour ? 0.3 : 1;
  }

  // Architectural plan laid on the floor. Plan frame: x right, z down the
  // image, metres from its top-left; placed into the map like shared/planes.js
  // transformPoint2 (rotate by yaw about +Y, then translate).
  addPlan(plan, grow) {
    const { yaw, t } = plan.placement;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const toMap = ([x, z]) => [c * x + s * z + t[0], -s * x + c * z + t[2]];
    const w = plan.widthM;
    const h = plan.heightM;
    if (plan.imageUrl && w > 0 && h > 0) {
      const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(toMap);
      const geo = new THREE.BufferGeometry();
      const P = (i) => [corners[i][0], 0.008, corners[i][1]];
      geo.setAttribute('position', new THREE.Float32BufferAttribute([...P(0), ...P(1), ...P(2), ...P(0), ...P(2), ...P(3)], 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0], 2));
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
      new THREE.TextureLoader().load(plan.imageUrl, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        mat.map = tex;
        mat.needsUpdate = true;
      });
      this.mapGroup.add(new THREE.Mesh(geo, mat));
      corners.forEach(([x, z]) => grow(x, 0, z));
    }
    const outline = [];
    for (const room of plan.rooms ?? []) {
      const poly = room.polygon.map(toMap);
      poly.forEach(([x, z], i) => {
        const [nx, nz] = poly[(i + 1) % poly.length];
        outline.push(x, 0.015, z, nx, 0.015, nz);
      });
    }
    if (outline.length) {
      const ol = lineSegments(outline, null, 0.35);
      ol.material.color.set(0x2a9fb0);
      this.mapGroup.add(ol);
    }
  }

  // --- LiDAR splat cloud ---
  loadCloud(buffer) {
    this.cloud.load(buffer);
    this.cloudChanged();
  }

  addCloud(roomId, points, colors, normals) {
    this.cloud.append(roomId, points, colors, normals);
    this.cloudChanged();
  }

  resetCloud(roomId) {
    this.cloud.reset(roomId);
    this.cloudChanged();
  }

  cloudChanged() {
    this.applyMode();
    this.refit();
  }

  get cloudPoints() {
    return this.cloud.count;
  }

  // --- Devices: floating grid tiles with a beam to their floor spot ---
  setDevices(devices) {
    const seen = new Set();
    for (const d of devices) {
      if (!d.pose) continue;
      seen.add(d.id);
      let m = this.devices.get(d.id);
      if (!m) {
        m = this.deviceMarker(d);
        this.devices.set(d.id, m);
        this.deviceGroup.add(m.group);
      }
      m.el.textContent = d.name.toUpperCase();
      m.el.classList.toggle('selected', d.id === this.highlighted);
      m.target.set(d.pose.p[0], 0, d.pose.p[2]);
      m.yaw = yawOf(d.pose.q);
      const active = (d.online ?? d.live) && (d.kind !== 'lidar' || d.aligned);
      m.dim = active ? 1 : 0.3;
      m.el.classList.toggle('dim', !active);
    }
    for (const [id, m] of this.devices) {
      if (seen.has(id)) continue;
      disposeTree(m.group);
      this.deviceGroup.remove(m.group);
      this.devices.delete(id);
    }
  }

  deviceMarker(d) {
    const group = new THREE.Group();
    const tile = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.tileTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    const beam = lineSegments([0, 0, 0, 0, 1, 0], null, 0.95);
    beam.material.color.set(TILE_GREEN);
    const spot = new THREE.Mesh(
      new THREE.CircleGeometry(0.28, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: TILE_GREEN, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    spot.position.y = 0.03;
    const cone = new THREE.Mesh(
      new THREE.CircleGeometry(1.3, 16, Math.PI / 2 - 0.4, 0.8).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: TILE_GREEN, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    cone.position.y = 0.04;
    // The device's latest camera frame, under the glowing grid frame.
    const photoTex = new THREE.Texture();
    photoTex.colorSpace = THREE.SRGBColorSpace;
    photoTex.flipY = false; // bitmaps arrive pre-flipped
    const photo = new THREE.Mesh(
      new THREE.PlaneGeometry(1.0, 1.0).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: photoTex, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }),
    );
    photo.visible = false;
    const lab = label(d.name.toUpperCase(), 'device');
    group.add(photo, tile, beam, spot, cone, lab);
    return { group, tile, photo, photoTex, beam, spot, cone, label: lab, el: lab.element, target: new THREE.Vector3(), yaw: 0, dim: 1, placed: false };
  }

  // Shows a device's camera frame (an ImageBitmap) on its beacon tile,
  // centre-cropped to the square tile.
  setDeviceFrame(id, bitmap) {
    const m = this.devices.get(id);
    if (!m) return bitmap.close?.();
    m.photoTex.image?.close?.();
    m.photoTex.image = bitmap;
    const aspect = bitmap.width / bitmap.height;
    m.photoTex.repeat.set(aspect > 1 ? 1 / aspect : 1, aspect > 1 ? 1 : aspect);
    m.photoTex.offset.set((1 - m.photoTex.repeat.x) / 2, (1 - m.photoTex.repeat.y) / 2);
    m.photoTex.needsUpdate = true;
    m.photo.visible = true;
  }

  // The device selected in the operator view: red beacon and label.
  highlight(id) {
    this.highlighted = id;
    for (const [mid, m] of this.devices) m.el.classList.toggle('selected', mid === id);
  }

  focusOn(id) {
    const m = this.devices.get(id);
    if (!m) return;
    this.focus = { target: m.target.clone(), until: performance.now() + 1200 };
    this.controls.autoRotate = false;
    setTimeout(() => (this.controls.autoRotate = true), 8000);
  }

  // Box target = everything we know about, plus margin.
  refit() {
    const b = new THREE.Box3();
    if (this.mapBox) b.union(this.mapBox);
    if (!this.cloud.box.isEmpty()) b.union(this.cloud.box);
    for (const m of this.devices.values()) b.expandByPoint(m.target);
    if (b.isEmpty()) return;
    b.min.y = 0;
    b.max.y = Math.max(b.max.y, WALL_HEIGHT);
    b.expandByVector(new THREE.Vector3(0.8, 0, 0.8));
    b.max.y += 1.4; // headroom for the floating device tiles
    this.bounds = b;
    if (!this.framed) {
      this.framed = true;
      this.boxNow = { min: b.min.clone(), max: b.max.clone() };
      this.frameAll();
    }
  }

  // Fit the whole box in view from a three-quarter angle, whatever the aspect.
  frameAll() {
    const b = this.bounds;
    const c = b.getCenter(new THREE.Vector3());
    const radius = b.getSize(new THREE.Vector3()).length() / 2;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * (this.narrow ? 0.78 : 0.92);
    const dir = new THREE.Vector3(0.62, 0.55, 0.7).normalize();
    this.controls.target.set(c.x, 0.8, c.z);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
  }

  render(now) {
    // Ease the bounding box towards its target so growth animates.
    const k = 0.06;
    this.boxNow.min.lerp(this.bounds.min, k);
    this.boxNow.max.lerp(this.bounds.max, k);
    const size = this.boxNow.max.clone().sub(this.boxNow.min);
    this.box.group.position.copy(this.boxNow.min);
    this.box.group.scale.set(size.x, size.y, size.z);
    const center = this.boxNow.min.clone().addScaledVector(size, 0.5);
    for (const f of this.box.faces) {
      const faceCenter = center.clone().addScaledVector(f.n, f.n.x ? size.x / 2 : size.z / 2);
      f.holder.visible = f.n.dot(this.camera.position.clone().sub(faceCenter)) < 0;
    }
    for (const r of this.ground.children) {
      const { pad, y } = r.userData;
      r.position.set(this.boxNow.min.x - pad, y, this.boxNow.min.z - pad);
      r.scale.set(size.x + pad * 2, 1, size.z + pad * 2);
    }

    const tileY = this.boxNow.max.y - 0.5;
    for (const m of this.devices.values()) {
      if (!m.placed) {
        m.group.position.copy(m.target);
        m.placed = true;
      }
      m.group.position.lerp(m.target, 0.2);
      m.tile.position.y = tileY + Math.sin(now / 900 + m.target.x) * 0.06;
      m.photo.position.y = m.tile.position.y - 0.01;
      m.photo.material.opacity = 0.95 * m.dim;
      m.beam.scale.y = m.tile.position.y;
      m.cone.rotation.y = m.yaw;
      const sel = m.el.classList.contains('selected');
      m.spot.material.color.set(sel ? ORIGIN_RED : TILE_GREEN);
      m.cone.material.color.set(sel ? ORIGIN_RED : TILE_GREEN);
      m.beam.material.color.set(sel ? ORIGIN_RED : TILE_GREEN);
      m.tile.scale.setScalar(sel ? 1.35 : 1);
      m.photo.scale.setScalar(sel ? 1.35 : 1);
      m.label.position.y = tileY + 0.45;
      for (const o of [m.tile, m.beam, m.spot, m.cone]) {
        o.material.opacity = (o === m.cone ? 0.22 : o === m.spot ? 0.85 : 0.95) * m.dim;
      }
    }

    if (this.focus) {
      this.controls.target.lerp(this.focus.target.clone().setY(0.8), 0.08);
      if (now > this.focus.until) this.focus = null;
    }
    this.controls.update();
    // Photos must not bloom either: hide them while rendering the glow.
    for (const m of this.devices.values()) m.photo.userData.shown = m.photo.visible;
    for (const m of this.devices.values()) m.photo.visible = false;
    this.bloomComposer.render();
    for (const m of this.devices.values()) m.photo.visible = m.photo.userData.shown;
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}

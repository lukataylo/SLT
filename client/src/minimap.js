import { yawOf } from './align.js';
import { Quaternion } from 'three';

const q = new Quaternion();

// Top-down floor plan. Doubles as the input for "where am I / which way am I
// facing" while phones only have rotation tracking.
export class Minimap {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.walls = map.walls ?? [];
    this.setBounds(map.bounds);
    this.onPick = null;
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      this.onPick?.(this.toWorld((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height));
    });
  }

  setBounds([minX, minZ, maxX, maxZ]) {
    this.bounds = { minX, minZ, w: maxX - minX, h: maxZ - minZ };
  }

  setWalls(walls) {
    this.walls = walls;
  }

  toWorld(u, v) {
    return [this.bounds.minX + u * this.bounds.w, this.bounds.minZ + v * this.bounds.h];
  }

  draw(self, peers, pending) {
    const { canvas, ctx, bounds } = this;
    const dpr = devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    const ch = (cw * bounds.h) / bounds.w;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.height = `${ch}px`;
    }
    const s = canvas.width / bounds.w;
    const px = (x) => (x - bounds.minX) * s;
    const pz = (z) => (z - bounds.minZ) * s;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Walls as dotted lines to match the dot-matrix look.
    ctx.strokeStyle = '#f5f5f5';
    ctx.lineWidth = 2.5 * dpr;
    ctx.lineCap = 'round';
    ctx.setLineDash([0.1, 5 * dpr]);
    for (const [x1, z1, x2, z2] of this.walls) {
      ctx.beginPath();
      ctx.moveTo(px(x1), pz(z1));
      ctx.lineTo(px(x2), pz(z2));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const drawPhone = (pose, color, fill) => {
      const x = px(pose.p[0]);
      const z = pz(pose.p[2]);
      const yaw = yawOf(q.fromArray(pose.q));
      const dx = -Math.sin(yaw);
      const dz = -Math.cos(yaw);
      const r = 26 * dpr;
      const spread = 0.45;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(x, z);
      ctx.arc(x, z, r, Math.atan2(dz, dx) - spread, Math.atan2(dz, dx) + spread);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, z, 4.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    };

    for (const peer of peers) {
      if (!peer.pose) continue;
      drawPhone(peer.pose, peer.live ? '#f5f5f5' : '#555555', peer.live ? 'rgba(245,245,245,0.18)' : 'rgba(85,85,85,0.18)');
    }
    if (self) drawPhone(self, '#d71921', 'rgba(215,25,33,0.3)');

    if (pending) {
      ctx.strokeStyle = '#d71921';
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
      ctx.setLineDash([]);
    }
  }
}

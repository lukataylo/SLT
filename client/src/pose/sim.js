import { Euler, Quaternion } from 'three';

const EYE_HEIGHT = 1.6;
const SPEED = 2; // m/s

// Desktop stand-in for a handheld phone: WASD to walk, drag to look.
export class SimPose {
  kind = 'sim';

  constructor(element, start = [0, 0]) {
    this.position = [start[0], EYE_HEIGHT, start[1]];
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.euler = new Euler(0, 0, 0, 'YXZ');
    this.quat = new Quaternion();
    addEventListener('keydown', (e) => !e.target.closest('input') && this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    let drag = null;
    element.addEventListener('pointerdown', (e) => (drag = { x: e.clientX, y: e.clientY }));
    addEventListener('pointerup', () => (drag = null));
    addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.yaw += (e.clientX - drag.x) * 0.004;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY };
    });
  }

  async start() {}

  setPosition(x, z) {
    this.position[0] = x;
    this.position[2] = z;
  }

  setHeading(yaw) {
    this.yaw = yaw;
  }

  read(dt) {
    const k = this.keys;
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    this.position[0] += (-s * fwd + c * side) * SPEED * dt;
    this.position[2] += (-c * fwd - s * side) * SPEED * dt;
    this.quat.setFromEuler(this.euler.set(this.pitch, this.yaw, 0));
    return { p: [...this.position], q: this.quat.toArray() };
  }
}

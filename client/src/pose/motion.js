import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import { headingCorrection } from '../align.js';

const EYE_HEIGHT = 1.4; // phones are held a bit below eye level

// Rotation from the phone's motion sensors; position is set by the person
// tapping where they stand on the minimap. Good enough to point a phone at a
// wall and see what's behind it. Full 6DoF (WebXR / ARKit) replaces this later.
export class MotionPose {
  kind = 'motion';

  constructor(start = [0, 0]) {
    this.position = [start[0], EYE_HEIGHT, start[1]];
    this.device = new Quaternion();
    this.correction = new Quaternion();
    this.out = new Quaternion();
    this.euler = new Euler();
    this.hasReading = false;
  }

  // Must be called from a user gesture: iOS gates sensors behind a prompt.
  async start() {
    const DOE = globalThis.DeviceOrientationEvent;
    if (!DOE) throw new Error('This browser has no motion sensors');
    if (typeof DOE.requestPermission === 'function' && (await DOE.requestPermission()) !== 'granted') {
      throw new Error('Motion sensor permission denied');
    }
    const zee = new Vector3(0, 0, 1);
    // Device frame (z out of screen) -> camera frame (looking out the back).
    const toCamera = new Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
    const screenTwist = new Quaternion();
    addEventListener('deviceorientation', (e) => {
      if (e.alpha == null) return;
      const d = MathUtils.DEG2RAD;
      this.euler.set(e.beta * d, e.alpha * d, -e.gamma * d, 'YXZ');
      this.device.setFromEuler(this.euler).multiply(toCamera);
      this.device.multiply(screenTwist.setFromAxisAngle(zee, -(screen.orientation?.angle ?? 0) * d));
      this.hasReading = true;
    });
  }

  setPosition(x, z) {
    this.position[0] = x;
    this.position[2] = z;
  }

  // Called when the person says "I'm facing that way" on the minimap.
  setHeading(yaw) {
    this.correction = headingCorrection(this.device, yaw);
  }

  read() {
    this.out.multiplyQuaternions(this.correction, this.device);
    return { p: [...this.position], q: this.out.toArray() };
  }
}

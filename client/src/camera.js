// Rear camera capture. One stream serves two jobs: the x-ray background on
// this phone and the JPEG frames shared with everyone else.

const CAPTURE_WIDTH = 480;
const DEFAULT_VFOV = 50; // typical phone main camera, landscape; tune per device

export class Camera {
  constructor(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.vfov = DEFAULT_VFOV;
    this.ready = false;
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    this.ready = true;
  }

  get aspect() {
    return this.video.videoWidth / this.video.videoHeight || 16 / 9;
  }

  // Portrait images have a wider vertical FOV than landscape ones.
  get fov() {
    return this.aspect < 1 ? this.vfov / this.aspect : this.vfov;
  }

  async grabJpeg(quality = 0.6) {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (!this.ready || !w) return null;
    this.canvas.width = CAPTURE_WIDTH;
    this.canvas.height = Math.round((CAPTURE_WIDTH * h) / w);
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    const blob = await new Promise((r) => this.canvas.toBlob(r, 'image/jpeg', quality));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }
}

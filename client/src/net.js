import { decodeFrame, encodeFrame } from '../../shared/protocol.js';

const MAX_CLIENT_BUFFER = 256 * 1024;

// WebSocket link to the relay, with reconnect. Callers get decoded messages.
export class Net extends EventTarget {
  constructor(name) {
    super();
    this.name = name;
    this.ws = null;
    this.id = null;
    this.retryMs = 1000;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?name=${encodeURIComponent(this.name)}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.retryMs = 1000;
      this.emit('status', { connected: true });
    };
    ws.onclose = () => {
      this.id = null;
      this.emit('status', { connected: false });
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);
        if (msg.t === 'welcome') this.id = msg.id;
        this.emit(msg.t, msg);
      } else {
        this.emit('frame', decodeFrame(e.data));
      }
    };
    this.ws = ws;
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendPose(pose) {
    if (this.open) this.ws.send(JSON.stringify({ t: 'pose', ...pose }));
  }

  // Skips the frame instead of queueing when the uplink is congested.
  sendFrame(pose, jpeg) {
    if (!this.open || this.ws.bufferedAmount > MAX_CLIENT_BUFFER) return false;
    this.ws.send(encodeFrame(pose, jpeg));
    return true;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

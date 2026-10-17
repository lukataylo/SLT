import { register, transformSegment } from '../../../shared/planes.js';
import { fromPlacement, invert, planWalls, toPlacement } from './geometry.js';

// Plan + live map access. The real client talks to the relay server; the mock
// (?mock=1) implements the same contract in memory so the page can be
// developed and demoed without a server or a scanned building.

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApi({ mock = false, token = '' } = {}) {
  return mock ? createMock() : createReal(token);
}

function createReal(token) {
  const headers = { 'content-type': 'application/json', ...(token && { 'x-admin-token': token }) };
  async function call(method, url, body) {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? `${method} ${url} failed (${res.status})`);
    return data;
  }
  return {
    async getPlan() {
      try {
        return await call('GET', '/api/plan');
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
    putPlan: (body) => call('PUT', '/api/plan', body),
    putPlacement: (placement) => call('PUT', '/api/plan/placement', placement),
    autoplace: () => call('POST', '/api/plan/autoplace'),
    deletePlan: () => call('DELETE', '/api/plan'),
    connectMap(onMap, onStatus) {
      let ws;
      let closed = false;
      let retry = 1000;
      const open = () => {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${proto}://${location.host}/ws?role=admin${token ? `&token=${encodeURIComponent(token)}` : ''}`);
        ws.onopen = () => {
          retry = 1000;
          onStatus?.(true);
        };
        ws.onmessage = (e) => {
          if (typeof e.data !== 'string') return;
          const msg = JSON.parse(e.data);
          if (msg.t === 'admin') onMap(msg.map);
          else if (msg.t === 'map') onMap(msg);
        };
        ws.onclose = () => {
          onStatus?.(false);
          if (closed) return;
          setTimeout(open, retry);
          retry = Math.min(retry * 2, 8000);
        };
      };
      open();
      return () => {
        closed = true;
        ws?.close();
      };
    },
  };
}

// --- Mock ------------------------------------------------------------------

// The flat from tools/fake-lidar.mjs, as it would sit on a plan drawn with a
// 1 m margin, "scanned" into a map frame that is rotated and offset from it.
const FLAT = [
  [0, 0, 9, 0], [9, 0, 9, 7], [9, 7, 0, 7], [0, 7, 0, 0],
  [5, 0, 5, 3], [5, 3, 6.5, 3], [7.5, 3, 9, 3],
  [0, 4.5, 3, 4.5], [4, 4.5, 5, 4.5], [5, 4.5, 5, 7],
];
const MOCK_TRUTH = { yaw: 0.35, t: [3, 0, -2] };
const toMap = (s) => transformSegment([s[0] + 1, s[1] + 1, s[2] + 1, s[3] + 1], MOCK_TRUTH);

function createMock() {
  let plan = null;
  let version = 1;
  let listener = null;
  const rooms = [
    {
      id: 'room-1', name: 'Living', origin: [0, 0], planRoomId: null, createdAt: new Date().toISOString(),
      walls: [0, 1, 4, 5, 6].map((i) => toMap(FLAT[i])), seen: [3, 2, 2, 1, 1],
      openings: [{ kind: 'door', s: toMap([6.5, 3, 7.5, 3]), y0: 0, y1: 2.05, seen: 1 }],
      floor: [],
    },
    {
      id: 'room-2', name: 'Bedroom', origin: [0, 0], planRoomId: null, createdAt: new Date().toISOString(),
      walls: [2, 3, 7, 8, 9].map((i) => toMap(FLAT[i])), seen: [1, 2, 1, 1, 1],
      openings: [{ kind: 'window', s: toMap([0, 5.2, 0, 6.4]), y0: 0.9, y1: 2.1, seen: 1 }],
      floor: [],
    },
  ];
  const snapshot = () => ({
    version: version++,
    origin: { by: 'Mock iPhone', at: new Date().toISOString() },
    plan,
    rooms,
    walls: rooms.flatMap((r) => r.walls),
    seen: rooms.flatMap((r) => r.seen),
  });
  const emit = () => listener?.(snapshot());
  const finish = (p) => ({ ...p, widthM: p.widthPx * p.metresPerPx, heightM: p.heightPx * p.metresPerPx, updatedAt: new Date().toISOString() });
  const delay = (v) => new Promise((r) => setTimeout(() => r(structuredClone(v)), 120));

  return {
    getPlan: () => delay(plan),
    async putPlan(body) {
      if (!body.image && !plan) throw new ApiError(400, 'image required for a new plan');
      plan = finish({
        id: plan?.id ?? 'plan-1',
        name: body.name,
        imageUrl: body.image ?? plan.imageUrl,
        widthPx: body.widthPx,
        heightPx: body.heightPx,
        metresPerPx: body.metresPerPx,
        rooms: body.rooms,
        placement: body.image ? null : plan?.placement ?? null,
      });
      // Pretend the phone app linked scanned rooms to the first plan rooms.
      rooms.forEach((r, i) => (r.planRoomId = plan.rooms[i]?.id ?? null));
      emit();
      return delay(plan);
    },
    async putPlacement(placement) {
      if (!plan) throw new ApiError(404, 'no plan');
      plan = { ...plan, placement };
      emit();
      return delay(plan);
    },
    async autoplace() {
      if (!plan) throw new ApiError(404, 'no plan');
      const target = planWalls(plan.rooms);
      const scanned = rooms.flatMap((r) => r.walls);
      const fit = target.length ? register(scanned, target) : null;
      if (!fit || fit.ambiguous || fit.inlierFraction < 0.4) {
        throw new ApiError(409, fit?.ambiguous ? 'Scanned walls fit the plan in more than one place' : 'Not enough scanned walls match the plan rooms');
      }
      // register() maps scanned (map frame) onto the plan; placement is the inverse.
      plan = { ...plan, placement: toPlacement(invert(fromPlacement(fit))) };
      emit();
      return delay({ placement: plan.placement, inlierFraction: fit.inlierFraction, ambiguous: false });
    },
    async deletePlan() {
      plan = null;
      rooms.forEach((r) => (r.planRoomId = null));
      emit();
      return null;
    },
    connectMap(onMap, onStatus) {
      listener = onMap;
      setTimeout(() => {
        onStatus?.(true);
        emit();
      }, 50);
      return () => (listener = null);
    },
  };
}

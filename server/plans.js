import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// REST API for the uploaded floor plan (one per site), used by the designer:
//   GET    /api/plan             plan JSON (404 if none)
//   GET    /api/plan/image       the rendered plan image
//   PUT    /api/plan             { name, image?, widthPx, heightPx, metresPerPx, rooms }
//   PUT    /api/plan/placement   { yaw, t } | null
//   POST   /api/plan/autoplace   match scanned walls into the plan's rooms
//   DELETE /api/plan
// Writes need `x-admin-token` when ADMIN_TOKEN is configured.

const MAX_BODY = 25 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' };

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Plan is too large (25 MB max)'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw Object.assign(new Error('Body is not valid JSON'), { status: 400 });
  }
}

const finite = (v) => Number.isFinite(v);

function cleanRooms(rooms) {
  if (!Array.isArray(rooms)) return [];
  return rooms
    .filter((r) => r && Array.isArray(r.polygon) && r.polygon.length >= 3 && r.polygon.every((p) => Array.isArray(p) && p.length === 2 && p.every(finite)))
    .slice(0, 200)
    .map((r, i) => ({ id: String(r.id || `pr${i + 1}`).slice(0, 40), name: String(r.name || `Room ${i + 1}`).slice(0, 40), polygon: r.polygon.slice(0, 500) }));
}

export function planApi({ map, dir, token = null, onChange = () => {} }) {
  const authorised = (req) => !token || req.headers['x-admin-token'] === token;

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/plan')) return false;
    try {
      const route = `${req.method} ${url.pathname}`;
      if (req.method !== 'GET' && !authorised(req)) return send(res, 401, { error: 'Admin token required' }), true;

      if (route === 'GET /api/plan') {
        map.plan ? send(res, 200, map.plan) : send(res, 404, { error: 'No plan uploaded' });
      } else if (route === 'GET /api/plan/image') {
        if (!map.plan?.imageFile) return send(res, 404, { error: 'No plan image' }), true;
        const bytes = await readFile(path.join(dir, map.plan.imageFile));
        res.writeHead(200, { 'content-type': map.plan.imageType, 'content-length': bytes.length, 'cache-control': 'public, max-age=31536000, immutable' });
        res.end(bytes);
      } else if (route === 'PUT /api/plan') {
        const body = await readJson(req);
        const mpp = body?.metresPerPx;
        if (!finite(mpp) || mpp <= 0 || !finite(body.widthPx) || !finite(body.heightPx)) {
          return send(res, 400, { error: 'widthPx, heightPx and a positive metresPerPx are required' }), true;
        }
        const prev = map.plan;
        let imageFile = prev?.imageFile;
        let imageType = prev?.imageType;
        if (body.image) {
          const m = /^data:(image\/(?:jpeg|png));base64,(.+)$/s.exec(body.image);
          if (!m) return send(res, 400, { error: 'image must be a JPEG or PNG data URL' }), true;
          imageType = m[1];
          imageFile = `plan-${randomUUID()}.${IMAGE_TYPES[imageType]}`;
          await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, imageFile), Buffer.from(m[2], 'base64'));
          if (prev?.imageFile && prev.imageFile !== imageFile) rm(path.join(dir, prev.imageFile), { force: true }).catch(() => {});
        }
        if (!imageFile) return send(res, 400, { error: 'An image is required for a new plan' }), true;
        const updatedAt = new Date().toISOString();
        // A new image means a different drawing, so its old placement no longer holds.
        const placement = body.image ? null : (prev?.placement ?? null);
        map.setPlan({
          id: prev?.id ?? randomUUID(),
          name: String(body.name || 'Floor plan').slice(0, 80),
          imageFile,
          imageType,
          imageUrl: `/api/plan/image?v=${Date.parse(updatedAt)}`,
          widthPx: body.widthPx,
          heightPx: body.heightPx,
          metresPerPx: mpp,
          widthM: body.widthPx * mpp,
          heightM: body.heightPx * mpp,
          rooms: cleanRooms(body.rooms),
          placement,
          updatedAt,
        });
        onChange();
        send(res, 200, map.plan);
      } else if (route === 'PUT /api/plan/placement') {
        const body = await readJson(req);
        const valid = body === null || (finite(body?.yaw) && Array.isArray(body.t) && body.t.length === 3 && body.t.every(finite));
        if (!valid) return send(res, 400, { error: 'placement must be { yaw, t: [x, 0, z] } or null' }), true;
        if (!map.setPlacement(body && { yaw: body.yaw, t: [body.t[0], 0, body.t[2]] })) return send(res, 404, { error: 'No plan uploaded' }), true;
        onChange();
        send(res, 200, map.plan);
      } else if (route === 'POST /api/plan/autoplace') {
        const result = map.autoPlace();
        if (result.error) return send(res, 409, result), true;
        onChange();
        send(res, 200, result);
      } else if (route === 'DELETE /api/plan') {
        if (map.plan?.imageFile) await rm(path.join(dir, map.plan.imageFile), { force: true });
        map.setPlan(null);
        onChange();
        send(res, 204);
      } else {
        send(res, 404, { error: 'Unknown plan route' });
      }
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message });
    }
    return true;
  };
}

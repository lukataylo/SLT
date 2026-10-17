import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LiveMap } from '../server/livemap.js';
import { planApi } from '../server/plans.js';

async function serve(opts) {
  const dir = await mkdtemp(path.join(tmpdir(), 'slt-plan-'));
  const map = new LiveMap();
  const handle = planApi({ map, dir, ...opts });
  const server = createServer(async (req, res) => (await handle(req, res)) || res.writeHead(404).end());
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = (method, p, body, headers = {}) =>
    fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { map, call, close: () => server.close() };
}

// 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const rooms = [{ id: 'a', name: 'Lounge', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] }, { id: 'bad', polygon: [[0, 0]] }];

test('upload, read back, image, placement and delete', async () => {
  const { map, call, close } = await serve();
  try {
    assert.equal((await call('GET', '/api/plan')).status, 404);
    const res = await call('PUT', '/api/plan', { name: 'Flat', image: PNG, widthPx: 400, heightPx: 300, metresPerPx: 0.02, rooms });
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.deepEqual([plan.widthM, plan.heightM, plan.rooms.length], [8, 6, 1]);
    assert.equal(map.plan.id, plan.id);

    const img = await call('GET', plan.imageUrl);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.ok((await img.arrayBuffer()).byteLength > 0);

    const placed = await (await call('PUT', '/api/plan/placement', { yaw: 0.5, t: [1, 9, 2] })).json();
    assert.deepEqual(placed.placement, { yaw: 0.5, t: [1, 0, 2] }, 'placement stays on the floor');

    // Re-saving rooms without a new image keeps image and placement.
    const kept = await (await call('PUT', '/api/plan', { name: 'Flat', widthPx: 400, heightPx: 300, metresPerPx: 0.02, rooms })).json();
    assert.deepEqual(kept.placement, { yaw: 0.5, t: [1, 0, 2] });

    assert.equal((await call('POST', '/api/plan/autoplace')).status, 409, 'nothing scanned yet');
    assert.equal((await call('DELETE', '/api/plan')).status, 204);
    assert.equal(map.plan, null);
  } finally {
    close();
  }
});

test('writes need the admin token when one is set; bad input is rejected', async () => {
  const { call, close } = await serve({ token: 's3cret' });
  try {
    const body = { image: PNG, widthPx: 1, heightPx: 1, metresPerPx: 0.1, rooms: [] };
    assert.equal((await call('PUT', '/api/plan', body)).status, 401);
    assert.equal((await call('PUT', '/api/plan', { ...body, image: 'data:text/html;base64,AA' }, { 'x-admin-token': 's3cret' })).status, 400);
    assert.equal((await call('PUT', '/api/plan', { ...body, metresPerPx: 0 }, { 'x-admin-token': 's3cret' })).status, 400);
    assert.equal((await call('PUT', '/api/plan', body, { 'x-admin-token': 's3cret' })).status, 200);
  } finally {
    close();
  }
});

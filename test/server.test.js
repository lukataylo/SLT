import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { WebSocket } from 'ws';

// Starts the real server on a spare port with a small message cap.
async function startServer() {
  const port = 9000 + Math.floor(Math.random() * 900);
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), MAX_MESSAGE_BYTES: String(64 * 1024), MAP_FILE: '' },
    stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    proc.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { port, proc };
}

test('an oversized message closes that connection without crashing the server', async () => {
  const { port, proc } = await startServer();
  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws?name=big&frame=local`);
    await new Promise((r) => ws.on('open', r));
    const closed = new Promise((r) => ws.on('close', r));
    ws.on('error', () => {});
    ws.send(JSON.stringify({ t: 'collab', data: 'x'.repeat(200 * 1024) }));
    await closed;

    const res = await fetch(`http://localhost:${port}/healthz`);
    assert.equal(res.status, 200, 'server still answering');
    assert.equal(proc.exitCode, null, 'server still running');
  } finally {
    proc.kill();
  }
});

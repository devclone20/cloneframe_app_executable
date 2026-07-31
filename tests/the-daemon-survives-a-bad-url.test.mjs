// One unauthenticated GET, and the whole app was gone.
//
//     curl 'http://127.0.0.1:8765/%'
//
// `serveStatic` runs at hub-bridge.mjs:318, BEFORE the pairing gate at line 331 — deliberately,
// because the HTML is not secret. Its first statement was `decodeURIComponent(pathname)`, and
// `decodeURIComponent('/%')` throws URIError: the escape is malformed. The request handler is
// `async (req, res)` with no try/catch and the process installs no 'uncaughtException' guard,
// so the rejection took the daemon down: every live terminal session, the task scheduler, the
// agent, the lot. Anything that can reach loopback with our Host header could do it, unpaired.
//
// Two fixes, and both belong here. The decode is now attempted, not assumed — a path that is
// not valid percent-encoding is not a file we serve, so it falls through to the 401/404 like
// any other miss. And the router has a top-level catch, because the lesson is not "that one
// decode" — it is that a throw anywhere in routing must cost one request, never the daemon.
//
// This test boots a REAL bridge on a scratch port with a scratch HOME. A static assertion
// would have passed against the broken code the moment someone wrote `try { decode }` in the
// wrong place; only a live process proves the daemon is still there afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8817;                     // not 8765 (the owner's app) and not 8799 (dev-smoke)
const BASE = `http://127.0.0.1:${PORT}`;

const health = async () => {
  try {
    const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

// Malformed on purpose. Each one used to reach decodeURIComponent as-is.
const BAD_PATHS = ['/%', '/%zz', '/%E0%A4%A', '/a%', '/%%', '/index%.html'];

test('a malformed percent-escape costs one request, not the daemon', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'cfhub-badurl-'));
  const child = spawn(process.execPath, ['hub-bridge.mjs'], {
    cwd: path.join(ROOT, 'bridge'),
    env: { ...process.env, HOME: home, HUB_BRIDGE_PORT: String(PORT), CLONE_FRAME_HUB_ROOT: path.join(home, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} rmSync(home, { recursive: true, force: true }); });

  let up = null;
  for (let i = 0; i < 80 && !up; i++) { up = await health(); if (!up) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(up && up.ok, 'the test bridge never came up — nothing below would mean anything');

  for (const p of BAD_PATHS) {
    // The request itself may fail or 404 — that is fine and not what is under test.
    try { await fetch(BASE + p, { signal: AbortSignal.timeout(2000) }); } catch { /* expected for some */ }
    const still = await health();
    assert.ok(still && still.ok,
      `GET ${p} killed the daemon — /health stopped answering.\n` +
      'A request the caller does not even have to be paired for must never end the process.\n' +
      (stderr ? 'daemon stderr:\n' + stderr.split('\n').slice(-8).join('\n') : ''));
  }

  // And it is still a working bridge, not merely a live socket.
  const after = await health();
  assert.equal(after.name, 'HUB Bridge');
  assert.ok(!child.killed && child.exitCode === null, 'the daemon process exited during the run');
});

// keeper-socket.test.mjs — B10 (Keeper socket TOCTOU) regression suite.
//
// bridge/keeper.mjs's unix socket lives under os.tmpdir(), which on Linux is the
// SHARED, world-writable /tmp: a local attacker can pre-create the socket dir, or
// plant a socket at the exact path a session will use, before our own daemon ever
// runs. This file pins the fix: (b) ensureSockDir() REFUSES a directory it cannot
// prove is private, and (c)/(d) a per-session secret handshake means a squatter
// who still wins a path race cannot pass as our daemon.
//
// Every assertion here drives the REAL exported code (via Keeper._-prefixed test
// seams — none reachable through /mod RPC, same convention as _spawnDaemon /
// _keeperPath already on this module) over REAL sockets. No PTY is ever spawned:
// node-pty is a native module that may not be built in CI, and none of this
// module's socket-trust logic depends on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const REAL_HOME = process.env.HOME || os.homedir();

// Isolate BEFORE import: keeperDir() reads CLONE_FRAME_HUB_ROOT lazily (never
// frozen at import), but we still set both envs ahead of the import per the
// house rule — a test must never be able to write into the developer's real
// ~/.clone-frame-hub, even transiently.
const HUB_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-keeper-hubroot-'));
const SOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-keeper-sockroot-'));
process.env.CLONE_FRAME_HUB_ROOT = HUB_ROOT;
process.env.CFHUB_KEEPER_SOCK_DIR = SOCK_ROOT;

const { Keeper } = await import('../bridge/keeper.mjs');

function uniqueId(tag) {
  return `t-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Isolation — must run first: proves the seam actually redirects storage, and
// that the developer's real ~/.clone-frame-hub is never touched by this suite.
// ═════════════════════════════════════════════════════════════════════════════

test('env isolation — keeper meta resolves under the test hub root, and the real ~/.clone-frame-hub is untouched', () => {
  const realKeeperDir = path.join(REAL_HOME, '.clone-frame-hub', 'keeper');
  const before = fs.existsSync(realKeeperDir) ? fs.readdirSync(realKeeperDir).sort() : null;

  assert.equal(Keeper._keeperDir(), path.join(HUB_ROOT, 'keeper'), 'keeperDir() must resolve under CLONE_FRAME_HUB_ROOT, not the real HOME');
  Keeper._ensureDir();
  const id = uniqueId('isolation');
  Keeper._writeMeta(id, { id, pid: process.pid });
  assert.deepEqual(Keeper._readMeta(id), { id, pid: process.pid });
  assert.ok(fs.existsSync(path.join(HUB_ROOT, 'keeper', id + '.json')), 'meta must land inside the test hub root');

  const after = fs.existsSync(realKeeperDir) ? fs.readdirSync(realKeeperDir).sort() : null;
  assert.deepEqual(after, before, 'the real ~/.clone-frame-hub/keeper directory must be byte-for-byte unaffected by this suite');
});

test('production path is byte-identical when the env overrides are unset', () => {
  const prevRoot = process.env.CLONE_FRAME_HUB_ROOT;
  const prevSock = process.env.CFHUB_KEEPER_SOCK_DIR;
  delete process.env.CLONE_FRAME_HUB_ROOT;
  delete process.env.CFHUB_KEEPER_SOCK_DIR;
  try {
    // string comparison only — no fs write, so the real dirs are never touched even here.
    assert.equal(Keeper._keeperDir(), path.join(REAL_HOME, '.clone-frame-hub', 'keeper'));
    assert.equal(Keeper._sockDir(), path.join(os.tmpdir(), 'cfhub-keeper'));
  } finally {
    process.env.CLONE_FRAME_HUB_ROOT = prevRoot;
    process.env.CFHUB_KEEPER_SOCK_DIR = prevSock;
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// (b) ensureSockDir() — the directory-privacy gate.
// ═════════════════════════════════════════════════════════════════════════════

test('a socket dir that is group/other-writable is REFUSED, not silently repaired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-keeper-loose-'));
  fs.chmodSync(dir, 0o777);
  const prev = process.env.CFHUB_KEEPER_SOCK_DIR;
  process.env.CFHUB_KEEPER_SOCK_DIR = dir;
  try {
    assert.throws(() => Keeper._ensureSockDir(), /refusing socket dir/i, 'a 0777 pre-created dir must not be silently accepted');
    // proves the refusal is real, not cosmetic: the loose mode is still there — nothing
    // silently "fixed" it and moved on. Revert the fix and this line never runs (the
    // throw above would never fire), which is exactly the regression this guards.
    assert.equal(fs.statSync(dir).mode & 0o777, 0o777, 'ensureSockDir must not mutate a dir it refuses to trust');
  } finally {
    process.env.CFHUB_KEEPER_SOCK_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a socket dir that is a symlink is REFUSED', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-keeper-symlink-'));
  const realTarget = path.join(base, 'real-target');
  fs.mkdirSync(realTarget, { mode: 0o700 });
  const linkPath = path.join(base, 'cfhub-keeper-link');
  fs.symlinkSync(realTarget, linkPath, 'dir');
  const prev = process.env.CFHUB_KEEPER_SOCK_DIR;
  process.env.CFHUB_KEEPER_SOCK_DIR = linkPath;
  try {
    assert.throws(() => Keeper._ensureSockDir(), /refusing socket dir/i, 'a symlinked path must never be trusted, even with a private target');
  } finally {
    process.env.CFHUB_KEEPER_SOCK_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a private (0700, owned, non-symlink) dir is accepted — the happy path still works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-keeper-good-'));
  const prev = process.env.CFHUB_KEEPER_SOCK_DIR;
  process.env.CFHUB_KEEPER_SOCK_DIR = dir;
  try {
    assert.equal(Keeper._ensureSockDir(), dir);
  } finally {
    process.env.CFHUB_KEEPER_SOCK_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// (c)/(d) the auth handshake itself, over REAL sockets, via the exact production
// gate (Keeper._makeAuthGate) — never a test-side reimplementation.
// ═════════════════════════════════════════════════════════════════════════════

test('wrong secret is destroyed before it ever reaches onAuthed (the PTY / control-verb layer)', async () => {
  const secret = 'correct-secret-value';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-keeper-gate-bad-'));
  const sp = path.join(dir, 'test.sock');
  let onAuthedCalled = false;
  const server = net.createServer(Keeper._makeAuthGate(secret, () => { onAuthedCalled = true; }));
  await new Promise((resolve) => server.listen(sp, resolve));
  try {
    const closed = await new Promise((resolve) => {
      const c = net.connect(sp);
      c.on('connect', () => { c.write(JSON.stringify({ auth: 'WRONG-SECRET' }) + '\n'); });
      c.on('close', () => resolve(true));
      c.on('error', () => {});
      const t = setTimeout(() => resolve(false), 1500); t.unref?.();
    });
    assert.equal(closed, true, 'the gate must destroy the socket on a bad auth frame');
    assert.equal(onAuthedCalled, false, 'onAuthed (PTY/control layer) must never run for a wrong secret');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('correct secret authenticates, gets a one-line ack, and forwards bytes glued to the frame', async () => {
  const secret = 'right-secret-xyz';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-keeper-gate-ok-'));
  const sp = path.join(dir, 'test.sock');
  let leftoverSeen = null;
  const server = net.createServer(Keeper._makeAuthGate(secret, (sock, leftover) => {
    leftoverSeen = leftover.toString('utf8');
    try { sock.write('PTY-ECHO:' + leftoverSeen); } catch {}
  }));
  await new Promise((resolve) => server.listen(sp, resolve));
  let c;
  try {
    const out = await new Promise((resolve) => {
      c = net.connect(sp);
      let buf = '';
      // "HELLO" is glued to the SAME write as the auth frame — it must ride through as
      // real client data, not be swallowed by the handshake parser.
      c.on('connect', () => { c.write(JSON.stringify({ auth: secret }) + '\nHELLO'); });
      c.on('data', (d) => { buf += d.toString('utf8'); if (buf.includes('PTY-ECHO:')) resolve(buf); });
      c.on('error', () => resolve(buf));
      const t = setTimeout(() => resolve(buf), 1500); t.unref?.();
    });
    assert.match(out, /^\{"auth":"ok"\}\n/, 'the ack line must be sent first, newline-terminated');
    assert.equal(leftoverSeen, 'HELLO', 'bytes glued to the auth frame must reach onAuthed as `leftover`');
    assert.ok(out.includes('PTY-ECHO:HELLO'), 'onAuthed must actually run — proves the mechanism did something, not merely "nothing bad happened"');
  } finally {
    try { c && c.destroy(); } catch {} // neither side ends this stub connection on its own — must close it ourselves
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unauthenticated connection is dropped by the server-side timeout, not held open forever', async () => {
  const secret = 'timeout-secret';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-keeper-gate-timeout-'));
  const sp = path.join(dir, 'test.sock');
  const server = net.createServer(Keeper._makeAuthGate(secret, () => {
    throw new Error('must never authenticate — this client sends nothing');
  }));
  await new Promise((resolve) => server.listen(sp, resolve));
  try {
    const closed = await new Promise((resolve) => {
      const c = net.connect(sp);
      c.on('connect', () => {}); // deliberately silent — a squatter holding the slot open
      c.on('close', () => resolve(true));
      c.on('error', () => {});
      const t = setTimeout(() => resolve(false), 6500); t.unref?.();
    });
    assert.equal(closed, true, 'the server must close an unauthenticated connection on its own (UNAUTH_TIMEOUT_MS)');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_authLineOk: exact secret match required — pure decision, tested in isolation', () => {
  assert.equal(Keeper._authLineOk('{"auth":"abc"}', 'abc'), true);
  assert.equal(Keeper._authLineOk('{"auth":"abcd"}', 'abc'), false, 'longer guess must not match');
  assert.equal(Keeper._authLineOk('{"auth":"ab"}', 'abc'), false, 'shorter guess must not match');
  assert.equal(Keeper._authLineOk('not json', 'abc'), false, 'garbage is refused, never crashes');
  assert.equal(Keeper._authLineOk('{}', 'abc'), false, 'missing auth field is refused');
  assert.equal(Keeper._authLineOk('{"auth":"abc"}', ''), false, 'an empty/absent secret never authenticates anything');
});

// ═════════════════════════════════════════════════════════════════════════════
// The actual B10 finding: the liveness probe must prove identity, not just
// "something answered the connect". Regression test for the real vulnerability.
// ═════════════════════════════════════════════════════════════════════════════

test('sockConnectable resolves FALSE for a squatter that accepts connections but cannot answer the handshake (B10 regression)', async () => {
  const id = uniqueId('regress');
  Keeper._ensureDir();
  const secret = 'session-secret-' + Math.random().toString(36).slice(2);
  Keeper._writeMeta(id, { id, pid: process.pid, secret });
  const sp = Keeper._sockPath(id);

  let rogueReceived = 0;
  const rogue = net.createServer((sock) => {
    sock.on('data', (d) => { rogueReceived += d.length; }); // never answers — just a bare accept, like a planted socket
    sock.on('error', () => {});
  });
  await new Promise((resolve) => rogue.listen(sp, resolve));
  try {
    const ok = await Keeper._sockConnectable(id);
    assert.equal(ok, false, 'a squatter that cannot prove it knows the secret must never be reported as our daemon');
    // proves the probe actually engaged the handshake (sent the auth frame) rather than
    // failing for some unrelated reason — the OLD probe (bare connect→resolve(true)) would
    // never have written anything and would have resolved true instead.
    assert.ok(rogueReceived > 0, 'the probe must have attempted the handshake against the squatter');
  } finally {
    rogue.close();
    try { fs.unlinkSync(sp); } catch {}
    try { fs.unlinkSync(Keeper._metaPath(id)); } catch {}
  }
});

test('sockConnectable resolves TRUE against a real auth-gated daemon stand-in that knows the secret', async () => {
  const id = uniqueId('realdaemon');
  Keeper._ensureDir();
  const secret = 'session-secret-' + Math.random().toString(36).slice(2);
  Keeper._writeMeta(id, { id, pid: process.pid, secret });
  const sp = Keeper._sockPath(id);

  const real = net.createServer(Keeper._makeAuthGate(secret, () => {}));
  await new Promise((resolve) => real.listen(sp, resolve));
  try {
    const ok = await Keeper._sockConnectable(id);
    assert.equal(ok, true, 'a daemon that actually knows the secret must be recognised as alive');
  } finally {
    real.close();
    try { fs.unlinkSync(sp); } catch {}
    try { fs.unlinkSync(Keeper._metaPath(id)); } catch {}
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Backward compatibility: a session from a PREVIOUS build has no `secret` in its
// meta. A client must send NOTHING in that case — an auth frame would otherwise
// be typed into the user's live shell as literal input.
// ═════════════════════════════════════════════════════════════════════════════

test('backward compat — no secret in meta means sockConnectable sends NO auth frame, and still reads connect-only', async () => {
  const id = uniqueId('legacy');
  Keeper._ensureDir();
  Keeper._writeMeta(id, { id, pid: process.pid }); // no `secret` field — a pre-B10 daemon
  const sp = Keeper._sockPath(id);

  let receivedBytes = 0;
  const legacy = net.createServer((sock) => {
    sock.on('data', (d) => { receivedBytes += d.length; });
    sock.on('error', () => {});
  });
  await new Promise((resolve) => legacy.listen(sp, resolve));
  try {
    const ok = await Keeper._sockConnectable(id);
    assert.equal(ok, true, 'a bare-connect legacy session must still read as alive — unchanged pre-B10 behaviour');
    await new Promise((r) => setTimeout(r, 80)); // give any (incorrect) write time to land before we check
    assert.equal(receivedBytes, 0, 'no auth frame may ever be sent to a session whose meta has no secret');
  } finally {
    legacy.close();
    try { fs.unlinkSync(sp); } catch {}
    try { fs.unlinkSync(Keeper._metaPath(id)); } catch {}
  }
});

test('backward compat — cliAttach only sends the auth frame when meta.secret is present (structural tripwire)', () => {
  // cliAttach drives a live TTY / process.exit and isn't practical to run in-process;
  // node-pty may also be absent in CI. Pin the guard the same way this codebase already
  // does for other cases that can't be driven end-to-end (see security-regression.test.mjs
  // INV-6). This complements the real-socket sockConnectable test above, which exercises
  // the same "no secret → no frame" contract over an actual connection.
  const src = fs.readFileSync(new URL('../bridge/keeper.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('function cliAttach');
  const end = src.indexOf('function cliRun');
  assert.ok(start > -1 && end > start, 'cliAttach must exist as a function in keeper.mjs');
  const cliAttachSrc = src.slice(start, end);
  assert.match(cliAttachSrc, /if \(!secret\) \{ startPipe\(\); return; \}/,
    'cliAttach must skip the handshake entirely — send nothing — when meta has no secret');
  assert.match(cliAttachSrc, /authenticateSocket\(sock, secret,/,
    'cliAttach must otherwise run the real handshake helper, not a bespoke reimplementation');
});

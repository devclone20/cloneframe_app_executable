// Context test for the calendar domain module AFTER its migration onto the
// shared json-store port (Wave-3). Proves the migration is behavior-preserving
// end-to-end against a REAL filesystem, isolated to a throwaway dir via
// CLONE_FRAME_HUB_ROOT (the hub-root seam).
//
// Calendar persists TWO stores: calendar.json (non-secret connection + event
// cache) and calendar.secret.json (credentials, 0600, never returned). This
// test exercises the LOCAL-STORE surface only — status() and disconnect() —
// never the CalDAV network methods (events/createEvent/deleteEvent/upcoming),
// whose DAV request/parse code is out of scope for this migration.
//
// The one exception is connect(): it is the ONLY exported path that WRITES the
// secret store, so it is the only way to prove the secret store round-trips at
// 0600 through the module's real persistence code. We drive it with a STUBBED
// global fetch that returns a bare HTTP 207 — connect() inspects only the
// status code, so NO real network call and NO DAV XML parsing is exercised;
// the stub exists solely to reach the local saveSecret()/saveStore() writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function freshCalendar() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-calendar-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/calendar.mjs?ctx=' + Math.random().toString(36).slice(2));
  return {
    root,
    Cal: mod.Calendar,
    file: path.join(root, 'calendar.json'),
    secretFile: path.join(root, 'calendar.secret.json'),
  };
}

function seed(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

test('status() on a fresh store reports disconnected without throwing', async () => {
  const { Cal, file } = await freshCalendar();
  assert.deepEqual(Cal.status(), { connected: false });
  // read-path must not create the store file (pure read, dir creation is a write concern)
  assert.equal(fs.existsSync(file), false);
});

test('disconnect() persists a cleared calendar.json at 0600', async () => {
  const { Cal, file, secretFile } = await freshCalendar();
  const res = Cal.disconnect();
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(secretFile), false); // nothing to clear, stays absent
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.connection, null);
  assert.deepEqual(onDisk.events, []);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a persisted connection + secret round-trips through status(), never leaking creds', async () => {
  const { Cal, file, secretFile } = await freshCalendar();
  seed(file, { version: 1, connection: { url: 'https://dav.example.com/cal/', connectedAt: 1_700_000_000_000 }, events: [] });
  seed(secretFile, { version: 1, url: 'https://dav.example.com/cal/', user: 'alice', pass: 'topsecretpass' });

  const st = Cal.status();
  assert.deepEqual(st, { connected: true, url: 'https://dav.example.com/cal/' });
  assert.equal('user' in st, false);
  assert.equal('pass' in st, false);
  // belt-and-suspenders: the secret value never appears in the projection
  assert.equal(JSON.stringify(st).includes('topsecretpass'), false);
});

test('connect() writes the secret store at 0600 and status() never leaks it; disconnect() clears both', async () => {
  const { Cal, file, secretFile } = await freshCalendar();
  const realFetch = globalThis.fetch;
  // Bare 207 — connect() only checks res.ok / res.status, so no DAV parse runs.
  globalThis.fetch = async () => ({ ok: true, status: 207, statusText: 'Multi-Status', text: async () => '' });
  try {
    const res = await Cal.connect({ url: 'https://dav.example.com/cal/', user: 'alice', pass: 'topsecretpass' });
    assert.equal(res.ok, true);

    // secret store round-trips at 0600
    assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
    const rawSecret = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
    assert.equal(rawSecret.url, 'https://dav.example.com/cal/');
    assert.equal(rawSecret.user, 'alice');
    assert.equal(rawSecret.pass, 'topsecretpass');

    // main store also written at 0600
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    // read projection exposes url only — no credential leak
    const st = Cal.status();
    assert.deepEqual(st, { connected: true, url: 'https://dav.example.com/cal/' });
    assert.equal(JSON.stringify(st).includes('topsecretpass'), false);

    // disconnect() removes the secret file and clears the connection
    assert.equal(Cal.disconnect().ok, true);
    assert.equal(fs.existsSync(secretFile), false);
    assert.deepEqual(Cal.status(), { connected: false });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('corrupt calendar.json / secret file degrade to disconnected instead of throwing', async () => {
  const { Cal, file, secretFile } = await freshCalendar();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json at all');
  assert.deepEqual(Cal.status(), { connected: false });

  // valid connection but corrupt secret → loadSecret() yields null → disconnected
  seed(file, { version: 1, connection: { url: 'https://dav.example.com/cal/' }, events: [] });
  fs.writeFileSync(secretFile, '}{ corrupt');
  assert.deepEqual(Cal.status(), { connected: false });
});

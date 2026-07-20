// ─────────────────────────────────────────────────────────────────────────────
// Fork-consolidation test for bridge/integrations.mjs (Wave-3).
//
// integrations.mjs had three candidate forks. This test pins the outcome of
// each, offline (fresh CLONE_FRAME_HUB_ROOT tmp dir, cache-busted dynamic
// import), with the network REQUEST captured through a fetch stub — never a
// real host:
//
//   (a) testDav → MIGRATED onto platform/dav.mjs `davFetch`. Pinned here: the
//       outgoing PROPFIND request is byte-identical (method / Depth:0 /
//       content-type / Basic-auth wire value / body / follow), and the caught
//       error still comes from the LOCAL describeFetchError ('timed out', not
//       the port's 'request timed out') so test()'s return shape is preserved.
//
//   (b) testApi → LEFT LOCAL (flagged). It is a generic REST GET/HEAD health
//       check, NOT an eth_call / JSON-RPC chain read; platform/evm.mjs would
//       change the wire request from GET to a POST eth_call. Source pin: the
//       module does not import platform/evm.mjs.
//
//   (c) SECRET_KEYS / hasAuthConfigured → LEFT LOCAL (flagged). redact.mjs is a
//       verified redaction superset, but integrations protects secrets by
//       WHITELIST projection (buildMeta) + a presence-detection boolean
//       (hasAuthConfigured), not by blacklist masking. sanitize() would weaken
//       the whitelist to a blacklist; isSecretKey() would broaden the key set
//       and flip meta.hasAuth. Source pin: no import of platform/redact.mjs.
//       Behavior pin: stored apiKey / authHeader.value / caldav password STILL
//       never surface in list()/get().
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API_KEY_SECRET = 'sk-DUMMY-apikey-must-not-leak-0001';
const HEADER_SECRET = 'DUMMY-authheader-value-must-not-leak-0002';
const DAV_PASS_SECRET = 'DUMMY-caldav-password-must-not-leak-0003';

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>';

const SRC_PATH = new URL('../bridge/integrations.mjs', import.meta.url);

async function freshIntegrations() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-integrations-fork-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/integrations.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, I: mod.Integrations, file: path.join(root, 'integrations.json') };
}

// Stub the global fetch (undici) resolved at call time by davFetch/testDav —
// captures the request without touching the network, and returns a value the
// handshake discards (it treats any resolution as reachable).
function withCapturedFetch(fn, impl) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (impl) return impl(url, opts);
    return { ok: true, status: 207 };
  };
  const restore = () => { globalThis.fetch = orig; };
  return Promise.resolve(fn(calls)).finally(restore);
}

function headerVal(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

// ── (a) DAV fork migrated onto davFetch — byte-identical PROPFIND request ─────
test('(a) testDav emits a byte-identical authed PROPFIND through davFetch', async () => {
  const { I } = await freshIntegrations();
  const added = await I.add({
    type: 'caldav',
    name: 'cal',
    config: { url: 'https://dav.test/cal', username: 'alice', password: DAV_PASS_SECRET },
  });
  assert.equal(added.ok, true);

  await withCapturedFetch(async (calls) => {
    const res = await I.test(added.id);
    assert.deepEqual(res, { ok: true, status: 'connected' });

    assert.equal(calls.length, 1);
    const { url, opts } = calls[0];
    assert.equal(url, 'https://dav.test/cal');
    assert.equal(opts.method, 'PROPFIND');
    assert.equal(opts.body, PROPFIND_BODY);
    assert.equal(opts.redirect, 'follow');
    assert.ok(opts.signal instanceof AbortSignal, 'timeout signal is attached');
    assert.equal(headerVal(opts.headers, 'Depth'), '0');
    assert.equal(headerVal(opts.headers, 'content-type'), 'application/xml; charset=utf-8');
    assert.equal(
      headerVal(opts.headers, 'Authorization'),
      `Basic ${Buffer.from(`alice:${DAV_PASS_SECRET}`).toString('base64')}`,
    );
  });

  // status persisted from the handshake result
  assert.equal((await I.get(added.id)).status, 'connected');
});

test('(a) testDav attaches NO Authorization when creds are absent', async () => {
  const { I } = await freshIntegrations();
  const added = await I.add({ type: 'carddav', name: 'card', config: { url: 'https://dav.test/card' } });

  await withCapturedFetch(async (calls) => {
    await I.test(added.id);
    const { opts } = calls[0];
    assert.equal(opts.method, 'PROPFIND');
    assert.equal(headerVal(opts.headers, 'Authorization'), undefined);
    assert.equal(headerVal(opts.headers, 'Depth'), '0');
  });
});

test('(a) testDav uses the LOCAL describeFetchError ("timed out", not the port string)', async () => {
  const { I } = await freshIntegrations();
  const added = await I.add({
    type: 'caldav',
    name: 'cal',
    config: { url: 'https://dav.test/cal', username: 'alice', password: DAV_PASS_SECRET },
  });

  const timeoutErr = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  const res = await withCapturedFetch(
    () => I.test(added.id),
    async () => { throw timeoutErr; },
  );
  assert.deepEqual(res, { ok: false, status: 'error', error: 'timed out' });
});

// ── source pins for the migrated + left-behind forks ─────────────────────────
test('source: testDav imports and uses davFetch, no longer hand-rolls the PROPFIND fetch', () => {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  assert.match(src, /import \{[^}]*\bdavFetch\b[^}]*\} from '\.\/platform\/dav\.mjs'/);
  assert.match(src, /await davFetch\(\{/);
  // the inline hand-rolled PROPFIND fetch is gone
  assert.ok(!/fetch\(config\.url, \{\s*\n\s*method: 'PROPFIND'/.test(src), 'inline PROPFIND fetch must be gone');
});

test('(b) source: testApi stays local — evm.mjs is NOT imported (chain-read fork absent here)', () => {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  assert.ok(!src.includes("platform/evm.mjs"), 'must not consume the EVM port');
  // testApi is still the generic REST GET/HEAD health check
  assert.match(src, /config\.method && config\.method\.toUpperCase\(\) === 'HEAD'/);
});

test('(c) source: redact.mjs is NOT imported — local SECRET_KEYS / hasAuthConfigured kept', () => {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  assert.ok(!src.includes("platform/redact.mjs"), 'must not consume the redact port');
  assert.match(src, /const SECRET_KEYS = new Set\(\['password', 'apiKey', 'token', 'pass', 'secret'\]\)/);
  assert.match(src, /function hasAuthConfigured\(config\)/);
});

// ── (c) behavior pin: the whitelist projection still hides every secret ───────
test('(c) stored secrets NEVER surface in list()/get(), yet meta.hasAuth stays true', async () => {
  const { I } = await freshIntegrations();
  const api = await I.add({
    type: 'api',
    name: 'secret api',
    config: {
      baseUrl: 'https://secret.test',
      apiKey: API_KEY_SECRET,
      authHeader: { name: 'X-Api-Key', value: HEADER_SECRET },
    },
  });
  const dav = await I.add({
    type: 'caldav',
    name: 'secret dav',
    config: { url: 'https://dav.test/cal', username: 'alice', password: DAV_PASS_SECRET },
  });

  const publicJson =
    JSON.stringify(await I.list()) +
    JSON.stringify(await I.get(api.id)) +
    JSON.stringify(await I.get(dav.id));
  for (const secret of [API_KEY_SECRET, HEADER_SECRET, DAV_PASS_SECRET]) {
    assert.equal(publicJson.includes(secret), false, `projection leaked ${secret}`);
  }
  assert.equal((await I.get(api.id)).meta.hasAuth, true);
  assert.equal((await I.get(dav.id)).meta.hasAuth, true);
});

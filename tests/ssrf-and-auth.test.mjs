// ─────────────────────────────────────────────────────────────────────────────
// T-006 · Characterization tests — web SSRF guard + hub-bridge's constant-time
// token compare / loopback-only guard
// Targets (READ, never modified):
//   bridge/web.mjs
//     — isPrivateIPv4/isPrivateIPv6/isBlockedHost/assertSafeUrl (all private),
//       exercised through the exported fetchUrl()
//   bridge/hub-bridge.mjs
//     — authed() line ~116-126 (constant-time-ish bearer/query token compare)
//     — localOnly() line ~107-115 (anti DNS-rebinding Host+socket check)
//
// Part 1 (web.mjs) imports the REAL exported `fetchUrl` and exercises it
// directly — every case here is a URL the guard rejects BEFORE any network
// I/O happens (literal private/loopback IPs, disallowed schemes, "localhost"),
// so this makes zero real network calls and needs no mocking.
//
// Part 2 (hub-bridge.mjs) is not safely `import`-able (see sse-stream-parse
// test header for why), and authed()/localOnly() are unexported closures over
// module state (TOKEN, PORT). Per the ticket's "test the observable contract"
// guidance, this transcribes both verbatim and drives them with plain mock
// req objects, plus a source-level pin against the real file.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WEB_PATH = new URL('../bridge/web.mjs', import.meta.url);
const HUB_BRIDGE_PATH = new URL('../bridge/hub-bridge.mjs', import.meta.url);

const { fetchUrl } = await import(WEB_PATH);

// ── Part 1: real fetchUrl(), real SSRF guard, zero network calls ───────────

test('fetchUrl — blocks loopback / private / link-local / cloud-metadata IP literals', async () => {
  const blocked = [
    'http://127.0.0.1/',
    'http://127.0.0.1:8765/pair',
    'http://10.0.0.5/internal',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata endpoint
    'http://0.0.0.0/',
    'http://100.100.100.200/',                  // CGNAT / Alibaba metadata range
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[::ffff:127.0.0.1]/',                // v4-mapped loopback
  ];
  for (const url of blocked) {
    const r = await fetchUrl(url);
    assert.deepEqual(r, { ok: false, url, error: 'blocked' }, `expected blocked: ${url}`);
  }
});

test('fetchUrl — blocks the "localhost" hostname and any *.localhost subdomain', async () => {
  assert.deepEqual(await fetchUrl('http://localhost/'), { ok: false, url: 'http://localhost/', error: 'blocked' });
  assert.deepEqual(await fetchUrl('http://foo.localhost/'), { ok: false, url: 'http://foo.localhost/', error: 'blocked' });
});

test('fetchUrl — blocks non-http(s) schemes and unparsable URLs', async () => {
  assert.equal((await fetchUrl('ftp://example.com/')).error, 'blocked');
  assert.equal((await fetchUrl('file:///etc/passwd')).error, 'blocked');
  assert.equal((await fetchUrl('not a url at all')).error, 'blocked'); // fails URL parsing -> blocked, not invalid-url
});

test('fetchUrl — empty/non-string input is rejected as invalid-url BEFORE the SSRF guard runs', async () => {
  assert.deepEqual(await fetchUrl(''), { ok: false, url: '', error: 'invalid-url' });
  assert.deepEqual(await fetchUrl('   '), { ok: false, url: '   ', error: 'invalid-url' });
  assert.deepEqual(await fetchUrl(null), { ok: false, url: null, error: 'invalid-url' });
  assert.deepEqual(await fetchUrl(undefined), { ok: false, url: undefined, error: 'invalid-url' });
});

// ── Part 2: hub-bridge.mjs's authed() + localOnly(), transcribed verbatim ──

// authed() now does one thing — parse the Authorization header — and hands the value to
// Session._verify (bridge/session.mjs), which owns the constant-time compare AND the
// owner's lifetime policy. session.mjs IS safely importable, so the compare exercised
// below is the real one rather than a transcription.
function makeAuthed(verify) {
  // verbatim from hub-bridge.mjs authed()
  return function authed(req) {
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    return verify(bearer);
  };
}

function makeLocalOnly(PORT, CONTAINER = false) {
  // verbatim from hub-bridge.mjs localOnly() (incl. the opt-in container-mode branch)
  return function localOnly(req) {
    const host = (req.headers.host || '').toLowerCase();
    const okHost = host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}` || host === `[::1]:${PORT}`;
    if (CONTAINER) return okHost;
    const ra = req.socket.remoteAddress || '';
    const okAddr = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    return okHost && okAddr;
  };
}

// A throwaway hub root, set BEFORE the import so session.mjs mints its token there and
// this test can never touch the developer's real ~/.clone-frame-hub.
process.env.CLONE_FRAME_HUB_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-auth-'));
const { Session } = await import('../bridge/session.mjs');
const TOKEN = Session._token();
const authed = makeAuthed(Session._verify);
const localOnly = makeLocalOnly(8765);
const localOnlyContainer = makeLocalOnly(8765, true); // HUB_BRIDGE_CONTAINER=1

function reqWith({ authorization, tokenQuery, host, remoteAddress } = {}) {
  const qs = tokenQuery ? `?token=${encodeURIComponent(tokenQuery)}` : '';
  return {
    headers: { authorization: authorization || '', host: host ?? `127.0.0.1:8765` },
    url: `/shell${qs}`,
    socket: { remoteAddress: remoteAddress ?? '127.0.0.1' },
  };
}

test('authed() — accepts the exact token via Bearer header', () => {
  assert.equal(authed(reqWith({ authorization: `Bearer ${TOKEN}` })), true);
});

// REVERSED on 2026-07-26, deliberately. This used to assert that ?token= was accepted as
// an alternate carrier. Nothing in the app ever sent one — the client is Bearer-only — so
// all it did was make the secret legal in a place URLs get written down: shell history,
// access logs, the Referer of anything the page loads, a screenshot of the address bar.
test('authed() — REFUSES a token in the query string, even the correct one', () => {
  assert.equal(authed(reqWith({ tokenQuery: TOKEN })), false);
});

test('authed() — a correct query token cannot rescue a wrong Bearer header either', () => {
  assert.equal(authed(reqWith({ authorization: 'Bearer nope', tokenQuery: TOKEN })), false);
});

test('authed() — rejects a token of different length via the length fast-path (no char comparison needed)', () => {
  assert.equal(authed(reqWith({ authorization: 'Bearer short' })), false);
  assert.equal(authed(reqWith({ authorization: `Bearer ${TOKEN}EXTRA` })), false);
});

test('authed() — rejects a same-length token that differs by even a single character', () => {
  const almost = TOKEN.slice(0, -1) + (TOKEN.at(-1) === 'x' ? 'y' : 'x');
  assert.equal(authed(reqWith({ authorization: `Bearer ${almost}` })), false);
});

test('authed() — rejects when no token is supplied at all', () => {
  assert.equal(authed(reqWith({})), false);
});

test('authed() — a header without the "Bearer " prefix is not treated as a bearer token', () => {
  assert.equal(authed(reqWith({ authorization: TOKEN })), false); // missing "Bearer " prefix
});

test('localOnly() — accepts the loopback Host+socket combinations the daemon itself uses', () => {
  assert.equal(localOnly(reqWith({ host: '127.0.0.1:8765', remoteAddress: '127.0.0.1' })), true);
  assert.equal(localOnly(reqWith({ host: 'localhost:8765', remoteAddress: '127.0.0.1' })), true);
  assert.equal(localOnly(reqWith({ host: '[::1]:8765', remoteAddress: '::1' })), true);
  assert.equal(localOnly(reqWith({ host: '127.0.0.1:8765', remoteAddress: '::ffff:127.0.0.1' })), true);
});

test('localOnly() — rejects a mismatched Host header even from a loopback socket (anti DNS-rebinding)', () => {
  assert.equal(localOnly(reqWith({ host: 'evil.example.com:8765', remoteAddress: '127.0.0.1' })), false);
  assert.equal(localOnly(reqWith({ host: '127.0.0.1:9999', remoteAddress: '127.0.0.1' })), false); // wrong port
});

test('localOnly() — rejects a correct Host header from a non-loopback remote socket', () => {
  assert.equal(localOnly(reqWith({ host: '127.0.0.1:8765', remoteAddress: '10.0.0.7' })), false);
});

// ── container mode (HUB_BRIDGE_CONTAINER=1) — see hub-bridge.mjs localOnly() ──
test('localOnly() — CONTAINER mode accepts a correct Host from the container gateway (non-loopback socket)', () => {
  // In a container the client's packets arrive via the gateway (e.g. 172.17.0.1); the netns + the
  // host-loopback-only publish is the boundary, so a correct loopback Host header is sufficient.
  assert.equal(localOnlyContainer(reqWith({ host: '127.0.0.1:8765', remoteAddress: '172.17.0.1' })), true);
  assert.equal(localOnlyContainer(reqWith({ host: 'localhost:8765', remoteAddress: '172.17.0.1' })), true);
});

test('localOnly() — CONTAINER mode STILL rejects a mismatched Host (anti DNS-rebinding preserved)', () => {
  assert.equal(localOnlyContainer(reqWith({ host: 'evil.example.com:8765', remoteAddress: '172.17.0.1' })), false);
  assert.equal(localOnlyContainer(reqWith({ host: '127.0.0.1:9999', remoteAddress: '172.17.0.1' })), false); // wrong port
});

test('localOnly() — DEFAULT (no container env) is unchanged: a non-loopback socket is still refused', () => {
  assert.equal(localOnly(reqWith({ host: '127.0.0.1:8765', remoteAddress: '172.17.0.1' })), false);
});

// ── source-level pins ───────────────────────────────────────────────────────
test('hub-bridge.mjs source still carries the transcribed authed()/localOnly() logic', () => {
  const src = fs.readFileSync(HUB_BRIDGE_PATH, 'utf8');
  assert.match(src, /HOST = process\.env\.HUB_BRIDGE_HOST \|\| '127\.0\.0\.1'/);
  assert.match(src, /CONTAINER = process\.env\.HUB_BRIDGE_CONTAINER === '1'/);
  assert.match(src, /if \(CONTAINER\) return okHost;/);
  // The compare lives in session.mjs now; hub-bridge only parses the header. Pin BOTH:
  // that it delegates, and that it never reads a token out of the URL again.
  assert.match(src, /return Session\._verify\(bearer\)/);
  assert.doesNotMatch(src, /searchParams\.get\('token'\)/, 'the query-string token carrier must stay gone');
  const sess = fs.readFileSync(new URL('../bridge/session.mjs', import.meta.url), 'utf8');
  // The compare now lives in one shared helper, because it judges the primary token AND
  // every additional key the owner issued — all of them constant-time, or none.
  assert.match(sess, /a\.length !== b\.length/);
  assert.match(sess, /d \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\)/);
  assert.doesNotMatch(sess, /tok === |=== cur\b/, 'no short-circuit === on a secret');
  assert.match(src, /okHost = host === `127\.0\.0\.1:\$\{PORT\}`/);
  assert.match(src, /okAddr = ra === '127\.0\.0\.1' \|\| ra === '::1' \|\| ra === '::ffff:127\.0\.0\.1'/);
});

test('web.mjs source still carries the private-range table this test characterizes', () => {
  const src = fs.readFileSync(WEB_PATH, 'utf8');
  assert.match(src, /a === 127 \|\| a === 10 \|\| a === 0/);
  assert.match(src, /a === 169 && b === 254/); // link-local / cloud metadata
  assert.match(src, /host === 'localhost' \|\| host\.endsWith\('\.localhost'\)/);
});

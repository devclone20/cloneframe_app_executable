// The pairing token's lifetime (bridge/session.mjs).
//
// The first test is the one that matters most: CLONE FRAME ships a PERMANENT token, and
// an install that never opens this screen must never be logged out. Everything after it
// only happens because someone chose it in Settings → Session.
//
// Scope, so nothing here is mistaken for more than it is: a token is not a login. A
// process running as the owner reads ~/.clone-frame-hub/bridge.token directly and always
// could. What these tests pin is that a token with a lifetime actually stops working when
// that lifetime passes, that it is replaced rather than merely refused, and that no
// unauthenticated caller can trigger any of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A fresh root AND a fresh module instance per test: session.mjs caches the token and the
// mint time in module memory, so two tests sharing one instance would not be independent.
async function freshSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-session-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/session.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, S: mod.Session };
}

// Run fn with Date.now() pushed `ms` into the future. Restored even if fn throws.
function atFuture(ms, fn) {
  const real = Date.now;
  Date.now = () => real() + ms;
  try { return fn(); } finally { Date.now = real; }
}

test('ships PERMANENT — an unconfigured install is never logged out', async () => {
  const { S } = await freshSession();
  const p = S.get();
  assert.equal(p.mode, 'permanent');
  assert.equal(p.expiresAt, null, 'permanent means there is no expiry instant at all');
  assert.equal(p.remainingMs, null);
  const tok = S._token();
  // a century later, still valid
  atFuture(100 * 365 * 86400_000, () => {
    assert.equal(S._verify(tok), true, 'a permanent token must survive any amount of time');
  });
});

test('the token is written owner-only, into the hub root, and is stable across calls', async () => {
  const { root, S } = await freshSession();
  const tok = S._token();
  assert.equal(S._token(), tok, 'reading it twice must not mint twice');
  const f = path.join(root, 'bridge.token');
  assert.equal(fs.readFileSync(f, 'utf8').trim(), tok);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'the secret must not be readable by anyone else');
  assert.ok(tok.length >= 32);
});

test('an expiring token is refused once its lifetime passes — AND retired on the spot', async () => {
  const { S } = await freshSession();
  const tok = S._token();
  S.set({ mode: 'expiring', hours: 1 });
  assert.equal(S._verify(tok), true, 'still inside the hour');
  atFuture(2 * 3600_000, () => {
    assert.equal(S._verify(tok), false, 'past the hour it must be refused');
  });
  // The point of the mechanism: the refused secret is DEAD, not merely late. Even with the
  // clock back to normal, the old token never works again.
  assert.equal(S._verify(tok), false, 'an expired token must not come back to life');
  assert.notEqual(S._token(), tok, 'expiry must MINT a replacement, not just say no');
});

test('the replacement token works immediately — expiry is not a lockout loop', async () => {
  const { S } = await freshSession();
  const old = S._token();
  S.set({ mode: 'expiring', hours: 1 });
  atFuture(2 * 3600_000, () => S._verify(old));
  const fresh = S._token();
  assert.equal(S._verify(fresh), true, 'the new token must be usable at once');
  assert.equal(S.get().remainingMs > 0, true, 'and its clock must have restarted');
});

test('a WRONG token never triggers rotation — otherwise any local process could log the owner out', async () => {
  const { S } = await freshSession();
  const tok = S._token();
  S.set({ mode: 'expiring', hours: 1 });
  atFuture(2 * 3600_000, () => {
    assert.equal(S._verify('not-even-close'), false);
    assert.equal(S._verify('x'.repeat(tok.length)), false, 'same length, wrong bytes');
  });
  assert.equal(S._token(), tok, 'the secret must be untouched — only a CORRECT expired token retires it');
});

test('rotate() replaces the secret and kills the old one', async () => {
  const { S } = await freshSession();
  const old = S._token();
  const r = S.rotate();
  assert.equal(r.ok, true);
  assert.notEqual(r.token, old);
  assert.equal(S._verify(old), false, 'the old token must stop working immediately');
  assert.equal(S._verify(r.token), true, 'and the caller must be handed one that works');
});

test('get() never carries the secret — only rotate() returns it, to a caller that already had one', async () => {
  const { S } = await freshSession();
  const tok = S._token();
  const shown = JSON.stringify(S.get());
  assert.ok(!shown.includes(tok), 'the status projection must never contain the token');
  assert.ok(!('token' in S.get()));
});

test('setting a lifetime restarts the clock — enabling a limit must not expire you instantly', async () => {
  const { S } = await freshSession();
  const tok = S._token();
  // pretend the token has been in use for a long time before the owner picks 1 hour
  const r = atFuture(90 * 86400_000, () => S.set({ mode: 'expiring', hours: 1 }));
  assert.equal(r.mode, 'expiring');
  assert.equal(S._verify(tok), true, 'the token in the owner\'s hand keeps working');
});

test('hours are clamped to something a human can live with, and junk is refused', async () => {
  const { S } = await freshSession();
  assert.equal(S.set({ mode: 'expiring', hours: 0.001 }).hours, 0.25, 'nothing below 15 minutes');
  assert.equal(S.set({ hours: 999999 }).hours, 8760, 'nothing beyond a year — that is "permanent"');
  assert.equal(S.set({ hours: 'soon' }).ok, false);
});

test('an unrecognised mode leaves the policy alone — a typo must never remove a limit', async () => {
  const { S } = await freshSession();
  S.set({ mode: 'expiring', hours: 2 });
  S.set({ mode: 'whenever' });
  assert.equal(S.get().mode, 'expiring');
});

test('the policy survives a reload — it is the owner\'s config, not session state', async () => {
  const { root, S } = await freshSession();
  S.set({ mode: 'expiring', hours: 3 });
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const again = (await import('../bridge/session.mjs?ctx=' + Math.random().toString(36).slice(2))).Session;
  assert.equal(again.get().mode, 'expiring');
  assert.equal(again.get().hours, 3);
});

test('the secret-bearing functions are unreachable over RPC', async () => {
  // POST /mod/<name> refuses any fn whose name starts with "_" (hub-bridge handleMod).
  // That is the ONLY thing keeping _token() — which returns the raw secret — off the wire,
  // so the naming is load-bearing, not a style choice.
  const { S } = await freshSession();
  const rpcReachable = Object.keys(S).filter((k) => k[0] !== '_');
  assert.deepEqual(rpcReachable.sort(), ['get', 'issue', 'keys', 'revoke', 'rotate', 'set']);
  // rotate() and issue() DO return a secret — deliberately, and only to a caller that had to
  // present a valid one to reach the route at all. Nothing else may.
  for (const fn of ['get', 'keys']) {
    assert.ok(!JSON.stringify(S[fn]()).includes(S._token()), `${fn}() must never carry a token`);
  }
  for (const k of ['_token', '_verify', '_expired']) {
    assert.equal(typeof S[k], 'function', `${k} must stay server-only, not disappear`);
  }
});

test('an existing install upgrades without losing its token', async () => {
  // A hub root that already has a bridge.token but no session.json — every install before
  // this module existed. It must adopt that token, not mint a new one and unpair the owner.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-session-old-'));
  const existing = 'an_existing_token_of_more_than_32_chars';
  fs.writeFileSync(path.join(root, 'bridge.token'), existing, { mode: 0o600 });
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const S = (await import('../bridge/session.mjs?ctx=' + Math.random().toString(36).slice(2))).Session;
  assert.equal(S._token(), existing);
  assert.equal(S._verify(existing), true);
  assert.equal(S.get().mode, 'permanent', 'and it stays permanent until the owner says otherwise');
});

// ── additional named keys (Settings → Users) ─────────────────────────────────
// These are KEYS, not accounts. The bridge runs as the owner, so every key that opens it
// gets the owner's shell. The tests below pin the mechanics; the UI pins the honesty.

test('a fresh install has no extra keys at all', async () => {
  const { S } = await freshSession();
  assert.deepEqual(S.keys(), { ok: true, keys: [] });
});

test('an issued key opens the bridge, and its secret is returned exactly once', async () => {
  const { S } = await freshSession();
  const r = S.issue({ name: 'second window' });
  assert.equal(r.ok, true);
  assert.ok(r.token && r.token.length >= 32);
  assert.equal(S._verify(r.token), true, 'the key must actually work');
  // …and it is never handed out again
  const listed = S.keys().keys;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'second window');
  assert.ok(!JSON.stringify(listed).includes(r.token), 'keys() must not echo the secret back');
});

test('revoking a key kills it immediately, and leaves the others alone', async () => {
  const { S } = await freshSession();
  const a = S.issue({ name: 'a' }), b = S.issue({ name: 'b' });
  assert.equal(S.revoke(a.id).ok, true);
  assert.equal(S._verify(a.token), false, 'the revoked key must stop working at once');
  assert.equal(S._verify(b.token), true, 'the other key is untouched');
  assert.equal(S.keys().keys.length, 1);
  assert.equal(S.revoke(a.id).ok, false, 'revoking twice is not a silent success');
});

test('an expiring key dies on its own clock — and DELETES itself rather than lingering', async () => {
  const { S } = await freshSession();
  const k = S.issue({ name: 'temporary', mode: 'expiring', hours: 1 });
  assert.equal(S._verify(k.token), true);
  atFuture(2 * 3600_000, () => {
    assert.equal(S._verify(k.token), false, 'past its hour it must be refused');
  });
  assert.deepEqual(S.keys().keys, [], 'and it must be gone, not sitting there expired');
});

test('a key never becomes the primary token, and rotating the primary leaves keys valid', async () => {
  const { S } = await freshSession();
  const k = S.issue({ name: 'automation' });
  const primary = S._token();
  assert.notEqual(k.token, primary);
  const r = S.rotate();
  assert.equal(S._verify(primary), false, 'the old primary is dead');
  assert.equal(S._verify(r.token), true);
  assert.equal(S._verify(k.token), true, 'an unrelated key must survive a primary rotation');
});

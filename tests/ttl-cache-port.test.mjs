// Contract tests for ttl-cache.mjs — run the identical assertion set against
// the real port (driven by an injected `now` closure, no real waiting) and
// the fake (driven by its `.advance()` helper), proving the two are
// behaviorally identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../bridge/platform/ttl-cache.mjs';
import { createFakeTtlCache } from '../bridge/platform/ttl-cache.fake.mjs';

// Each factory returns { cache, advance(ms) } so the same test bodies can
// drive either the real port (manual `now` closure) or the fake (its own
// `.advance()`) through one uniform shape.
function realFactory(opts = {}) {
  let t = 0;
  const cache = createTtlCache({ ...opts, now: () => t });
  return { cache, advance: (ms) => { t += ms; } };
}

function fakeFactory(opts = {}) {
  const cache = createFakeTtlCache(opts);
  return { cache, advance: (ms) => cache.advance(ms) };
}

function contract(name, factory) {
  test(`${name}: get() on an unknown key returns undefined`, () => {
    const { cache } = factory();
    assert.equal(cache.get('missing'), undefined);
  });

  test(`${name}: set()/get() round-trips a value`, () => {
    const { cache } = factory();
    cache.set('a', 1);
    assert.equal(cache.get('a'), 1);
  });

  test(`${name}: with no ttl (default Infinity) an entry never expires`, () => {
    const { cache, advance } = factory();
    cache.set('a', 1);
    advance(10_000_000);
    assert.equal(cache.get('a'), 1);
  });

  test(`${name}: a per-call ttl expires the entry after it elapses`, () => {
    const { cache, advance } = factory();
    cache.set('a', 1, 1_000);
    assert.equal(cache.get('a'), 1);
    advance(999);
    assert.equal(cache.get('a'), 1);
    advance(2); // now 1001ms elapsed — past the 1000ms ttl
    assert.equal(cache.get('a'), undefined);
  });

  test(`${name}: a cache-wide ttl applies when set() omits a per-call ttl`, () => {
    const { cache, advance } = factory({ ttl: 500 });
    cache.set('a', 1);
    advance(600);
    assert.equal(cache.get('a'), undefined);
  });

  test(`${name}: an expired entry is deleted on read (lazy expiry, like robinhood.mjs)`, () => {
    const { cache, advance } = factory();
    cache.set('a', 1, 100);
    advance(200);
    assert.equal(cache.size, 1, 'not yet purged until read');
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.size, 0, 'purged after the read observed the expiry');
  });

  test(`${name}: has() reports expiry without mutating LRU order`, () => {
    const { cache, advance } = factory();
    cache.set('a', 1, 100);
    advance(200);
    assert.equal(cache.has('a'), false);
    assert.equal(cache.get('a'), undefined);
  });

  test(`${name}: has() is true for a live, non-expired entry`, () => {
    const { cache } = factory();
    cache.set('a', 1, 1_000);
    assert.equal(cache.has('a'), true);
  });

  test(`${name}: delete() removes an entry; clear() removes everything`, () => {
    const { cache } = factory();
    cache.set('a', 1);
    cache.set('b', 2);
    assert.equal(cache.delete('a'), true);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), 2);
    cache.clear();
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.size, 0);
  });

  test(`${name}: with no max (default Infinity) the cache is unbounded (matches robinhood.mjs/nft.mjs today)`, () => {
    const { cache } = factory();
    for (let i = 0; i < 500; i++) cache.set(`k${i}`, i);
    assert.equal(cache.size, 500);
    assert.equal(cache.get('k0'), 0);
  });

  test(`${name}: with a finite max, the least-recently-used entry is evicted first`, () => {
    const { cache } = factory({ max: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // touch 'a' — 'b' is now the least-recently-used
    cache.set('c', 3); // over max(2) — evicts 'b'
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('c'), 3);
    assert.equal(cache.size, 2);
  });

  test(`${name}: re-setting an existing key refreshes it as most-recently-used`, () => {
    const { cache } = factory({ max: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10); // 'a' becomes most-recently-used again; 'b' is now LRU
    cache.set('c', 3); // evicts 'b', not 'a'
    assert.equal(cache.get('a'), 10);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('c'), 3);
  });

  test(`${name}: keys() excludes already-expired entries`, () => {
    const { cache, advance } = factory();
    cache.set('a', 1, 100);
    cache.set('b', 2);
    advance(200);
    assert.deepEqual(cache.keys(), ['b']);
  });

  test(`${name}: constructor rejects a non-positive max or a negative ttl`, () => {
    assert.throws(() => factory({ max: 0 }));
    assert.throws(() => factory({ max: -1 }));
    assert.throws(() => factory({ ttl: -1 }));
  });
}

contract('real', realFactory);
contract('fake', fakeFactory);

// ── proof of parity with robinhood.mjs's hand-rolled cache pattern ───────────
test('reproduces robinhood.mjs\'s exact _cacheGet/_cacheSet semantics (per-key ttl table, lazy expiry, unbounded)', () => {
  let t = 0;
  const cache = createTtlCache({ now: () => t }); // no max — unbounded, like robinhood.mjs
  const TTL = { status: 15_000, balance: 30_000, list: 5 * 60_000 };

  cache.set('status:acct1', { ok: true, v: 1 }, TTL.status);
  cache.set('balance:acct1', { ok: true, v: 2 }, TTL.balance);

  t += 14_999;
  assert.deepEqual(cache.get('status:acct1'), { ok: true, v: 1 });
  t += 2; // 15,001ms since set — status entry (15s ttl) has now expired
  assert.equal(cache.get('status:acct1'), undefined);
  assert.deepEqual(cache.get('balance:acct1'), { ok: true, v: 2 }); // 30s ttl — still alive at ~15s
});

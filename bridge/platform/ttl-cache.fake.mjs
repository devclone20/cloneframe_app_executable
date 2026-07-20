// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Platform / TTL Cache — FAKE
//
// The real port already takes an injectable `now` for testability, so the fake
// is a thin, deterministic wrapper around the SAME core (no duplicated
// eviction/expiry logic to drift out of sync) that swaps `Date.now` for a
// manual clock a test can advance explicitly — no `setTimeout`/real waiting
// required to prove TTL expiry or LRU eviction. tests/ttl-cache.test.mjs runs
// the identical contract against both `createTtlCache` (driven by an
// injected `now` closure) and this fake (driven by `.advance()`), proving the
// two are behaviorally identical.
// ─────────────────────────────────────────────────────────────────────────────
import { createTtlCache } from './ttl-cache.mjs';

export function createFakeTtlCache({ startAt = 0, ...opts } = {}) {
  let t = Number(startAt) || 0;
  const now = () => t;
  const cache = createTtlCache({ ...opts, now });

  return {
    get: cache.get,
    set: cache.set,
    has: cache.has,
    delete: cache.delete,
    clear: cache.clear,
    keys: cache.keys,
    get size() {
      return cache.size;
    },
    // Test-only clock control — not part of the real port's surface.
    advance(ms) {
      t += Math.max(0, Number(ms) || 0);
      return t;
    },
    setTime(ms) {
      t = Number(ms) || 0;
      return t;
    },
    now() {
      return t;
    },
  };
}

export default createFakeTtlCache;

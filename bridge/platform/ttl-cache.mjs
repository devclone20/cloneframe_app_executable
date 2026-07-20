// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Platform / TTL Cache
//
// Generalizes the hand-rolled in-memory caches living today in:
//   - robinhood.mjs — a bare `Map` keyed by an ad-hoc string, with a per-call
//     TTL drawn from a `TTL = {status,balance,list}` table, checked lazily on
//     `_cacheGet` (expired entries are deleted on read, never proactively
//     swept) and written via `_cacheSet(key, val, ttlMs)`. Unbounded — no
//     max-size eviction.
//   - nft.mjs — a similar TTL-gated cache, but persisted to disk as part of
//     the module's JSON store (`store.cache` / `store.soulCache`) rather than
//     held only in memory; each read compares `Date.now() - hit.fetchedAt`
//     against a constant TTL inline rather than through a shared helper.
//     Because it is disk-persisted (survives a process restart) it is an
//     architecturally different cache from this in-memory utility — this
//     port targets robinhood.mjs's pattern directly; nft.mjs's on-disk cache
//     is a candidate for a *separate* persisted-cache port, not this one.
//
// createTtlCache({max, ttl}) returns an object with the same essential shape
// as robinhood.mjs's private cache (get/set with a lazy-expire-on-read) plus
// two capabilities neither hand-rolled copy has today (a superset, so nothing
// that adopts this port loses behavior):
//   - `max` — optional LRU eviction once the entry count exceeds `max`
//     (default Infinity, i.e. unbounded — matches both existing caches).
//   - `has()` / `delete()` / `clear()` / `keys()` / `.size` — read/lifecycle
//     operations neither existing cache exposes today, added for composability.
//
// Zero npm dependencies — Node built-ins only. The clock is injectable
// (`now`, defaulting to `Date.now`) purely so tests can drive it without
// real timers; production callers never need to pass it.
// ─────────────────────────────────────────────────────────────────────────────

export function createTtlCache({ max = Infinity, ttl = Infinity, now = Date.now } = {}) {
  if (!(max === Infinity || (Number.isFinite(max) && max > 0))) {
    throw new RangeError('createTtlCache: max must be a positive number or Infinity');
  }
  if (!(ttl === Infinity || (Number.isFinite(ttl) && ttl >= 0))) {
    throw new RangeError('createTtlCache: ttl must be a non-negative number or Infinity');
  }

  // Map iteration order is insertion order, which we maintain as LRU order:
  // any read/write moves the key to the end ("most recently used").
  const store = new Map(); // key -> { val, exp }

  function isExpired(entry, t) {
    return entry.exp !== Infinity && t > entry.exp;
  }

  function evictIfNeeded() {
    if (max === Infinity) return;
    while (store.size > max) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
    }
  }

  // Lazy-expire-on-read, same as robinhood.mjs's `_cacheGet`: an expired
  // entry is deleted the moment it is observed, never proactively swept.
  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (isExpired(entry, now())) {
      store.delete(key);
      return undefined;
    }
    store.delete(key);
    store.set(key, entry); // bump to most-recently-used
    return entry.val;
  }

  // Same lazy-expiry rule as get(), without touching LRU order or returning
  // the value — a pure existence check.
  function has(key) {
    const entry = store.get(key);
    if (!entry) return false;
    if (isExpired(entry, now())) {
      store.delete(key);
      return false;
    }
    return true;
  }

  // `ttlMs` defaults to the cache-wide `ttl`; robinhood.mjs's per-call
  // override (`_cacheSet(key, val, TTL.status)` vs `TTL.balance`) is
  // reproduced by passing a different `ttlMs` per call.
  function set(key, val, ttlMs = ttl) {
    const t = now();
    const ms = ttlMs === Infinity ? Infinity : Math.max(0, Number(ttlMs) || 0);
    const exp = ms === Infinity ? Infinity : t + ms;
    if (store.has(key)) store.delete(key); // drop first so re-insertion moves it to the end
    store.set(key, { val, exp });
    evictIfNeeded();
    return val;
  }

  function del(key) {
    return store.delete(key);
  }

  function clear() {
    store.clear();
  }

  // Non-expired keys, oldest (least-recently-used) first. Does not mutate.
  function keys() {
    const t = now();
    return Array.from(store.entries())
      .filter(([, entry]) => !isExpired(entry, t))
      .map(([k]) => k);
  }

  return {
    get,
    set,
    has,
    delete: del,
    clear,
    keys,
    // Raw entry count, INCLUDING any already-expired-but-not-yet-read entry
    // (expiry is lazy, exactly like robinhood.mjs — nothing proactively
    // sweeps). Call keys() (or get/has on a specific key) to force expiry.
    get size() {
      return store.size;
    },
  };
}

export const TtlCache = { createTtlCache };
export default TtlCache;

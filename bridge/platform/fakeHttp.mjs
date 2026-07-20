// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — platform/fakeHttp
//
// In-memory test double for platform/http.mjs. Serves CANNED responses keyed
// by url instead of doing real network I/O, so callers of the http.mjs
// contract (nft.mjs/virtuals.mjs/robinhood.mjs/models.mjs, once migrated) can
// be unit-tested with zero egress. Implements the identical exported surface
// — `fetchJson(url, options) -> Result` and `describeFetchError(err)` — so a
// test can `import { Http } from './http.mjs'` in production code and swap in
// `{ Http as FakeHttp } from './fakeHttp.mjs'` with no call-site change.
//
// `describeFetchError` is re-exported verbatim from http.mjs rather than
// reimplemented: it is a pure string classifier with no I/O, so importing the
// real one carries none of the risk a fake normally guards against (network
// calls, filesystem, timing) and guarantees the two modules can never drift
// on error-message wording.
//
// Seeding API (test-only, not part of the shared contract):
//   seed(url, entry)         — push one canned entry onto url's response queue
//   seedSequence(url, [...]) — replace url's queue wholesale (for retry tests:
//                              first N entries fail, the last one succeeds)
//   reset()                  — clear all seeded state + call counters
//   callCount(url)           — how many times fetchJson attempted this url
//                              (counts EVERY attempt, including retries)
//
// entry shapes:
//   { status?: 200, body?: any }   — a response; body is JSON.stringify'd
//                                     unless already a string
//   { throws: someError }          — fetch() itself throws (network/timeout);
//                                     give it a real Error (see http.mjs's
//                                     describeFetchError for what it inspects:
//                                     .name / .cause.code / .message)
//
// A url's queue with more than one entry is consumed FIFO across repeated
// fetchJson calls (models a flaky endpoint recovering); a queue with exactly
// one entry is never consumed — every call replays it (models a stable
// canned response reused across many calls in one test).
// ─────────────────────────────────────────────────────────────────────────────
import { describeFetchError } from './http.mjs';

const registry = new Map(); // url -> entry[]
const callCounts = new Map(); // url -> number

export function seed(url, entry) {
  const q = registry.get(url) || [];
  q.push(entry);
  registry.set(url, q);
}

export function seedSequence(url, entries) {
  registry.set(url, [...entries]);
}

export function reset() {
  registry.clear();
  callCounts.clear();
}

export function callCount(url) {
  return callCounts.get(url) || 0;
}

function nextEntry(url) {
  const q = registry.get(url);
  if (!q || !q.length) return undefined;
  return q.length > 1 ? q.shift() : q[0];
}

export async function fetchJson(url, options = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, error: 'invalid-url' };
  }
  const { retries = 0 } = options;
  const maxAttempts = Math.max(0, Number(retries) || 0) + 1;

  if (!registry.has(url) || !(registry.get(url) || []).length) {
    return { ok: false, error: `fakeHttp: no canned response seeded for ${url}` };
  }

  let lastNetworkError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    callCounts.set(url, (callCounts.get(url) || 0) + 1);
    const entry = nextEntry(url);

    if (entry && entry.throws) {
      lastNetworkError = entry.throws;
      if (attempt < maxAttempts - 1) continue; // retry: network/abort/timeout only
      return { ok: false, error: describeFetchError(entry.throws) };
    }

    const status = entry && entry.status !== undefined ? entry.status : 200;
    const ok = status >= 200 && status < 300;
    const rawBody = entry ? entry.body : undefined;
    const bodyText = rawBody === undefined ? '' : (typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));

    if (!ok) {
      let data = null;
      if (bodyText) {
        try { data = JSON.parse(bodyText); } catch { data = bodyText; }
      }
      return { ok: false, status, error: describeFetchError({ status, ok: false }), data };
    }

    if (!bodyText) return { ok: true, status, data: null };
    try {
      return { ok: true, status, data: JSON.parse(bodyText) };
    } catch {
      return { ok: false, status, error: 'invalid-json', data: null };
    }
  }
  return { ok: false, error: lastNetworkError ? describeFetchError(lastNetworkError) : 'unreachable' };
}

export { describeFetchError };
export const FakeHttp = { fetchJson, describeFetchError, seed, seedSequence, reset, callCount };
export default FakeHttp;

// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Platform / Redaction Utilities — FAKE
//
// Like text.fake.mjs, redact.mjs is pure — the fake delegates to the real
// implementation (so its output is always identical, proven by
// tests/redact.test.mjs running the same contract against both) while adding
// two test-only capabilities:
//   - `extraSecretKeys` — a caller can register additional key names it wants
//     treated as secret for its own test scenarios, without ever touching (or
//     weakening) the real, security-critical SECRET_KEYS set.
//   - `_calls` — recorded invocations, for asserting "sanitize() was called
//     before this object left the module" in a caller's own tests.
// ─────────────────────────────────────────────────────────────────────────────
import * as Real from './redact.mjs';

export function createFakeRedact({ extraSecretKeys = [] } = {}) {
  const calls = { sanitize: [], hasSecret: [], scrubText: [] };

  return {
    SECRET_KEYS: Real.SECRET_KEYS,
    isSecretKey(key) {
      return Real.isSecretKey(key, extraSecretKeys);
    },
    sanitize(value, opts = {}) {
      calls.sanitize.push([value, opts]);
      return Real.sanitize(value, { ...opts, extraKeys: [...(opts.extraKeys || []), ...extraSecretKeys] });
    },
    hasSecret(str) {
      calls.hasSecret.push([str]);
      return Real.hasSecret(str);
    },
    scrubText(str, opts) {
      calls.scrubText.push([str, opts]);
      return Real.scrubText(str, opts);
    },
    // Test-only introspection — not part of the real port's surface.
    _calls: calls,
    _reset() {
      calls.sanitize.length = 0;
      calls.hasSecret.length = 0;
      calls.scrubText.length = 0;
    },
  };
}

export default createFakeRedact;

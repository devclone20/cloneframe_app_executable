// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Platform / Text Utilities — FAKE
//
// text.mjs is pure (no fs, no timers, no randomness), so there is no state or
// I/O to fake. This fake is a recording spy: it delegates every call to the
// real implementation (so its OUTPUT is always identical to the real port —
// proven by tests/text.test.mjs running the same contract against both) while
// also recording call arguments, so a caller writing its own unit tests can
// assert "snippet() was called with this text" without depending on the real
// module's internals or duplicating its logic (and risking drift).
// ─────────────────────────────────────────────────────────────────────────────
import * as Real from './text.mjs';

export function createFakeText() {
  const calls = { snippet: [], normalizeTags: [], parseInstant: [], toMillis: [] };

  return {
    snippet(...args) {
      calls.snippet.push(args);
      return Real.snippet(...args);
    },
    normalizeTags(...args) {
      calls.normalizeTags.push(args);
      return Real.normalizeTags(...args);
    },
    parseInstant(...args) {
      calls.parseInstant.push(args);
      return Real.parseInstant(...args);
    },
    toMillis(...args) {
      calls.toMillis.push(args);
      return Real.toMillis(...args);
    },
    DEFAULTS: Real.DEFAULTS,
    // Test-only introspection — not part of the real port's surface.
    _calls: calls,
    _reset() {
      calls.snippet.length = 0;
      calls.normalizeTags.length = 0;
      calls.parseInstant.length = 0;
      calls.toMillis.length = 0;
    },
  };
}

export default createFakeText;

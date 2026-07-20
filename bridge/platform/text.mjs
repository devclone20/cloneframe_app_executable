// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Platform / Text Utilities
//
// Shared text-normalization primitives factored out of the hand-rolled copies
// living today in reminders.mjs, scheduled.mjs, and library.mjs:
//   - snippet(s, n)        ← library.mjs `makeSnippet`
//   - normalizeTags(tags)  ← library.mjs `normalizeTags`
//   - parseInstant(v)      ← reminders.mjs AND scheduled.mjs `parseInstant`
//                             (byte-identical logic in both; the only
//                             difference is the field name baked into the
//                             error string — `remindAt` vs `sendAt` — which
//                             this port takes as an explicit `field` option
//                             so it is a drop-in superset of both)
//   - toMillis(v, fallback)← reminders.mjs AND scheduled.mjs `toMillis`
//                             (byte-identical in both, no field name involved)
//
// Zero npm dependencies — Node built-ins only. Every function is pure (no fs,
// no timers, no randomness): given the same input they always return the
// same output, so there is nothing to mock and no hidden state to reset
// between calls. Nothing here throws — malformed input is coerced or
// reported via a returned {ok:false, error} shape, never an exception.
//
// EXPAND-ONLY / Wave-2 draft: this module does not yet replace the copies in
// reminders.mjs / scheduled.mjs / library.mjs. It is behavior-compatible with
// all three so a later migration is a mechanical import swap, not a rewrite.
// See ./tests/text.test.mjs for the contract that proves it.
// ─────────────────────────────────────────────────────────────────────────────

// ── defaults (match the constants hard-coded in the existing copies) ─────────
export const DEFAULTS = Object.freeze({
  SNIPPET_LEN: 200,   // library.mjs SNIPPET_LEN
  MAX_TAGS: 50,       // library.mjs MAX_TAGS
  MAX_TAG_LEN: 64,    // library.mjs MAX_TAG_LEN
});

function asString(v) {
  return typeof v === 'string' ? v : String(v ?? '');
}

// ── snippet ───────────────────────────────────────────────────────────────────
// Collapse all whitespace runs to a single space, trim, and truncate to `n`
// chars with a trailing ellipsis when the flattened text overflows. Matches
// library.mjs `makeSnippet` exactly when called with the default length.
// Never throws; nullish/empty input yields ''.
export function snippet(s, n = DEFAULTS.SNIPPET_LEN) {
  if (!s) return '';
  const flat = asString(s).replace(/\s+/g, ' ').trim();
  const len = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULTS.SNIPPET_LEN;
  return flat.length > len ? `${flat.slice(0, len).trimEnd()}…` : flat;
}

// ── normalizeTags ─────────────────────────────────────────────────────────────
// Accepts an array of tags or a comma-joined string. Each tag is trimmed and
// capped at `maxLen` chars; duplicates are removed case-insensitively, keeping
// the first-seen casing; the result is capped at `maxTags` entries. Any other
// input type (number, null, object, …) yields []. Matches library.mjs
// `normalizeTags` exactly with the default options.
export function normalizeTags(tags, { maxTags = DEFAULTS.MAX_TAGS, maxLen = DEFAULTS.MAX_TAG_LEN } = {}) {
  let arr;
  if (Array.isArray(tags)) arr = tags;
  else if (typeof tags === 'string') arr = tags.split(',');
  else return [];

  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const tag = asString(raw).trim().slice(0, maxLen);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= maxTags) break;
  }
  return out;
}

// ── parseInstant ──────────────────────────────────────────────────────────────
// Normalize a user-supplied instant into a canonical UTC ISO string. Accepts
// an ISO/RFC-2822 string, a bare `YYYY-MM-DD` (→ UTC midnight), or an
// epoch-ms number. Returns {ok:true, iso} or {ok:false, error}. Never throws.
//
// `field` (default 'value') is spliced into the error message exactly the way
// reminders.mjs and scheduled.mjs each hard-code their own field name — pass
// `{field:'remindAt'}` or `{field:'sendAt'}` to reproduce either wording
// verbatim; see tests/text.test.mjs for the side-by-side proof.
export function parseInstant(v, { field = 'value' } = {}) {
  if (v == null || v === '') return { ok: false, error: `${field} is required` };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { ok: false, error: `${field} is not a finite timestamp` };
    const d = new Date(v);
    return Number.isNaN(d.getTime())
      ? { ok: false, error: `${field} is not a valid timestamp` }
      : { ok: true, iso: d.toISOString() };
  }
  if (typeof v === 'string') {
    const t = Date.parse(v.trim());
    return Number.isNaN(t)
      ? { ok: false, error: `${field} is not a parseable date/time` }
      : { ok: true, iso: new Date(t).toISOString() };
  }
  return { ok: false, error: `${field} must be an ISO string or epoch-ms number` };
}

// ── toMillis ──────────────────────────────────────────────────────────────────
// A tolerant instant → epoch-ms for reads (`now`, comparisons). Bad input
// yields `fallback` (default NaN) so callers can decide what to do; this
// never throws. Byte-identical logic to reminders.mjs / scheduled.mjs
// `toMillis` (which take no `field` — there is no error message to name).
export function toMillis(v, fallback = NaN) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  const t = Date.parse(asString(v).trim());
  return Number.isNaN(t) ? fallback : t;
}

export const Text = { snippet, normalizeTags, parseInstant, toMillis, DEFAULTS };
export default Text;

// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Platform / Redaction Utilities
//
// Shared secret-hygiene primitives factored out of the hand-rolled maskers
// living today in:
//   - integrations.mjs — `SECRET_KEYS = new Set(['password','apiKey','token',
//     'pass','secret'])` + `hasAuthConfigured()`, used to strip credentials
//     out of a config object before it is handed back to any caller. Also
//     special-cases `authHeader.value` (a secret nested one level deep under
//     a non-secret-looking parent key).
//   - admin.mjs — `collectLiteralSecrets()` + `SCRUB_PATTERNS` + `scrubLine()`,
//     used to scrub literal secrets and secret-shaped patterns (private keys,
//     `sk-ant-…`, generic `sk-…`, JWTs, AWS `AKIA…`, GitHub `ghp_…`, Slack
//     `xox…`, bearer tokens, and `key: value` / `key=value` pairs whose key
//     name looks like a credential) out of a raw log line before it is ever
//     shown to a caller.
//   - oauth.mjs — persists `client_secret` / `refresh_token` / `access_token`
//     on disk, never returns them (its own hand-rolled projections omit them
//     entirely rather than masking).
//
// SECURITY-CRITICAL: `SECRET_KEYS` here is deliberately a SUPERSET of every
// key name any of the above maskers treat as secret — normalized (lower-cased,
// non-alphanumeric stripped) so `apiKey`, `api_key`, `API-KEY` and `apikey` are
// all the same entry. Never remove an entry without re-auditing every caller
// listed above; the whole point of this port is "never fewer" than what is
// masked today. See tests/redact.test.mjs for the key-coverage assertions.
//
// Zero npm dependencies — Node built-ins only. Every function is pure and
// synchronous: no fs, no network, no timers. `sanitize()` never throws (a
// circular object degrades to an empty container rather than crashing).
// ─────────────────────────────────────────────────────────────────────────────

function normKey(k) {
  return String(k ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Normalized (see normKey) key names treated as secret by `sanitize()`.
// Coverage audit (normalized form — source):
//   password        ← integrations.mjs SECRET_KEYS, admin.mjs SCRUB_PATTERNS
//   pass            ← integrations.mjs SECRET_KEYS
//   passwd          ← admin.mjs SCRUB_PATTERNS
//   secret          ← integrations.mjs SECRET_KEYS, admin.mjs SCRUB_PATTERNS
//   clientsecret    ← admin.mjs SCRUB_PATTERNS, oauth.mjs (client_secret)
//   webhooksecret,
//   signingsecret,
//   apisecret       ← same family as `secret`/`clientsecret`, common in the
//                      wild (e.g. Stripe/GitHub webhook secrets); included so
//                      a future integration doesn't silently under-cover.
//   token           ← integrations.mjs SECRET_KEYS
//   apikey          ← integrations.mjs SECRET_KEYS (apiKey), admin.mjs (api_key/apikey)
//   accesstoken     ← admin.mjs SCRUB_PATTERNS, oauth.mjs (access_token)
//   refreshtoken    ← admin.mjs SCRUB_PATTERNS, oauth.mjs (refresh_token)
//   sessiontoken,
//   idtoken,
//   bearertoken     ← same family as `token`; admin.mjs also scrubs the
//                      `bearer <token>` wire format via a pattern (see
//                      SECRET_PATTERNS below), not a key name — covered twice.
//   dotoken         ← servers.mjs `doToken` (DigitalOcean API token)
//   authorization   ← admin.mjs SCRUB_PATTERNS
//   auth            ← conservative superset of `authorization`
//   privatekey      ← admin.mjs SCRUB_PATTERNS (PEM block), servers.mjs keyPath family
//   keypath         ← servers.mjs `keyPath` (masked to basename there; redacted
//                      outright here — sanitize() is a stricter superset)
export const SECRET_KEYS = Object.freeze(new Set([
  'password', 'pass', 'passwd',
  'secret', 'clientsecret', 'webhooksecret', 'signingsecret', 'apisecret',
  'token', 'apikey', 'accesstoken', 'refreshtoken', 'sessiontoken', 'idtoken', 'bearertoken', 'dotoken',
  'authorization', 'auth',
  'privatekey', 'keypath',
]));

// Nested shape special-cases: a key whose OWN name doesn't look secret, but
// whose child field does, given the parent. Mirrors integrations.mjs's
// `authHeader.value` (an arbitrary header value that is secret precisely
// because it lives under `authHeader`, not because "value" looks secret).
const NESTED_SECRET_FIELDS = new Map([
  ['authheader', new Set(['value'])],
]);

export function isSecretKey(key, extraKeys = []) {
  const nk = normKey(key);
  if (SECRET_KEYS.has(nk)) return true;
  for (const k of extraKeys) if (normKey(k) === nk) return true;
  return false;
}

const DEFAULT_MASK = '[REDACTED]';

// Deep-redact every key in `value` (recursively, through arrays too) whose
// name matches SECRET_KEYS (or an extra caller-supplied key list — a
// composable escape hatch for a module with its own additional secret field
// names, without ever REMOVING coverage). A matched key's value is replaced
// with `mask` unless it is already empty/nullish (nothing to hide). Circular
// references degrade to an empty object/array at the cycle point rather than
// throwing or looping forever. Non-object input (string/number/etc.) is
// returned unchanged — there is nothing to walk.
export function sanitize(value, { mask = DEFAULT_MASK, maxDepth = 8, extraKeys = [] } = {}) {
  return walk(value, mask, maxDepth, extraKeys, new Set());
}

function walk(value, mask, depth, extraKeys, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value) || depth < 0) return Array.isArray(value) ? [] : {};

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => walk(v, mask, depth - 1, extraKeys, seen));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k, extraKeys)) {
        out[k] = v == null || v === '' ? v : mask;
        continue;
      }
      const nk = normKey(k);
      if (v && typeof v === 'object' && !Array.isArray(v) && NESTED_SECRET_FIELDS.has(nk)) {
        const nestedKeys = NESTED_SECRET_FIELDS.get(nk);
        const nv = {};
        for (const [k2, v2] of Object.entries(v)) {
          nv[k2] = nestedKeys.has(normKey(k2)) && v2 != null && v2 !== ''
            ? mask
            : walk(v2, mask, depth - 1, extraKeys, seen);
        }
        out[k] = nv;
        continue;
      }
      out[k] = walk(v, mask, depth - 1, extraKeys, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

// ── literal / pattern secret detection ───────────────────────────────────────
// Same pattern families admin.mjs's SCRUB_PATTERNS applies to a log line,
// exposed as boolean detectors so a caller can decide NOT to log/emit a
// string at all (rather than emit a scrubbed copy).
const SECRET_PATTERNS = [
  // Redact the WHOLE PEM block (BEGIN..END), not just the marker — otherwise
  // scrubText() leaves the key BODY in place (Opus review, CRITICAL leak). The
  // `|$` fallback also redacts a truncated key (BEGIN with no END) to end-of-input.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/,
  // Bare `token=<value>` / `#token=<value>` (URL query / fragment) — admin.mjs's
  // pattern; the key:value list below omits bare `token`, so this is the only
  // thing that catches a token in a URL. Keeps the `token=` prefix, redacts value.
  /(#?\btoken=)[^\s&"'<>]+/i,
  // No leading \b on sk-ant: the deleted admin.mjs scrubber had none, so a key
  // GLUED to a preceding word-char (e.g. `xsk-ant-…`) must still be caught
  // (Wave-3 adversarial review, MEDIUM leak). `sk-ant-` is specific enough that
  // dropping the boundary introduces no false positives. The generic `sk-`
  // backstop below KEEPS its \b — without it, ordinary words like `risk-…` would
  // false-positive.
  /sk-ant-[A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/, // JWT-shaped
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/i,
  // Capturing group holds the key name + separator so scrubText() can keep it
  // and redact only the value (matches admin.mjs's own `'$1[REDACTED]'`).
  /(\b(?:api[_-]?key|apikey|password|passwd|secret|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*)["']?[^\s,"'<>]+/i,
  /(\bauthorization\b["']?\s*[:=]\s*)["']?[^\s,"'<>]+/i,
];

// True if `str` contains anything secret-shaped (a literal key pattern, a
// PEM block, a JWT, a cloud-provider token prefix, or a `key: value` /
// `key=value` pair whose key looks like a credential). Never throws.
export function hasSecret(str) {
  const s = String(str ?? '');
  return SECRET_PATTERNS.some((re) => re.test(s));
}

const ANSI_RE = new RegExp('[' + String.fromCharCode(0x1b, 0x9b) + ']\\[[0-9;?]*[ -/]*[@-~]', 'g');

// Scrub a single line of text the same way admin.mjs's `scrubLine` does: strip
// ANSI escapes, redact any caller-supplied literal secrets verbatim (longest
// first, so a superstring is redacted before an embedded substring), then
// apply the pattern-based scrubbers. Never throws.
export function scrubText(str, { literals = [] } = {}) {
  let out = String(str ?? '').replace(ANSI_RE, '');
  const lits = [...literals].filter((l) => typeof l === 'string' && l.length > 0).sort((a, b) => b.length - a.length);
  for (const lit of lits) {
    if (out.includes(lit)) out = out.split(lit).join(DEFAULT_MASK);
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), (m, ...rest) => {
      // Patterns with a capture group (bearer, key:/key=) keep the captured
      // prefix and redact only the value; patterns with no group redact the
      // whole match.
      const groups = rest.slice(0, -2);
      return groups.length && groups[0] !== undefined ? `${groups[0]}${DEFAULT_MASK}` : DEFAULT_MASK;
    });
  }
  return out;
}

export const Redact = { SECRET_KEYS, isSecretKey, sanitize, hasSecret, scrubText };
export default Redact;

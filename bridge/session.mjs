// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — session
//
// The pairing token and how long it lives. Until now the token was minted once and
// kept forever, with no way to change it short of deleting a file by hand: a token
// that leaked stayed valid for the life of the install. This module gives it an
// owner-chosen lifetime and a rotate button, without changing what ships.
//
// THE DEFAULT IS PERMANENT — deliberately. A local app the owner opens twenty times a
// day must not log them out, so an unconfigured install behaves exactly as before: one
// token, no expiry. Everything below only happens because someone chose it in
// Settings → Session.
//
// WHAT EXPIRY ACTUALLY DOES. On the first request that presents an expired token, the
// token is refused AND immediately replaced: the old secret is dead from that moment,
// including for whoever might have copied it. The running window starts getting 401s
// and says it is no longer paired. Getting back in is a relaunch — launch.sh reads the
// new token from the 0600 file (it runs as the owner, so this is not a privilege it
// lacked) and arms ONE auto-pair before opening the window. That is the whole recovery
// path, and it is why expiry is usable instead of a lockout.
//
// WHAT IT DOES NOT DO. Expiry is not a boundary against a process running AS the owner:
// such a process reads ~/.clone-frame-hub/bridge.token directly and always could. What
// it bounds is the LIFETIME of a token that got away — a stale browser tab, a copied
// link, a backup, a shared screen — and how long an old one keeps working after the
// owner stops using the machine. Judge it as key rotation, not as a login.
//
// Storage: the policy in ~/.clone-frame-hub/session.json through the shared json-store
// on the hub-root seam; the secret itself stays where every client already looks for it,
// ~/.clone-frame-hub/bridge.token (0600 in a 0700 dir).
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

// mode 'permanent' — no expiry. THE DEFAULT, and what every existing install gets.
// mode 'expiring'  — the token dies `hours` after it was issued.
// issuedAt is stamped when a token is minted AND when the owner changes the policy: a
// fresh choice starts a fresh session, so nobody enables a 12h limit and finds their
// window already expired because the token happens to be a month old.
// `keys` are ADDITIONAL named keys the owner issues — a second window, another local
// account, a machine paired from the launcher, an automation. Each carries its own name,
// its own clock and its own revoke. They are keys, NOT accounts: this bridge runs as the
// owner and every key that opens it gets the owner's shell. Settings says so in as many
// words; the UI must never imply that a key is a smaller kind of user.
const SHAPE = { mode: 'permanent', hours: 12, issuedAt: 0, keys: [] };
const MIN_HOURS = 0.25;   // 15 minutes — below this the app fights the person using it
const MAX_HOURS = 8760;   // one year — past this, say "permanent" and mean it

const store = openStore({ name: 'session', version: 1, shape: SHAPE, root: hubRoot() });
const tokenFile = () => path.join(hubRoot(), 'bridge.token');

let _tok = null;          // in-memory copy of the current secret (source of truth = the file)
// When we mint, we also remember WHEN in memory. If the policy write fails (full disk,
// read-only home) the on-disk issuedAt stays behind, and a fresh token would be judged
// against a stale stamp — expiring instantly, on every request, forever. This is the
// belt to that braces: expiry is measured from the LATER of the two.
let _mintedAt = 0;

function _clampHours(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, n));
}

// The policy is consulted on EVERY authenticated request, so it is not read from disk
// every time — json-store re-reads on each call by design. A 1s window is short enough
// that nothing observable lags (every legitimate change goes through set()/rotate(),
// which invalidate the cache outright) and long enough that a burst of requests costs
// one stat instead of hundreds. A clock that moved backwards forces a re-read.
const POLICY_TTL_MS = 1000;
let _cache = null, _cacheAt = 0;
function _invalidate() { _cache = null; }
function _policy() {
  const age = Date.now() - _cacheAt;
  if (_cache && age >= 0 && age < POLICY_TTL_MS) return _cache;
  const s = store.read();
  _cacheAt = Date.now();
  _cache = {
    mode: s.mode === 'expiring' ? 'expiring' : 'permanent',
    hours: _clampHours(s.hours) || SHAPE.hours,
    issuedAt: Number(s.issuedAt) > 0 ? Number(s.issuedAt) : 0,
    keys: (Array.isArray(s.keys) ? s.keys : []).filter((k) => k && typeof k.token === 'string' && k.token.length >= 32),
  };
  return _cache;
}

// Same shape as the primary token's expiry, applied per key.
function _keyExpiresAt(k) {
  if (k.mode !== 'expiring') return null;
  return (Number(k.issuedAt) || Date.now()) + (_clampHours(k.hours) || SHAPE.hours) * 3600_000;
}
function _dropKey(id) {
  const s = store.read();
  const keys = (Array.isArray(s.keys) ? s.keys : []).filter((k) => k && k.id !== id);
  store.write({ ...s, keys });
  _invalidate();
}

function _write(tok) {
  try { fs.mkdirSync(hubRoot(), { recursive: true, mode: 0o700 }); } catch {}
  fs.writeFileSync(tokenFile(), tok, { mode: 0o600 });
  try { fs.chmodSync(tokenFile(), 0o600); } catch {}   // an older file may predate the mode
}

// Stamp "the current token was issued now". Synchronous on purpose: mutate() is async,
// and an expiry check that runs before the stamp lands would expire the token we just
// minted — on every request, in a loop.
// Always writes the WHOLE store back. Writing only the three fields it cares about would
// silently drop `keys` — which is exactly what happened the first time, and what the key
// tests caught: minting the primary token wiped every key the owner had issued.
function _stamp() {
  const cur = store.read();
  const p = _policy();
  _mintedAt = Date.now();
  store.write({ ...cur, mode: p.mode, hours: p.hours, issuedAt: _mintedAt });
  _invalidate();
}

// The current secret. Server-only (`_`-prefixed = unreachable through POST /mod/) —
// the bridge itself calls this to inject the token into a paired window.
function _token() {
  if (_tok) return _tok;
  try {
    const t = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (t.length >= 32) {
      _tok = t;
      // An install that predates this module has a token but no issuedAt. Stamp it NOW
      // rather than backdating from mtime: the alternative is that switching the policy
      // to "expiring" instantly kills a token that was working a second earlier.
      if (!_policy().issuedAt) { try { _stamp(); } catch {} }
      return _tok;
    }
  } catch { /* no token yet — mint one below */ }
  _tok = randomBytes(24).toString('base64url');
  try { _write(_tok); } catch {}
  try { _stamp(); } catch {}
  return _tok;
}

function _expiresAt() {
  const p = _policy();
  if (p.mode !== 'expiring') return null;
  const from = Math.max(p.issuedAt || 0, _mintedAt) || Date.now();
  return from + p.hours * 3600_000;
}

function _expired() {
  const at = _expiresAt();
  return at !== null && Date.now() >= at;
}

// Mint a new secret. Callers that already hold the current token get the new one back,
// so the owner's own window survives a rotation without a reload.
function _mint() {
  _tok = randomBytes(24).toString('base64url');
  _write(_tok);
  _stamp();
  return _tok;
}

// The gate every authenticated route goes through. Constant-time compare first, expiry
// second — an expired token is refused AND retired on the spot, so the secret that just
// failed can never work again, for anyone.
// Server-only by design: this is an oracle, not an API.
function _same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function _verify(tok) {
  if (typeof tok !== 'string' || !tok) return false;
  if (_same(tok, _token())) {
    if (!_expired()) return true;
    try { _mint(); } catch { /* if we cannot write, the old token stays refused anyway */ }
    return false;
  }
  // Additional named keys the owner issued. An expired one is DELETED rather than replaced:
  // the primary token must always exist for the app to be reachable at all, but a named key
  // that ran out has served its purpose and should stop existing.
  for (const k of _policy().keys) {
    if (!_same(tok, k.token)) continue;
    const at = _keyExpiresAt(k);
    if (at === null || Date.now() < at) return true;
    try { _dropKey(k.id); } catch { /* refused either way */ }
    return false;
  }
  return false;
}

// ── RPC surface (the owner's UI) ─────────────────────────────────────────────
// Never returns the secret. `expiresAt`/`remainingMs` are null in permanent mode.
function get() {
  const p = _policy();
  const at = _expiresAt();
  return {
    ok: true,
    mode: p.mode,
    hours: p.hours,
    issuedAt: p.issuedAt || null,
    expiresAt: at,
    remainingMs: at === null ? null : Math.max(0, at - Date.now()),
    minHours: MIN_HOURS,
    maxHours: MAX_HOURS,
  };
}

// set({mode}) / set({hours}) / set({mode,hours}). Changing either restarts the clock.
// An unrecognised mode is ignored rather than treated as "permanent" — a typo must never
// silently remove the limit the owner asked for.
function set(patch = {}) {
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'bad patch' };
  const cur = _policy();
  const mode = patch.mode === 'expiring' || patch.mode === 'permanent' ? patch.mode : cur.mode;
  let hours = cur.hours;
  if (patch.hours !== undefined) {
    const h = _clampHours(patch.hours);
    if (h === null) return { ok: false, error: 'hours must be a number' };
    hours = h;
  }
  try { store.write({ ...store.read(), mode, hours, issuedAt: Date.now() }); _invalidate(); }
  catch (e) { return { ok: false, error: (e && e.message) || 'write failed' }; }
  return get();
}

// Rotate now. Returns the NEW token to the caller — which is not an escalation: reaching
// this function at all required already holding the current one, and every local client
// can read the token file directly. The owner's UI swaps it in place, so the window it
// was called from keeps working; every OTHER window and any copy of the old token stops.
function rotate() {
  let tok;
  try { tok = _mint(); } catch (e) { return { ok: false, error: (e && e.message) || 'write failed' }; }
  return { ...get(), token: tok };
}

// ── additional keys ──────────────────────────────────────────────────────────
// keys() never returns a token — a key's secret is shown ONCE, by issue(), to the caller
// that created it. There is no "show me that key again": if it was lost, revoke and issue
// another. That is the only honest option, because we do not want a route that hands out
// working credentials on request.
function keys() {
  const now = Date.now();
  return {
    ok: true,
    keys: _policy().keys.map((k) => {
      const at = _keyExpiresAt(k);
      return {
        id: k.id, name: k.name || 'key',
        issuedAt: Number(k.issuedAt) || null,
        mode: k.mode === 'expiring' ? 'expiring' : 'permanent',
        hours: _clampHours(k.hours) || SHAPE.hours,
        expiresAt: at, remainingMs: at === null ? null : Math.max(0, at - now),
        expired: at !== null && now >= at,
      };
    }),
  };
}

function issue(opts = {}) {
  const name = String((opts && opts.name) || '').trim().slice(0, 40) || 'key';
  const mode = opts.mode === 'expiring' ? 'expiring' : 'permanent';
  const hours = opts.hours === undefined ? SHAPE.hours : _clampHours(opts.hours);
  if (hours === null) return { ok: false, error: 'hours must be a number' };
  const key = {
    id: randomBytes(6).toString('hex'),
    name, mode, hours,
    issuedAt: Date.now(),
    token: randomBytes(24).toString('base64url'),
  };
  // REFUSE past the ceiling; never silently drop one to make room. `.slice(0, 63)` meant
  // that issuing a 65th key deleted the 64th — a credential the owner was relying on
  // stopped working, with no error and `{ok:true}` returned. These keys each grant the
  // owner's shell (see the header); a "create" that can silently revoke a different
  // credential is the wrong failure mode wherever the ceiling sits (DEBUG4 · CF4-B-007).
  const MAX_KEYS = 64;
  try {
    const s = store.read();
    const list = Array.isArray(s.keys) ? s.keys : [];
    if (list.length >= MAX_KEYS) {
      return { ok: false, error: `key limit reached (${MAX_KEYS}) — revoke one before issuing another` };
    }
    store.write({ ...s, keys: [...list, key] });
    _invalidate();
  } catch (e) { return { ok: false, error: (e && e.message) || 'write failed' }; }
  // The one and only time the secret leaves this module.
  return { ok: true, id: key.id, name, token: key.token, mode, hours };
}

function revoke(id) {
  const target = String(id || '');
  if (!_policy().keys.some((k) => k.id === target)) return { ok: false, error: 'no such key' };
  try { _dropKey(target); } catch (e) { return { ok: false, error: (e && e.message) || 'write failed' }; }
  return { ok: true };
}

export const Session = { get, set, rotate, keys, issue, revoke, _token, _verify, _expired };
export default Session;

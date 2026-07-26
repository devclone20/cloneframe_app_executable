// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — rpcallow
//
// The owner's OWN allowlist for what the agent may reach through `app_rpc`.
//
// CLONE FRAME ships the pi agent in YOLO: bash runs free, every bridge module is
// reachable, and that is the owner's deliberate choice — see agent/AGENTS.md §1.4.
// This module does not change that default. It exists so a user who WANTS a narrower
// agent can have one without forking anything: `mode: 'open'` out of the box, and a
// list they curate themselves in Settings → Agent Tools → app_rpc allowlist.
//
// WHAT THIS IS, EXACTLY — read before trusting it with anything:
//
//   It is a GUARDRAIL ON THE AGENT'S OWN TOOL, not a security boundary. Enforcement
//   keys off a header the pi extension sets on its own calls (`x-cfhub-caller: agent`),
//   so it constrains what the agent reaches for in normal operation — the realistic
//   risk being a prompt injection in a page pi reads talking it into calling something
//   it should not. It does NOT contain a caller that already holds the pairing token:
//   such a caller can POST /mod/<name> directly and omit the header. Anything holding
//   that token already has a shell (SECURITY.md says so in its first line), so there is
//   no boundary here to lose — but do not read a configured allowlist as one.
//
//   For real confinement of the agent itself, the upstream answer is pi.dev's own
//   guardrails, which sit inside the agent rather than beside it. The README points
//   users there; this is the in-app, zero-setup layer.
//
// Storage: ~/.clone-frame-hub/rpc-allowlist.json through the shared json-store on the
// hub-root seam (0700 dir / 0600 file). Resolved through hubRoot() deliberately —
// permissions.mjs was once missed in that migration and a test wrote to the developer's
// real config as a result.
// ─────────────────────────────────────────────────────────────────────────────
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

// mode 'open'      — everything is allowed except what `deny` names. THE DEFAULT.
// mode 'allowlist' — nothing is allowed except what `allow` names.
// Entries are 'module' (whole module) or 'module.fn' (one function). Case-insensitive.
const SHAPE = { mode: 'open', allow: [], deny: [] };

const store = openStore({ name: 'rpc-allowlist', version: 1, shape: SHAPE, root: hubRoot() });

function _norm(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s || s.length > 128) continue;
    if (!/^[a-z0-9_-]+(\.[a-z0-9_$-]+)?$/.test(s)) continue;   // module | module.fn
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 500);
}

function read() {
  const s = store.read();
  return {
    mode: s.mode === 'allowlist' ? 'allowlist' : 'open',
    allow: _norm(s.allow),
    deny: _norm(s.deny),
  };
}

// Does `list` cover this call? A bare module entry covers every function on it.
function _covers(list, mod, fn) {
  return list.includes(mod) || list.includes(mod + '.' + fn);
}

// The decision. Pure, so it is trivially testable and cannot surprise at the call site.
// Returns { allowed:true } or { allowed:false, reason } — never throws.
function check(module, fn) {
  const mod = String(module || '').toLowerCase();
  const f = String(fn || '').toLowerCase();
  const p = read();
  if (p.mode === 'allowlist') {
    if (_covers(p.allow, mod, f)) return { allowed: true };
    return { allowed: false, reason: `app_rpc allowlist: ${mod}.${f} is not on your allowlist (Settings → Agent Tools)` };
  }
  if (_covers(p.deny, mod, f)) {
    return { allowed: false, reason: `app_rpc allowlist: you have blocked ${mod}.${f} (Settings → Agent Tools)` };
  }
  return { allowed: true };
}

// ── RPC surface (the owner's UI reads and writes this) ───────────────────────
function get() { return { ok: true, ...read() }; }

function set(patch = {}) {
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'bad patch' };
  const cur = read();
  const next = {
    mode: patch.mode === 'allowlist' || patch.mode === 'open' ? patch.mode : cur.mode,
    allow: patch.allow === undefined ? cur.allow : _norm(patch.allow),
    deny: patch.deny === undefined ? cur.deny : _norm(patch.deny),
  };
  try { store.write(next); } catch (e) { return { ok: false, error: (e && e.message) || 'write failed' }; }
  return { ok: true, ...next };
}

function reset() {
  try { store.write({ ...SHAPE }); } catch (e) { return { ok: false, error: (e && e.message) || 'write failed' }; }
  return { ok: true, ...SHAPE };
}

export const RpcAllow = { get, set, reset, check };
export default RpcAllow;

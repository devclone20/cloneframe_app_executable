// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — okxai (OKX Onchain OS CLI: ERC-8004 agent identity,
// task marketplace, agentic wallet)
// Wraps the user's own `onchainos` binary behind a fail-closed safety gate:
//   read      → callable freely (agent lookups, task status, wallet reads)
//   mutate    → requires confirm:true (a UI click handler) — audited
//   financial → requires approved:true (the amber confirm modal) — audited,
//               moves funds, signs/settles payments, claims/stakes
//   auth      → NEVER runs from the app; returns the command for the user's
//               own terminal (login/verify/switch/preflight/upgrade are
//               owner-only flows — this binary holds live wallet sessions)
// Unknown commands are refused. `onchainos` prints JSON on stdout for data
// commands by default (no --json flag exists — verified via --help; nothing
// invented here) and human text on stderr, so stdout is parsed best-effort.
//
// The four-class gate itself (binary discovery wiring, longest-prefix
// classification, capped execFile, append-only audit, fail-closed sentinels)
// is the shared platform/cli-gate mechanism — this module supplies only the
// onchainos-specific config (its command tree, binary discovery, messages).
// See platform/cli-gate.mjs + tests/cli-gate-port.test.mjs for the proof the
// gate is a strict behavioral superset of the copy that used to live here.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { makeGatedCli } from './platform/cli-gate.mjs';
import { hubRoot } from './platform/hub-root.mjs';

const DIR = hubRoot();
const AUDIT = path.join(DIR, 'okxai-audit.jsonl');
const DRAFTS_FILE = path.join(DIR, 'okxai-drafts.json');

// onchainos-specific binary discovery — the ONE piece the shared gate cannot
// express (it only knows "give me an absolute executable path or null"). Kept
// local and passed to makeGatedCli as resolveBin. Never throws.
function bin() {
  const override = process.env.OKX_ONCHAINOS_BIN;
  if (override) { try { fs.accessSync(override, fs.constants.X_OK); return override; } catch {} }
  const local = path.join(homedir(), '.local', 'bin', 'onchainos');
  try { fs.accessSync(local, fs.constants.X_OK); return local; } catch {}
  try {
    const found = execFileSync('which', ['onchainos'], { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0];
    if (found) { fs.accessSync(found, fs.constants.X_OK); return found; }
  } catch {}
  return null;
}

// Longest-prefix classification over the onchainos v4.x command tree.
// Conservative: anything that moves value, signs, claims, or stakes is
// financial; anything that only changes off-chain state is mutate;
// key/session flows are auth; unknown → refused.
const CLASS = {
  // read — pure queries, free to call
  'wallet status': 'read', 'wallet addresses': 'read', 'wallet chains': 'read',
  'wallet balance': 'read', 'wallet history': 'read', 'wallet geoblock': 'read', 'wallet qrcode': 'read',
  'agent get-my-agents': 'read', 'agent get-agents': 'read', 'agent my-agents': 'read',
  'agent search': 'read', 'agent service-list': 'read', 'agent feedback-list': 'read',
  'agent status': 'read', 'agent tasks': 'read', 'agent active-tasks': 'read',
  'agent gate-check': 'read', 'agent profile': 'read', 'agent designated-route': 'read',
  'agent x402-check': 'read', 'agent x402-validate': 'read', 'agent recommend-task': 'read',
  'agent find-jobs': 'read', 'agent list-attachments': 'read', 'agent task-deliverable-list': 'read',
  'agent asp-claimable': 'read', 'agent prepare-create': 'read', 'agent validate-listing': 'read',
  'agent draft list': 'read', 'agent asp-match': 'read',
  // mutate — off-chain state changes, no direct value movement (still gated)
  'agent pre-check': 'mutate', 'agent upload': 'mutate', 'agent create': 'mutate',
  'agent update': 'mutate', 'agent activate': 'mutate', 'agent deactivate': 'mutate',
  'agent feedback-submit': 'mutate', 'agent create-task': 'mutate', 'agent set-asp': 'mutate',
  'agent reset-asp': 'mutate', 'agent user-reject': 'mutate', 'agent mark-failed': 'mutate',
  'agent set-public': 'mutate', 'agent task-attach': 'mutate', 'agent task-deliverable-save': 'mutate',
  'agent draft create': 'mutate', 'agent draft update': 'mutate', 'agent draft delete': 'mutate',
  'agent draft publish': 'mutate', 'agent asp-reject': 'mutate', 'agent contact-user': 'mutate',
  'agent user-notify': 'mutate', 'agent reject-apply': 'mutate', 'agent close': 'mutate',
  'agent apply': 'mutate', 'agent deliver': 'mutate',
  // financial — moves/spends funds, signs txs, settles or claims rewards
  'wallet send': 'financial', 'wallet sign-message': 'financial', 'wallet contract-call': 'financial',
  'agent set-payment-mode': 'financial', 'agent confirm-accept': 'financial', 'agent direct-accept': 'financial',
  'agent task-402-pay': 'financial', 'agent complete': 'financial', 'agent reject': 'financial',
  'agent agree-refund': 'financial', 'agent claim-auto-refund': 'financial', 'agent claim-auto-complete': 'financial',
  'agent asp-claim-rewards': 'financial', 'agent payment': 'financial',
  // auth — session/key flows: owner's terminal only, never through the app
  'wallet login': 'auth', 'wallet verify': 'auth', 'wallet add': 'auth', 'wallet switch': 'auth',
  'wallet logout': 'auth', 'preflight': 'auth', 'upgrade': 'auth',
};

// 180s window for the three slow, network+encode-heavy mutate commands.
const LONG_TIMEOUT_KEYS = new Set(['agent upload', 'agent create', 'agent activate']);

// A non-zero exit whose text smells like a dead wallet session — surfaced as a
// needsAuth sentinel so the UI can prompt the owner to re-login in their own
// terminal instead of silently showing an "error".
function detectSession(code, stdout, stderr) {
  if (/session expired|not logged in|please log ?in|unauthorized|401/i.test(stdout + ' ' + stderr)) return { needsAuth: true };
  return undefined;
}

const gate = makeGatedCli({
  resolveBin: bin,
  classMap: CLASS,
  auditFile: AUDIT,
  longTimeoutKeys: LONG_TIMEOUT_KEYS,
  binName: 'onchainos',
  binNotFoundError: 'onchainos CLI not installed — set OKX_ONCHAINOS_BIN or install to ~/.local/bin/onchainos',
  authMessage: 'login/verify/add/switch/logout/preflight/upgrade run in YOUR terminal, never through the app',
  detectSentinel: detectSession,
  // clamps/caps below are the onchainos originals; passed explicitly so a
  // future change to the port's defaults can never silently move them here.
  defaultTimeoutMs: 60000,
  longTimeoutMs: 180000,
  minTimeoutMs: 1000,
  maxTimeoutMs: 180000,
  maxOutputBytes: 200 * 1024,
  maxErrorBytes: 4000,
  maxArgvLen: 24,
  maxArgLen: 4000,
  maxPrefixWords: 3,
  maxBuffer: 8 * 1024 * 1024,
});

// Single-file JSON store for ASP listing drafts, keyed by name. Never holds
// keys/secrets — just draft form state (name/description/services/avatar).
//
// NOT migrated to platform/json-store's openStore, deliberately: this file's
// TOP-LEVEL object IS the draft map (dynamic keys = draft names), whereas
// openStore stamps a fixed `version` field onto the top level. Stamping would
// (a) inject a `version` key into the user's existing on-disk map and (b) make
// `Object.values()` in localDrafts() return the number `1` as a phantom draft —
// a return-shape regression. It is already read-per-call (readDrafts re-reads
// from disk every call; there is no module-level cached copy), so it carries
// none of the stale-singleton bug openStore exists to fix. Left as-is.
function readDrafts() {
  try {
    const j = JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch { return {}; }
}
function writeDrafts(map) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(map, null, 2), { mode: 0o600 });
}

export const OkxAi = {
  // ---- CLI presence + auth posture (never returns apiKey/tokens) ----
  async status() {
    const b = gate.bin();
    if (!b) return { ok: true, installed: false };
    const v = await gate.probe(['--version'], { timeoutMs: 8000 });
    const version = String(v.text ?? v.json ?? '').replace(/^onchainos\s+/i, '').trim();
    const s = await gate.probe(['wallet', 'status'], { timeoutMs: 15000 });
    const data = s.json && s.json.data;
    const authenticated = !!data && data.loggedIn === true;
    const address = (data && (data.address || data.evmAddress)) || undefined;
    return { ok: true, installed: true, bin: b, version, authenticated, address };
  },

  // ---- the single gate every CLI call goes through ----
  run(argv, opts = {}) {
    return gate.run(argv, opts);
  },

  // ---- convenience: the user's own registered agents ----
  async agents() {
    const r = await this.run(['agent', 'get-my-agents']);
    if (!r.ok) return { ok: false, raw: r.text ?? r.error, error: r.error };
    const raw = r.json ?? r.text;
    let list;
    const d = r.json && r.json.data;
    if (Array.isArray(d)) list = d;
    else if (d && Array.isArray(d.list)) list = d.list;
    else if (d && Array.isArray(d.agentList)) list = d.agentList;
    return { ok: true, raw, agents: list };
  },

  // ---- static UI lookup for approvalStatus codes; unknown → handled UI-side ----
  reviewStates() {
    return { 2: 'under_review', 5: 'rejected' };
  },

  // ---- ASP listing drafts (local only, no chain, no funds) ----
  localDrafts() {
    return { ok: true, drafts: Object.values(readDrafts()) };
  },

  // obj undefined → get, obj === null → remove, obj object → create/update
  localDraft(name, obj) {
    const clean = String(name || '').trim();
    if (!clean) return { ok: false, error: 'draft name required' };
    const map = readDrafts();
    if (obj === undefined) {
      return map[clean] ? { ok: true, draft: map[clean] } : { ok: false, error: 'draft not found' };
    }
    if (obj === null) {
      if (!(clean in map)) return { ok: false, error: 'draft not found' };
      delete map[clean];
      writeDrafts(map);
      return { ok: true, removed: clean };
    }
    const prev = map[clean] || {};
    map[clean] = { ...prev, ...obj, name: clean, createdAt: prev.createdAt || Date.now(), updatedAt: Date.now() };
    writeDrafts(map);
    return { ok: true, draft: map[clean] };
  },
};
export default OkxAi;

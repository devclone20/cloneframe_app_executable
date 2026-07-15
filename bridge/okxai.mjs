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
// ─────────────────────────────────────────────────────────────────────────────
import { execFile, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(homedir(), '.clone-frame-hub');
const AUDIT = path.join(DIR, 'okxai-audit.jsonl');
const DRAFTS_FILE = path.join(DIR, 'okxai-drafts.json');
const MAX_OUT = 200 * 1024;

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

function classify(argv) {
  const words = argv.filter(a => !a.startsWith('-'));
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const key = words.slice(0, n).join(' ');
    if (CLASS[key]) return { key, cls: CLASS[key] };
  }
  return null;
}

function audit(entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(AUDIT, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', { mode: 0o600 });
  } catch {}
}

function exec(argv, { timeoutMs = 60000 } = {}) {
  const b = bin();
  if (!b) return Promise.resolve({ ok: false, error: 'onchainos CLI not installed — set OKX_ONCHAINOS_BIN or install to ~/.local/bin/onchainos' });
  return new Promise(resolve => {
    execFile(b, argv, { timeout: Math.min(Math.max(timeoutMs, 1000), 180000), maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        const out = String(stdout || '').slice(0, MAX_OUT);
        const errText = String(stderr || '').slice(0, 4000);
        let json = null; try { json = JSON.parse(out); } catch {}
        const code = err ? (err.killed ? 'timeout' : (err.code ?? 1)) : 0;
        const needsAuth = code !== 0 && /session expired|not logged in|please log ?in|unauthorized|401/i.test(out + ' ' + errText);
        resolve({ ok: code === 0, code, json, text: json ? undefined : out, error: code === 0 ? undefined : (errText || out || String(err && err.message)), needsAuth: needsAuth || undefined });
      });
  });
}

// Single-file JSON store for ASP listing drafts, keyed by name. Never holds
// keys/secrets — just draft form state (name/description/services/avatar).
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
    const b = bin();
    if (!b) return { ok: true, installed: false };
    const v = await exec(['--version'], { timeoutMs: 8000 });
    const version = String(v.text ?? v.json ?? '').replace(/^onchainos\s+/i, '').trim();
    const s = await exec(['wallet', 'status'], { timeoutMs: 15000 });
    const data = s.json && s.json.data;
    const authenticated = !!data && data.loggedIn === true;
    const address = (data && (data.address || data.evmAddress)) || undefined;
    return { ok: true, installed: true, bin: b, version, authenticated, address };
  },

  // ---- the single gate every CLI call goes through ----
  async run(argv, opts = {}) {
    if (!Array.isArray(argv) || !argv.length || argv.length > 24) return { ok: false, error: 'bad argv' };
    if (!argv.every(a => typeof a === 'string' && a.length <= 4000 && !a.includes('\0'))) return { ok: false, error: 'bad argv' };
    const c = classify(argv);
    if (!c) return { ok: false, error: `refused: unknown or unsupported command "${argv.slice(0, 3).join(' ')}"` };
    if (c.cls === 'auth') return { ok: false, needsTerminal: true, class: 'auth', command: 'onchainos ' + argv.join(' '), error: 'login/verify/add/switch/logout/preflight/upgrade run in YOUR terminal, never through the app' };
    if (c.cls === 'financial' && opts.approved !== true) return { ok: false, needsApproval: true, class: 'financial', command: c.key };
    if (c.cls === 'mutate' && opts.confirm !== true && opts.approved !== true) return { ok: false, needsConfirm: true, class: 'mutate', command: c.key };
    const timeoutMs = opts.timeoutMs ?? (LONG_TIMEOUT_KEYS.has(c.key) ? 180000 : 60000);
    const r = await exec(argv, { timeoutMs });
    if (c.cls !== 'read') audit({ cmd: argv.join(' ').slice(0, 200), class: c.cls, ok: r.ok, code: r.code });
    return { ...r, class: c.cls };
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

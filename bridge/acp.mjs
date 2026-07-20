// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — acp (Virtuals EconomyOS CLI + local agent registry)
// Wraps the user's own `acp` binary behind a fail-closed safety gate:
//   read      → callable freely (lists, balances, inbox, status)
//   mutate    → requires confirm:true (set only by a UI click handler)
//   financial → requires approved:true (the amber confirm modal) — audited
//   auth      → NEVER runs from the app; returns the command for the user's
//               own terminal (configure/signers/signing are owner-only flows)
// Unknown commands are refused. Local agents (name + neural_soul.md + runtime)
// live in ~/CloneFrame/Agents — no chain, no funds, safe by construction.
//
// The CLI mechanism (binary discovery, longest-prefix classification, capped
// execFile, append-only jsonl audit, fail-closed sentinels) is the shared
// platform/cli-gate.mjs port — a proven behavioral superset of this module's
// original gate (see cli-gate-port.test.mjs). This module now supplies ONLY
// the acp-specific policy: the command tree (CLASS), the `trade --dry-run`
// reclassify, the `--json` argv prefix, and the needsSetup sentinel. The local
// agent registry stays on plain fs — it is a directory tree (config.json +
// neural_soul.md per agent), not a single-file json store, so no store port
// applies and there is no module-cache to convert.
// ─────────────────────────────────────────────────────────────────────────────
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import Folders from './folders.mjs';
import { makeGatedCli } from './platform/cli-gate.mjs';
import { hubPath } from './platform/hub-root.mjs';

const BIN_CANDIDATES = ['/opt/homebrew/bin/acp', '/usr/local/bin/acp'];
const AUDIT = hubPath('acp-audit.jsonl');
const CONFIG_DIR = path.join(homedir(), '.config', 'acp'); // the acp CLI's OWN config — not the hub's
const MAX_OUT = 200 * 1024;

function bin() { for (const b of BIN_CANDIDATES) { try { fs.accessSync(b, fs.constants.X_OK); return b; } catch {} } return null; }

// Longest-prefix classification over the acp v1.x command tree. Conservative:
// anything that can move value or bind keys is financial/auth; unknown → refused.
const CLASS = {
  // read — pure queries
  'agent list': 'read', 'agent whoami': 'read', 'agent signer-status': 'read',
  'browse': 'read', 'chain list': 'read',
  'job list': 'read', 'job history': 'read',
  'wallet address': 'read', 'wallet balance': 'read',
  'email whoami': 'read', 'email inbox': 'read', 'email search': 'read', 'email thread': 'read',
  'email extract-otp': 'read', 'email extract-links': 'read', 'email attachment': 'read',
  'card whoami': 'read', 'card profile': 'read', 'card limit': 'read', 'card list': 'read', 'card get': 'read',
  'compute status': 'read',
  'offering list': 'read', 'resource list': 'read', 'subscription list': 'read',
  'skill path': 'read', 'skill print': 'read', 'skill check': 'read',
  'trade hl-status': 'read',
  // mutate — state changes with no direct value movement (still user-click gated)
  'agent create': 'mutate', 'agent use': 'mutate', 'agent update': 'mutate',
  'email provision': 'mutate', 'email compose': 'mutate', 'email reply': 'mutate',
  'message send': 'mutate',
  'offering create': 'mutate', 'offering update': 'mutate', 'offering delete': 'mutate',
  'resource create': 'mutate', 'resource update': 'mutate', 'resource delete': 'mutate',
  'provider set-budget': 'mutate', 'provider set-budget-with-fund-request': 'mutate', 'client review': 'mutate',
  'card profile set': 'mutate', 'card profile reset': 'mutate',
  'events drain': 'mutate',
  // financial — moves/spends/authorizes funds, signs txs indirectly
  'wallet send-transaction': 'financial', 'wallet topup': 'financial',
  'trade': 'financial', 'trade withdraw-from-hl': 'financial',
  'client create-job': 'financial', 'client create-custom-job': 'financial', 'client fund': 'financial',
  'client complete': 'financial', 'client reject': 'financial', // both SETTLE escrow — funds move
  'provider submit': 'financial', // --transfer-amount can move ERC-20 at submission
  'card payment-method': 'financial', 'card limit set': 'financial', 'card issue': 'financial', 'card 3ds': 'financial',
  'agent tokenize': 'financial', 'agent register-erc8004': 'financial',
  'compute top-up': 'financial',
  'subscription create': 'financial', 'subscription update': 'financial', 'subscription delete': 'financial',
  // auth — key/signer/OAuth flows: owner's terminal only, never through the app
  'configure': 'auth', 'configure start': 'auth', 'configure complete': 'auth',
  'agent add-signer': 'auth', 'agent generate-signer-key': 'auth', 'agent link': 'auth', 'agent migrate': 'auth',
  'card signup': 'auth', 'card signup-poll': 'auth',
  'wallet sign-message': 'auth', 'wallet sign-typed-data': 'auth',
};
// 'job watch' and 'events listen' stream forever — intentionally unclassified (refused).

// acp-specific policy handed to the shared gate. Exported so the port contract
// test can wire the REAL config to an in-memory fakeCli (no binary, no network)
// and prove the acp wiring — argv prefix, dry-run reclassify, needsSetup — end
// to end. Production supplies resolveBin (bin) alongside this.
export const cliGateConfig = {
  classMap: CLASS,
  auditFile: AUDIT,
  binName: 'acp',
  binNotFoundError: 'acp CLI not installed — `npm i -g @virtuals-protocol/acp-cli`',
  authMessage: 'key/signer/login flows run in YOUR terminal, never through the app',
  defaultTimeoutMs: 30000,
  maxTimeoutMs: 120000,
  maxOutputBytes: MAX_OUT,
  maxErrorBytes: 4000,
  // `trade --dry-run` is a quote, not an execution — the CLI's own preview mode.
  reclassify: (key, cls, argv) =>
    (cls === 'financial' && key.startsWith('trade') && argv.includes('--dry-run')) ? 'read' : undefined,
  // acp emits/consumes JSON; UI callers can opt out with opts.json === false.
  buildExecArgv: (argv, opts) => (opts.json === false ? argv : ['--json', ...argv]),
  // A non-zero exit whose output smells like a missing/expired session becomes a
  // needsSetup hint so the UI can route the owner to `acp configure`.
  detectSentinel: (code, out, errText) =>
    /not (configured|authenticated)|no (active )?agent|run `?acp configure|unauthorized|401/i.test(out + ' ' + errText)
      ? { needsSetup: true }
      : undefined,
};

const gate = makeGatedCli({ ...cliGateConfig, resolveBin: bin });

function agentsRoot() {
  const r = Folders.root();
  if (!r.ok) return null;
  return path.join(r.root, 'Agents');
}
function readAgent(dir, name) {
  let config = {}; try { config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) || {}; } catch {}
  let soul = ''; try { soul = fs.readFileSync(path.join(dir, 'neural_soul.md'), 'utf8'); } catch {}
  return { name, dir, config, hasSoul: !!soul.trim(), soulPreview: soul.slice(0, 240) };
}

export const Acp = {
  // ---- CLI presence + auth posture (never touches keys) ----
  async status() {
    const b = bin();
    if (!b) return { ok: true, installed: false };
    const v = await gate.probe(['--version'], { timeoutMs: 8000 });
    let configured = false;
    try { configured = fs.existsSync(CONFIG_DIR) && fs.readdirSync(CONFIG_DIR).length > 0; } catch {}
    let who = null;
    if (configured) {
      const w = await gate.probe(['--json', 'agent', 'whoami'], { timeoutMs: 10000 });
      who = w.ok ? (w.json ?? w.text) : null;
    }
    return { ok: true, installed: true, bin: b, version: (v.text || '').trim() || (v.json ?? ''), configured, authenticated: !!who, whoami: who };
  },

  // ---- tokenizable chains for THIS CLI build (Base only until acp>=1.0.23 adds Robinhood 4663) ----
  // Lets the UI show the real chain picker and, when Robinhood is missing, the exact
  // one-line update the user runs — instead of pretending a launch will work.
  async chains() {
    const b = bin();
    if (!b) return { ok: false, installed: false, chains: [], hasRobinhood: false };
    const r = await gate.probe(['--json', 'chain', 'list'], { timeoutMs: 10000 });
    const list = (r.ok && r.json && Array.isArray(r.json.chains)) ? r.json.chains : [];
    return { ok: r.ok, chains: list, hasRobinhood: list.some(c => Number(c.id) === 4663), updateCmd: 'npm i -g @virtuals-protocol/acp-cli@latest' };
  },

  // ---- the single gate every CLI call goes through (shared cli-gate port) ----
  run(argv, opts = {}) {
    return gate.run(argv, opts);
  },

  // ---- local agent registry (~/CloneFrame/Agents) — the safe, chainless path ----
  localList() {
    const root = agentsRoot();
    if (!root) return { ok: false, error: 'CloneFrame root unavailable' };
    let names = []; try { names = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name); } catch {}
    return { ok: true, agents: names.map(n => readAgent(path.join(root, n), n)) };
  },

  localCreate({ name, soul, description, runtime, model, serverId } = {}) {
    const d = Folders.agentDir(name);
    if (!d.ok) return d;
    if (typeof soul === 'string' && soul.trim()) fs.writeFileSync(d.soul, soul);
    const cfgPath = path.join(d.dir, 'config.json');
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch {}
    Object.assign(cfg, {
      name: path.basename(d.dir), description: description || cfg.description || '',
      runtime: runtime === 'server' ? 'server' : 'local',
      model: model || cfg.model || '', serverId: serverId || cfg.serverId || '',
      createdAt: cfg.createdAt || Date.now(), virtuals: cfg.virtuals || { linked: false },
    });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    return { ok: true, ...readAgent(d.dir, path.basename(d.dir)) };
  },

  localGet(name) {
    const root = agentsRoot();
    if (!root) return { ok: false, error: 'CloneFrame root unavailable' };
    const clean = String(name || '').replace(/[^\w .-]/g, '').trim();
    const dir = path.join(root, clean);
    if (!clean || !fs.existsSync(dir)) return { ok: false, error: 'agent not found' };
    const a = readAgent(dir, clean);
    let soul = ''; try { soul = fs.readFileSync(path.join(dir, 'neural_soul.md'), 'utf8'); } catch {}
    return { ok: true, ...a, soul };
  },

  localUpdate(name, patch = {}) {
    const g = this.localGet(name);
    if (!g.ok) return g;
    if (typeof patch.soul === 'string') fs.writeFileSync(path.join(g.dir, 'neural_soul.md'), patch.soul);
    const cfgPath = path.join(g.dir, 'config.json');
    const cfg = { ...g.config };
    for (const k of ['description', 'runtime', 'model', 'serverId', 'lastActive']) if (patch[k] !== undefined) cfg[k] = patch[k];
    if (patch.virtuals && typeof patch.virtuals === 'object') cfg.virtuals = { ...cfg.virtuals, ...patch.virtuals };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    return { ok: true, ...readAgent(g.dir, g.name) };
  },

  // never hard-deletes: archives into Agents/.archive
  localArchive(name) {
    const g = this.localGet(name);
    if (!g.ok) return g;
    const root = agentsRoot();
    const arch = path.join(root, '.archive');
    fs.mkdirSync(arch, { recursive: true });
    const dest = path.join(arch, g.name + '-' + Date.now());
    fs.renameSync(g.dir, dest);
    return { ok: true, archived: dest };
  },
};
export default Acp;

// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Admin Engine
//
// The Settings › ADMIN surface, exposed as a routed backend module. Three
// concerns, one small store:
//   (a) Agent Tools  — a capability registry the agent may (or may not) use.
//                      email.send / shell.run / web.fetch are seeded DISABLED;
//                      nothing is enabled until an operator explicitly opts in.
//   (b) Users        — a minimal local single-user profile (name, role).
//   (c) System       — read-only status: node version, uptime, config dir,
//                      *.json stores + sizes, a scheduler health flag, and a
//                      secrets-scrubbed tail of server.log.
//
// Zero dependencies (Node built-ins only). State persists to
// ~/.clone-frame-hub/admin.json (dir 0700, file 0600, tmp-write-then-rename).
// Read paths never write. Write paths return {ok} and never throw for expected
// failures. A corrupt/missing store degrades to empty — it never throws.
// Secrets are never persisted here, never returned, and scrubbed from logs.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { homedir, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';
import { scrubText } from './platform/redact.mjs';

// ── locations ────────────────────────────────────────────────────────────────
// CONFIG_DIR stays homedir-anchored: it is still the read root for listStores()/
// system()/schedulerHealthy()/logs() and the secret-scrub file reads. Only the
// admin.json store itself moved onto the shared port (below), which resolves its
// own directory through hubRoot() — byte-identical to CONFIG_DIR in production.
const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(homedir(), '.clone-frame-hub');
const SERVER_LOG = path.join(CONFIG_DIR, 'server.log');
const BRIDGE_TOKEN_FILE = path.join(CONFIG_DIR, 'bridge.token');
const TASKS_FILE = path.join(CONFIG_DIR, 'tasks.json');

const STORE_VERSION = 1;

// Scheduler is deemed unhealthy only if a *running* task is overdue by more
// than this grace window (tasks tick every 30s; 5min absorbs a slow run/LLM).
const SCHEDULER_GRACE_MS = 5 * 60_000;

// Tail at most this many bytes off the end of the log, regardless of `lines`.
const LOG_TAIL_MAX_BYTES = 1024 * 1024;
const LOG_MAX_LINES = 2000;

// ── built-in tool seeds (all DISABLED by default — opt-in only) ──────────────
const BUILTIN_TOOLS = [
  {
    name: 'email.send',
    kind: 'email',
    scopes: ['email:send'],
    description: 'Send outbound mail through the Email engine (SMTP).',
  },
  {
    name: 'shell.run',
    kind: 'shell',
    scopes: ['shell:exec'],
    description: 'Run shell commands (zsh) on this machine.',
  },
  {
    name: 'web.fetch',
    kind: 'http',
    scopes: ['net:fetch'],
    description: 'Make outbound HTTP(S) requests to arbitrary URLs.',
  },
];
const builtinId = (name) => `builtin:${name}`;
const BUILTIN_NAMES = new Set(BUILTIN_TOOLS.map((t) => t.name));

// ── persistence ──────────────────────────────────────────────────────────────
// Backed by the shared atomic JSON store: ~/.clone-frame-hub/admin.json,
// dir 0700 / file 0600, tmp-write-then-rename, read-per-call, never logs. The
// store only guarantees the top-level container; the built-in self-heal on read
// and the exact write projection below (normalizeTool / normalizeProfile and the
// whitelisted field maps) stay this module's job, exactly as before the port.
const store = openStore({ name: 'admin', version: STORE_VERSION, shape: { tools: [], profile: null }, root: hubRoot() });

// Read-only load. Normalizes on-disk data and ensures the built-in tools are
// present *in memory* — it never writes. Persistence of built-ins happens on
// the next write, so read paths stay pure. Corrupt/missing → empty defaults.
function loadStore() {
  const data = store.read(); // never throws; ENOENT/corrupt → {version, tools:[], profile:null}
  const rawTools = Array.isArray(data.tools) ? data.tools : [];
  const tools = [];
  const seen = new Set();
  for (const raw of rawTools) {
    const t = normalizeTool(raw);
    if (!t || seen.has(t.name)) continue;
    seen.add(t.name);
    tools.push(t);
  }
  // Self-heal: every built-in must exist (deduped by name), never as a copy.
  for (const seed of BUILTIN_TOOLS) {
    if (seen.has(seed.name)) continue;
    tools.push(makeBuiltinTool(seed));
    seen.add(seed.name);
  }
  const profile = normalizeProfile(data.profile);
  return { version: STORE_VERSION, tools, profile };
}

function saveStore(s) {
  // Project to exactly the known fields — never let a stray in-memory key (or a
  // hand-edited one) get persisted alongside the registry/profile. version is
  // kept first to preserve the exact on-disk key order; the store re-stamps it
  // (same STORE_VERSION value, same position) on write.
  store.write({
    version: STORE_VERSION,
    tools: s.tools.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      enabled: !!t.enabled,
      scopes: Array.isArray(t.scopes) ? t.scopes : [],
      isBuiltin: !!t.isBuiltin,
      description: t.description || '',
      createdAt: t.createdAt || null,
      updatedAt: t.updatedAt || null,
    })),
    profile: s.profile
      ? {
          id: s.profile.id,
          name: s.profile.name,
          role: s.profile.role,
          createdAt: s.profile.createdAt || null,
          updatedAt: s.profile.updatedAt || null,
        }
      : null,
  });
}

// ── normalization / shaping ──────────────────────────────────────────────────
function sanitizeSlug(v, fallback) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return s || fallback;
}

function sanitizeScopes(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of v) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[^a-z0-9:._*-]/g, '').slice(0, 64);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 32) break;
  }
  return out;
}

function makeBuiltinTool(seed) {
  const now = new Date().toISOString();
  return {
    id: builtinId(seed.name),
    name: seed.name,
    kind: seed.kind,
    enabled: false,
    scopes: [...seed.scopes],
    isBuiltin: true,
    description: seed.description,
    createdAt: now,
    updatedAt: now,
  };
}

// Coerces an untrusted on-disk record into the canonical tool shape. A built-in
// is identified by its reserved name, so its flag can't be forged away or faked.
function normalizeTool(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = sanitizeSlug(raw.name, '');
  if (!name) return null;
  const isBuiltin = BUILTIN_NAMES.has(name);
  const id = isBuiltin
    ? builtinId(name)
    : (typeof raw.id === 'string' && /^tool_[A-Za-z0-9_-]+$/.test(raw.id) ? raw.id : `tool_${randomUUID()}`);
  return {
    id,
    name,
    kind: sanitizeSlug(raw.kind, 'custom'),
    enabled: !!raw.enabled,
    scopes: sanitizeScopes(raw.scopes),
    isBuiltin,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 280) : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function defaultProfileName() {
  try {
    const u = userInfo();
    if (u && typeof u.username === 'string' && u.username.trim()) return u.username.trim();
  } catch { /* userInfo can throw on unusual environments */ }
  return 'Owner';
}

const ROLE_MAX_LEN = 40;
const NAME_MAX_LEN = 120;

// Returns a stored-profile object, or null when nothing valid is on disk (the
// synthesized default lives in `profileView`, keeping reads write-free).
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, NAME_MAX_LEN) : '';
  if (!name) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : 'local',
    name,
    role: typeof raw.role === 'string' && raw.role.trim() ? raw.role.trim().slice(0, ROLE_MAX_LEN) : 'owner',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

// The single local user, synthesized from the OS when none is stored yet.
function profileView(store) {
  const p = store.profile;
  if (p) return { id: p.id, name: p.name, role: p.role, updatedAt: p.updatedAt };
  return { id: 'local', name: defaultProfileName(), role: 'owner', updatedAt: null };
}

// Only whitelisted fields ever leave this module — no accidental secret echo.
function toolView(t) {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    enabled: !!t.enabled,
    scopes: Array.isArray(t.scopes) ? [...t.scopes] : [],
    isBuiltin: !!t.isBuiltin,
    description: t.description || '',
    createdAt: t.createdAt || null,
    updatedAt: t.updatedAt || null,
  };
}

// ── (a) Agent Tools ──────────────────────────────────────────────────────────
/** @returns {object[]} the tool registry (built-ins first, then custom, A→Z). */
function tools() {
  const store = loadStore();
  return store.tools
    .slice()
    .sort((a, b) => (Number(b.isBuiltin) - Number(a.isBuiltin)) || a.name.localeCompare(b.name))
    .map(toolView);
}

/** Enable/disable one tool by id. @returns {{ok:boolean, id?:string, enabled?:boolean, error?:string}} */
function setToolEnabled(id, enabled) {
  try {
    const key = String(id == null ? '' : id);
    if (!key) return { ok: false, error: 'setToolEnabled: id is required' };
    const store = loadStore();
    const tool = store.tools.find((t) => t.id === key);
    if (!tool) return { ok: false, error: 'setToolEnabled: tool not found' };
    tool.enabled = !!enabled;
    tool.updatedAt = new Date().toISOString();
    saveStore(store);
    return { ok: true, id: tool.id, enabled: tool.enabled };
  } catch (e) {
    return { ok: false, error: `setToolEnabled: ${e && e.message ? e.message : e}` };
  }
}

/** Register a custom tool (created DISABLED). @returns {{ok:boolean, id?:string, error?:string}} */
function addTool(input = {}) {
  try {
    const spec = input && typeof input === 'object' ? input : {};
    const name = sanitizeSlug(spec.name, '');
    if (!name) return { ok: false, error: 'addTool: name is required' };
    if (BUILTIN_NAMES.has(name)) return { ok: false, error: 'addTool: name is reserved by a built-in tool' };
    const store = loadStore();
    if (store.tools.some((t) => t.name === name)) {
      return { ok: false, error: 'addTool: a tool with that name already exists' };
    }
    const now = new Date().toISOString();
    const tool = {
      id: `tool_${randomUUID()}`,
      name,
      kind: sanitizeSlug(spec.kind, 'custom'),
      enabled: false, // new capabilities are never live until explicitly enabled
      scopes: sanitizeScopes(spec.scopes),
      isBuiltin: false,
      description: typeof spec.description === 'string' ? spec.description.slice(0, 280) : '',
      createdAt: now,
      updatedAt: now,
    };
    store.tools.push(tool);
    saveStore(store);
    return { ok: true, id: tool.id };
  } catch (e) {
    return { ok: false, error: `addTool: ${e && e.message ? e.message : e}` };
  }
}

/** Remove a custom tool by id. Built-ins are protected. @returns {{ok:boolean, error?:string}} */
function removeTool(id) {
  try {
    const key = String(id == null ? '' : id);
    if (!key) return { ok: false, error: 'removeTool: id is required' };
    const store = loadStore();
    const tool = store.tools.find((t) => t.id === key);
    if (!tool) return { ok: false, error: 'removeTool: tool not found' };
    if (tool.isBuiltin) return { ok: false, error: 'removeTool: built-in tool cannot be removed (disable it instead)' };
    store.tools = store.tools.filter((t) => t.id !== key);
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `removeTool: ${e && e.message ? e.message : e}` };
  }
}

// ── (b) Users ────────────────────────────────────────────────────────────────
/** @returns {object[]} the local single-user roster (always exactly one). */
function users() {
  return [profileView(loadStore())];
}

/** Update the local profile. @returns {{ok:boolean, user?:object, error?:string}} */
function setProfile(input = {}) {
  try {
    const spec = input && typeof input === 'object' ? input : {};
    const name = typeof spec.name === 'string' ? spec.name.trim().slice(0, NAME_MAX_LEN) : '';
    if (!name) return { ok: false, error: 'setProfile: name is required' };
    const store = loadStore();
    const now = new Date().toISOString();
    const prev = store.profile;
    store.profile = {
      id: (prev && prev.id) || 'local',
      name,
      role: typeof spec.role === 'string' && spec.role.trim()
        ? spec.role.trim().slice(0, ROLE_MAX_LEN)
        : (prev && prev.role) || 'owner',
      createdAt: (prev && prev.createdAt) || now,
      updatedAt: now,
    };
    saveStore(store);
    return { ok: true, user: profileView(store) };
  } catch (e) {
    return { ok: false, error: `setProfile: ${e && e.message ? e.message : e}` };
  }
}

// ── (c) System ───────────────────────────────────────────────────────────────
function listStores() {
  try {
    const entries = fs.readdirSync(CONFIG_DIR, { withFileTypes: true });
    const out = [];
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      let bytes = 0;
      try { bytes = fs.statSync(path.join(CONFIG_DIR, ent.name)).size; } catch { bytes = 0; }
      out.push({ name: ent.name, bytes });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return []; // missing/inaccessible config dir → no stores, never throw
  }
}

// Decoupled, side-effect-free scheduler probe: read the tasks store from disk
// and flag it unhealthy only when a *running* task is overdue past the grace
// window (a strong signal the in-process tick has stalled). Missing/paused/
// corrupt all read as healthy — we don't raise false alarms.
function schedulerHealthy() {
  try {
    const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    if (!data || !Array.isArray(data.tasks)) return true;
    if (data.pausedAll) return true;
    const cutoff = Date.now() - SCHEDULER_GRACE_MS;
    for (const t of data.tasks) {
      if (!t || t.state !== 'running' || !t.nextRunAt) continue;
      const due = new Date(t.nextRunAt).getTime();
      if (Number.isFinite(due) && due < cutoff) return false;
    }
    return true;
  } catch {
    return true; // no tasks store yet, or unreadable — nothing indicates a stall
  }
}

function readAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch { /* fall through */ }
  return '0.0.0';
}

/** Read-only system status. @returns {{node,uptimeSec,configDir,stores,schedulerHealthy,version}} */
function system() {
  return {
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    configDir: CONFIG_DIR,
    stores: listStores(),
    schedulerHealthy: schedulerHealthy(),
    version: readAppVersion(),
  };
}

// ── logs (secrets-scrubbed tail) ─────────────────────────────────────────────
// ANSI stripping + the secret-shaped SCRUB_PATTERNS + scrubLine all moved onto
// platform/redact.mjs's scrubText (T-024). The port is a proven superset of the
// old local patterns — same families (PEM, sk-ant/sk-, JWT, AKIA, ghp_, xox,
// bearer, token=, key:/key= pairs, authorization) plus a truncated-PEM fallback
// the local copy lacked — so a scrubbed log line can never regain a secret.
// Only the machine-local LITERAL gathering below stays here: it is fs/env I/O
// the pure redact port deliberately does not do; its output feeds scrubText via
// the `literals` option (redacted longest-first, exactly as scrubLine did).

// Literal secrets present on this machine, gathered ONLY to redact them out of
// log lines. Never returned, never logged. Best-effort and failure-tolerant.
function collectLiteralSecrets() {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.length >= 8) out.push(v.trim()); };
  try { push(fs.readFileSync(BRIDGE_TOKEN_FILE, 'utf8').trim()); } catch { /* no token file */ }
  push(process.env.ANTHROPIC_API_KEY);
  for (const f of [path.join(homedir(), '.env.local'), path.join(homedir(), '.env')]) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/m);
      if (m) push(m[1].replace(/^["']|["']$/g, '').trim());
    } catch { /* file absent */ }
  }
  // Longest-first so a superstring is redacted before any embedded substring.
  return [...new Set(out.filter(Boolean))].sort((a, b) => b.length - a.length);
}

// Reads at most the trailing LOG_TAIL_MAX_BYTES of a file without slurping the
// whole thing — safe even if the log grows large.
function tailBytes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = size > LOG_TAIL_MAX_BYTES ? size - LOG_TAIL_MAX_BYTES : 0;
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Last N scrubbed lines of server.log. @returns {string[]} (empty if no log). */
function logs(input = {}) {
  let n = 80;
  const req = input && typeof input === 'object' ? Number(input.lines) : Number(input);
  if (Number.isFinite(req)) n = Math.max(1, Math.min(LOG_MAX_LINES, Math.floor(req)));
  let text;
  try {
    text = tailBytes(SERVER_LOG);
  } catch {
    return []; // ENOENT or unreadable — no logs to show
  }
  if (!text) return [];
  const literals = collectLiteralSecrets();
  const rawLines = text.split(/\r\n|\r|\n/);
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
  return rawLines.slice(-n).map((l) => scrubText(l, { literals }));
}

// ── export surface (routed by the bridge as Admin.<fn>(...args)) ─────────────
export const Admin = {
  tools,
  setToolEnabled,
  addTool,
  removeTool,
  users,
  setProfile,
  system,
  logs,
};

export default Admin;

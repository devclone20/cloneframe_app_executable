// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — iT remote hosts (SSH transport)
// OUR host manager + safe argv builder for reaching the user's own servers/VMs.
// We do NOT depend on tmux; ssh here is only the transport. The bridge NEVER reads,
// stores, or transmits private keys or passphrases — auth is delegated to the user's
// ssh-agent + ~/.ssh/config. Only non-secret host metadata is persisted (0600).
//
// Layer 0 of the iT remote/persistence plan: substrate only. No PTY is spawned here;
// the interactive session (Layer 1) reuses pty.mjs via op=ssh, calling _connectArgs()
// server-side so a hostname/IP never crosses into the client.
// ─────────────────────────────────────────────────────────────────────────────
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Permissions from './permissions.mjs';
import { isDestructive } from './platform/shell-guard.mjs';

const HOME = homedir();
const DIR = path.join(HOME, '.clone-frame-hub');
const FILE = path.join(DIR, 'ssh.json');
const SSH_DIR = path.join(HOME, '.ssh');
const CONFIG_PATH = path.join(SSH_DIR, 'config');
const KNOWN_HOSTS = path.join(SSH_DIR, 'known_hosts');

// Options a user may attach to a host. Deliberately excludes every command-executing or
// forwarding option (ProxyCommand/LocalCommand/ProxyJump/Match/*Forward/Include) — those are
// local-RCE or blast-radius traps and are NEVER accepted, even from ssh.json on read.
const OPTION_ALLOW = new Set([
  'serveraliveinterval', 'serveralivecountmax', 'connecttimeout', 'connectionattempts',
  'tcpkeepalive', 'compression', 'ipqos', 'addressfamily',
]);

// ── validators (reject-by-default charsets; a bad field fails the whole host) ────────────────
const RE_ALIAS = /^[A-Za-z0-9_.-]{1,64}$/;
const RE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const RE_HOST = /^[A-Za-z0-9._:-]{1,255}$/;           // DNS label set or IP (incl. IPv6 colons)
const RE_OPTVAL = /^[A-Za-z0-9._:/-]{1,64}$/;         // no spaces, no shell metacharacters
const RE_SESSION = /^[A-Za-z0-9_-]{1,64}$/;           // used by later layers (keeper ids)

function vAlias(s) { return RE_ALIAS.test(String(s || '')); }
function vUser(s) { return s == null || s === '' || RE_USER.test(String(s)); }
function vHost(s) { s = String(s || ''); return RE_HOST.test(s) && s[0] !== '-'; }   // never starts with '-'
function vPort(n) { n = Number(n); return Number.isInteger(n) && n >= 1 && n <= 65535; }

// Resolve a stored identityFile PATH to an absolute path INSIDE ~/.ssh, or null if unsafe.
// We only ever pass this path to ssh's -i; the bridge never opens the key itself.
function resolveIdentity(p) {
  if (!p) return null;
  let s = String(p);
  if (s.startsWith('~/')) s = path.join(HOME, s.slice(2));
  const abs = path.resolve(s);
  const base = SSH_DIR + path.sep;
  return (abs === SSH_DIR || abs.startsWith(base)) ? abs : null;
}

// Keep only allowlisted, metacharacter-free options. Applied on BOTH write and read.
function sanitizeOptions(opts) {
  const out = {};
  if (!opts || typeof opts !== 'object') return out;
  for (const [k, v] of Object.entries(opts)) {
    const key = String(k).toLowerCase();
    if (OPTION_ALLOW.has(key) && RE_OPTVAL.test(String(v))) out[k] = String(v);
  }
  return out;
}

// ── persistence (atomic, 0600 in a 0700 dir — same idiom as permissions.mjs / servers.mjs) ──
function load() {
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!o || !Array.isArray(o.hosts)) return { hosts: [] };
    // Re-sanitize options on read: an attacker who edited ssh.json must not smuggle a bad option.
    o.hosts = o.hosts.map((h) => ({ ...h, options: sanitizeOptions(h.options) }));
    return o;
  } catch { return { hosts: [] }; }
}
function save(o) {
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return true;
  } catch { return false; }
}

// Validate + normalize an incoming host record. Returns { ok, host } or { ok:false, error }.
function normalize(input) {
  const h = input || {};
  if (!vAlias(h.alias)) return { ok: false, error: 'invalid alias (use [A-Za-z0-9_.-], 1-64)' };
  if (!vHost(h.hostname)) return { ok: false, error: 'invalid hostname' };
  if (!vUser(h.user)) return { ok: false, error: 'invalid user' };
  const port = h.port == null || h.port === '' ? 22 : h.port;
  if (!vPort(port)) return { ok: false, error: 'invalid port (1-65535)' };
  if (h.identityFile && !resolveIdentity(h.identityFile)) return { ok: false, error: 'identityFile must live under ~/.ssh' };
  return {
    ok: true,
    host: {
      alias: String(h.alias),
      hostname: String(h.hostname),
      user: h.user ? String(h.user) : '',
      port: Number(port),
      identityFile: h.identityFile ? String(h.identityFile) : '',
      options: sanitizeOptions(h.options),
      forwardAgent: false,          // never implied; a future opt-in flips this deliberately
      forwardX11: false,
      sensitive: !!h.sensitive,     // mask the hostname in list() (e.g. a prod box)
      persist: !!h.persist,         // Layer 3 keeper opt-in
    },
  };
}

// Public shape — never leaks secrets; masks the hostname of a host flagged sensitive.
function pub(h) {
  return {
    alias: h.alias, user: h.user, port: h.port,
    hostname: h.sensitive ? '••••••••' : h.hostname,
    hasIdentity: !!h.identityFile, sensitive: !!h.sensitive, persist: !!h.persist,
  };
}

function find(hosts, alias) { return hosts.find((h) => h.alias === alias) || null; }

// Catastrophic-command guard for the scripted run path — the single shared
// isDestructive() from platform/shell-guard.mjs (a documented superset of the
// legacy pty/hub-bridge copies: same safe commands pass, more catastrophic
// patterns are caught). See tests/shell-guard-port.test.mjs.

// ── safe argv builder (server-only) ──────────────────────────────────────────────────────────
// Build the ssh argument ARRAY for a normalized host. Every -o below is a fixed constant; only
// user/port/hostname/identity are validated variables. `--` precedes the hostname so a value can
// never be reparsed as an option, and we never construct `user@host`.
function argvFor(h, opts = {}) {
  const o = opts || {};
  const args = [
    '-F', CONFIG_PATH,
    '-o', 'StrictHostKeyChecking=' + (o.strict || 'accept-new'),
    '-o', 'UserKnownHostsFile=' + KNOWN_HOSTS,
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  ];
  const id = resolveIdentity(h.identityFile);
  if (id) args.push('-o', 'IdentitiesOnly=yes', '-i', id);
  // Automation (non-interactive) path is agent/publickey-only and never prompts.
  if (!o.interactive) args.push('-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no');
  for (const [k, v] of Object.entries(sanitizeOptions(h.options))) args.push('-o', `${k}=${v}`);
  if (o.tty) args.push('-t');                       // force remote PTY (keeper/run needs it)
  if (h.user) args.push('-l', h.user);
  if (h.port && h.port !== 22) args.push('-p', String(h.port));
  args.push('--', h.hostname);
  // remoteCommand, when present, is a SINGLE argv element run by the remote login shell.
  if (o.remoteCommand) args.push(String(o.remoteCommand));
  return args;
}

// ── public API (RPC-reachable; underscore-prefixed fns are server-only) ────────────────────────
export const Ssh = {
  /** List saved hosts (secret-masked). */
  list() { return { ok: true, hosts: load().hosts.map(pub) }; },

  /** Add or replace a saved host. Validates every field; never stores keys/passwords. */
  add(input) {
    const n = normalize(input);
    if (!n.ok) return n;
    const db = load();
    const i = db.hosts.findIndex((h) => h.alias === n.host.alias);
    if (i >= 0) db.hosts[i] = n.host; else db.hosts.push(n.host);
    if (!save(db)) return { ok: false, error: 'could not save' };
    return { ok: true, host: pub(n.host) };
  },

  /** Patch an existing host (same validation as add). */
  update(alias, patch) {
    if (!vAlias(alias)) return { ok: false, error: 'invalid alias' };
    const db = load();
    const cur = find(db.hosts, alias);
    if (!cur) return { ok: false, error: 'no such host' };
    const n = normalize({ ...cur, ...patch, alias });
    if (!n.ok) return n;
    db.hosts[db.hosts.findIndex((h) => h.alias === alias)] = n.host;
    if (!save(db)) return { ok: false, error: 'could not save' };
    return { ok: true, host: pub(n.host) };
  },

  /** Forget a saved host. */
  remove(alias) {
    if (!vAlias(alias)) return { ok: false, error: 'invalid alias' };
    const db = load();
    const before = db.hosts.length;
    db.hosts = db.hosts.filter((h) => h.alias !== alias);
    if (db.hosts.length === before) return { ok: false, error: 'no such host' };
    if (!save(db)) return { ok: false, error: 'could not save' };
    return { ok: true };
  },

  /** Host-key fingerprints (SHA256) for a saved alias — for first-connect confirmation. */
  async fingerprint(alias) {
    if (!vAlias(alias)) return { ok: false, error: 'invalid alias' };
    const h = find(load().hosts, alias);
    if (!h) return { ok: false, error: 'no such host' };
    const scanArgs = ['-T', '8', '-t', 'ed25519,ecdsa,rsa'];
    if (h.port && h.port !== 22) scanArgs.push('-p', String(h.port));
    scanArgs.push('--', h.hostname);
    const scanned = await _spawnCapped('ssh-keyscan', scanArgs, '', 12000);
    if (!scanned.ok || !scanned.out.trim()) return { ok: false, error: 'could not reach host key' };
    const fp = await _spawnCapped('ssh-keygen', ['-l', '-f', '-'], scanned.out, 8000);
    if (!fp.ok) return { ok: false, error: 'could not hash key' };
    const lines = fp.out.trim().split('\n').filter(Boolean).map((l) => {
      const p = l.split(/\s+/); return { bits: p[0], sha256: p[1], type: (p[p.length - 1] || '').replace(/[()]/g, '') };
    });
    return { ok: true, fingerprints: lines };
  },

  /** Remove a host's line(s) from ~/.ssh/known_hosts (after a verified key change). */
  async forgetKey(alias) {
    if (!vAlias(alias)) return { ok: false, error: 'invalid alias' };
    const h = find(load().hosts, alias);
    if (!h) return { ok: false, error: 'no such host' };
    const r = await _spawnCapped('ssh-keygen', ['-R', h.hostname, '-f', KNOWN_HOSTS], '', 8000);
    return r.ok ? { ok: true } : { ok: false, error: 'ssh-keygen -R failed' };
  },

  /** Run ONE command on a saved host and capture output — non-interactive (agent/publickey auth),
   *  blocklist-gated, single line, capped. This is the scripted automation path. */
  async run(alias, command) {
    if (!Permissions.can('ssh')) return { ok: false, error: 'ssh permission is off' };
    if (!vAlias(alias)) return { ok: false, error: 'invalid alias' };
    const h = find(load().hosts, String(alias));
    if (!h) return { ok: false, error: 'no such host' };
    const cmd = String(command || '');
    if (!cmd.trim()) return { ok: false, error: 'empty command' };
    if (cmd.length > 2000) return { ok: false, error: 'command too long (max 2000)' };
    if (/[\r\n]/.test(cmd)) return { ok: false, error: 'one line only (no newlines)' };
    if (isDestructive(cmd)) return { ok: false, error: 'refused: catastrophic pattern blocked' };
    const args = argvFor(h, { interactive: false, tty: false, remoteCommand: cmd });
    const r = await _spawnCapped('ssh', args, '', 60000);
    return { ok: r.ok, out: r.out, err: r.err, code: r.ok ? 0 : 1 };
  },

  // ── server-only (never callable over RPC) ──
  /** Resolve a SAVED alias to a safe ssh argv (used by op=ssh in dispatchStream). */
  _connectArgs(alias, opts) {
    const h = find(load().hosts, String(alias || ''));
    if (!h) return null;
    return { cmd: 'ssh', args: argvFor(h, opts || { interactive: true }) };
  },
  /** Pure argv builder from a raw (already-normalized) host object — for tests/internal use. */
  _argvFor: argvFor,
  _normalize: normalize,
};

// Small argv-only, output-capped spawn (mirrors servers.mjs discipline; never a shell string).
function _spawnCapped(cmd, args, stdin, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, out: '', err: String(e && e.message || e) }); }
    const cap = 256 * 1024;
    const to = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch {} resolve({ ok: false, out, err: 'timeout' }); } }, timeoutMs || 10000);
    child.stdout.on('data', (d) => { if (out.length < cap) out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (err.length < cap) err += d.toString('utf8'); });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(to); resolve({ ok: false, out, err: String(e && e.message || e) }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(to); resolve({ ok: code === 0, out, err }); } });
    if (stdin) { try { child.stdin.write(stdin); } catch {} }
    try { child.stdin.end(); } catch {}
  });
}

export default Ssh;

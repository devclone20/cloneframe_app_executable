// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — servers
// Manage the owner's ONLINE SERVERS (e.g. a DigitalOcean droplet) from the app:
// connect a server, deploy the agent, start/stop/restart it, one-click automations,
// view logs, and (advanced) provision a brand-new droplet. Also backs the Code
// terminal tool so an LLM can operate the droplet by prompt.
//
// SECURITY: secrets (SSH private-key PATH, DigitalOcean token) are persisted 0o600
// but NEVER returned to the client — every server leaves this module through
// _public(), which masks them. Command execution is spawn(argv) only — no shell,
// no string interpolation into sh -c — so there is no LOCAL shell-injection surface.
// Zero deps: node built-ins + global fetch. Binds nothing; the bridge owns the port.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

const CMD_TIMEOUT = 60_000;        // per SSH command
const DEPLOY_TIMEOUT = 180_000;    // file sync / deploy
const FETCH_TIMEOUT = 15_000;      // DigitalOcean API
const OUT_CAP = 256 * 1024;        // 256 KiB max captured per command
const SHORT = 4_000;               // step-log excerpt length

// The agent lives on the server as EITHER a systemd unit `clone-agent.service`
// OR a docker container named `clone-agent`. Automations try systemd first, then
// docker, then degrade gracefully. deployAgent lands files in ~/clone-agent/<name>.
const SVC = 'clone-agent';

// ── persistence ───────────────────────────────────────────────────────────────
// Backed by the shared atomic JSON store: ~/.clone-frame-hub/servers.json, dir
// 0700 / file 0600, tmp-write-then-rename, read-per-call (no cached singleton —
// fixes the old `let store = load()`-at-import stale read), never logs. The store
// guarantees only the top-level `{ servers }` container; the per-server coercion
// (Array.isArray guard below, secret-masking in _public) stays this module's job.
// save() keeps its swallow-to-false contract at the call site because the port
// throws on write failure and existing callers ignore the boolean, expecting a
// failed write to be silent rather than to flip their {ok:true} result.
const store = openStore({ name: 'servers', version: 1, shape: { servers: [] }, root: hubRoot() });

function load() {
  const s = store.read();
  if (!Array.isArray(s.servers)) s.servers = [];
  return s;
}
function save(o) {
  try { store.write(o); return true; }
  catch { return false; }
}

const _id = () => randomBytes(9).toString('hex');
const _find = (st, id) => st.servers.find((x) => x.id === String(id));
const _short = (s) => String(s || '').slice(0, SHORT);
const _shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // POSIX single-quote for shell-parsed strings (rsync -e)

// The ONLY exit for a server record. Masks every secret; shows the SSH key by
// basename only and the DO token as a boolean. Host is the owner's own machine.
function _public(s) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    provider: s.provider,
    host: s.host || '',
    user: s.user || 'root',
    port: Number(s.port) || 22,
    keyPath: s.keyPath ? path.basename(s.keyPath) : '',   // basename only — never the full path
    hasKey: !!s.keyPath,
    hasToken: !!s.doToken,
    dropletId: s.dropletId || null,
    createdAt: s.createdAt || 0,
  };
}

// ── spawn helper: argv only, no shell, output-capped, timed-out, killed on cap/timeout
function _spawnCapped(file, args, { timeout = CMD_TIMEOUT, cap = OUT_CAP, input = null } = {}) {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0), truncated = false, timedOut = false, spawnError = null, done = false;
    let child;
    try { child = spawn(file, args, { shell: false, windowsHide: true }); }
    catch (e) { resolve({ code: -1, output: '', truncated: false, timedOut: false, spawnError: e.message }); return; }
    const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code, output: out.toString('utf8'), truncated, timedOut, spawnError }); };
    const t = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeout);
    const onData = (b) => {
      if (truncated) return;
      if (out.length + b.length > cap) { out = Buffer.concat([out, b.subarray(0, Math.max(0, cap - out.length))]); truncated = true; try { child.kill('SIGKILL'); } catch {} }
      else out = Buffer.concat([out, b]);
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', (e) => { spawnError = e.message; finish(-1); });
    child.on('close', (code) => finish(code == null ? -1 : code));
    if (input != null && child.stdin) { try { child.stdin.write(input); child.stdin.end(); } catch {} }
  });
}

// Build the ssh argv. `remoteCommand` is a SINGLE argv element — ssh hands it to the
// REMOTE shell (expected). No local shell is ever involved, so nothing the caller
// passes can escape into THIS machine. BatchMode=yes prevents a password prompt from
// hanging the spawn until timeout.
function _sshArgs(s, remoteCommand) {
  const args = [];
  if (s.keyPath) args.push('-i', s.keyPath);
  args.push('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes');
  const port = Number(s.port) || 22;
  if (port !== 22) args.push('-p', String(port));
  args.push(`${s.user || 'root'}@${s.host}`, remoteCommand);
  return args;
}
async function _ssh(s, remoteCommand, opts = {}) {
  if (!s.host) return { ok: false, exit: -1, output: 'server has no host yet', timedOut: false };
  const r = await _spawnCapped('ssh', _sshArgs(s, remoteCommand), opts);
  if (r.spawnError) return { ok: false, exit: -1, output: 'ssh failed: ' + r.spawnError, timedOut: r.timedOut, spawnError: r.spawnError };
  return { ok: r.code === 0, exit: r.code, output: r.output, timedOut: r.timedOut, truncated: r.truncated };
}

// ── DigitalOcean v2 API. Token read from the stored record, never from the client.
function _doFetch(method, endpoint, token, body) {
  return (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
    try {
      const r = await fetch('https://api.digitalocean.com' + endpoint, {
        method,
        signal: ctl.signal,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json' },
        body: body != null ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
      if (!r.ok) return { ok: false, status: r.status, error: (data && (data.message || data.error)) || ('DigitalOcean API ' + r.status), data };
      return { ok: true, status: r.status, data };
    } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'DigitalOcean API timeout' : e.message }; }
    finally { clearTimeout(t); }
  })();
}
function _publicIPv4(d) {
  try { const v4 = (d.networks && d.networks.v4) || []; const pub = v4.find((n) => n.type === 'public'); return pub ? pub.ip_address : ''; }
  catch { return ''; }
}

// ── one-click automations ────────────────────────────────────────────────────
// Single source of truth: the UI renders a button per item; runAutomation() maps
// key → REMOTE script. Every service/container op tries systemd, then docker.
const AUTOMATIONS = [
  { key: 'status',        label: 'Status',          desc: 'Uptime, running containers, memory and disk',       danger: false },
  { key: 'start_agent',   label: 'Start agent',     desc: 'Start the clone-agent service or container',        danger: false },
  { key: 'stop_agent',    label: 'Stop agent',      desc: 'Stop the clone-agent service or container',         danger: false },
  { key: 'restart_agent', label: 'Restart agent',   desc: 'Restart the clone-agent service or container',      danger: false },
  { key: 'agent_logs',    label: 'Agent logs',      desc: 'Last 200 log lines from the agent',                 danger: false },
  { key: 'update',        label: 'Update & restart',desc: 'git pull the agent, then restart it',               danger: false },
  { key: 'install_docker',label: 'Install Docker',  desc: 'Install the Docker engine if it is missing',        danger: false },
  { key: 'reboot',        label: 'Reboot server',   desc: 'Reboot the whole machine',                          danger: true  },
];

// systemd-or-docker verb (start | stop | restart map 1:1 across systemctl and docker).
const svcAction = (verb) =>
  `if systemctl list-unit-files 2>/dev/null | grep -q '^${SVC}\\.service'; then systemctl ${verb} ${SVC} && echo '${SVC}: ${verb} via systemd'; systemctl is-active ${SVC} 2>/dev/null; ` +
  `elif command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx '${SVC}'; then docker ${verb} ${SVC} && echo '${SVC}: ${verb} via docker'; ` +
  `else echo 'no ${SVC} systemd unit or docker container found'; exit 1; fi`;

const REMOTE = {
  status:
    `echo '# uptime'; uptime; echo; ` +
    `echo '# ${SVC}'; systemctl is-active ${SVC} 2>/dev/null || echo '(no systemd unit)'; echo; ` +
    `echo '# docker'; docker ps 2>/dev/null || echo '(docker not installed)'; echo; ` +
    `echo '# memory'; free -h 2>/dev/null || echo '(free unavailable)'; echo; ` +
    `echo '# disk'; df -h / 2>/dev/null`,
  start_agent: svcAction('start'),
  stop_agent: svcAction('stop'),
  restart_agent: svcAction('restart'),
  agent_logs:
    `if systemctl list-unit-files 2>/dev/null | grep -q '^${SVC}\\.service'; then journalctl -u ${SVC} -n 200 --no-pager 2>&1; ` +
    `elif command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx '${SVC}'; then docker logs --tail 200 ${SVC} 2>&1; ` +
    `else echo 'no ${SVC} logs found'; exit 1; fi`,
  update:
    `D=$(ls -d ~/clone-agent/*/ 2>/dev/null | head -1); [ -n "$D" ] || D=~/clone-agent; ` +
    `cd "$D" 2>/dev/null || { echo 'no ~/clone-agent directory'; exit 1; }; echo "updating $D"; ` +
    `if [ -d .git ]; then git pull --ff-only 2>&1; else echo '(not a git checkout — skipping pull)'; fi; ` +
    svcAction('restart'),
  install_docker:
    `if command -v docker >/dev/null 2>&1; then echo 'docker already installed'; docker --version; ` +
    `else curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh && systemctl enable --now docker 2>/dev/null; docker --version; fi`,
  reboot: `echo 'rebooting…'; (reboot || shutdown -r now) 2>&1`,
};

// start script for a freshly-deployed agent dir (`safe` is already sanitized to [A-Za-z0-9._-]).
const startScript = (safe) =>
  `cd ~/clone-agent/${safe} 2>/dev/null || { echo 'deploy dir missing'; exit 1; }; ` +
  `if [ -f start.sh ]; then bash start.sh 2>&1; ` +
  `elif [ -f docker-compose.yml ] && command -v docker >/dev/null 2>&1; then docker compose up -d 2>&1; ` +
  `else ` + svcAction('start') + `; fi`;

// ── file sync helpers (used by deployAgent) ──────────────────────────────────
function _rsync(s, localDir, remoteDir) {
  const rsh = ['ssh'];
  if (s.keyPath) rsh.push('-i', _shq(s.keyPath)); // rsync shell-parses the -e string → quote the key path (spaces)
  rsh.push('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes');
  const port = Number(s.port) || 22;
  if (port !== 22) rsh.push('-p', String(port));
  const src = localDir.replace(/\/?$/, '/');                       // trailing slash → copy CONTENTS
  const dest = `${s.user || 'root'}@${s.host}:${remoteDir}/`;      // home-relative remote path
  return _spawnCapped('rsync', ['-az', '-e', rsh.join(' '), src, dest], { timeout: DEPLOY_TIMEOUT });
}
// Fallback when rsync is absent: tar the tree locally and untar over the ssh pipe.
// Piped entirely in Node (no shell) — local tar stdout → remote `tar x` stdin.
function _tarOverSsh(s, localDir, remoteDir) {
  return new Promise((resolve) => {
    const remoteCmd = `mkdir -p ${remoteDir} && tar xzf - -C ${remoteDir}`;
    let out = Buffer.alloc(0), done = false, tar, ssh;
    const finish = (code, err) => { if (done) return; done = true; clearTimeout(t); resolve({ code, output: err ? String(err) + '\n' + out.toString('utf8') : out.toString('utf8') }); };
    try {
      tar = spawn('tar', ['czf', '-', '-C', localDir, '.'], { shell: false, windowsHide: true });
      ssh = spawn('ssh', _sshArgs(s, remoteCmd), { shell: false, windowsHide: true });
    } catch (e) { resolve({ code: -1, output: 'spawn failed: ' + e.message }); return; }
    const t = setTimeout(() => { try { tar.kill('SIGKILL'); } catch {} try { ssh.kill('SIGKILL'); } catch {} finish(-1, 'timeout'); }, DEPLOY_TIMEOUT);
    tar.on('error', (e) => finish(-1, 'tar: ' + e.message));
    ssh.on('error', (e) => finish(-1, 'ssh: ' + e.message));
    // EPIPE when ssh exits early is emitted ASYNC on stdin — without a listener it would
    // crash the whole (single-writer) bridge process. Swallow it; the close handler reports.
    if (ssh.stdin) ssh.stdin.on('error', () => {});
    if (tar.stdin) tar.stdin.on('error', () => {});
    tar.stdout.on('data', (d) => { try { ssh.stdin.write(d); } catch {} });
    tar.stdout.on('end', () => { try { ssh.stdin.end(); } catch {} });
    const grab = (d) => { if (out.length < OUT_CAP) out = Buffer.concat([out, d]); };
    ssh.stdout.on('data', grab);
    ssh.stderr.on('data', grab);
    ssh.on('close', (code) => finish(code == null ? -1 : code));
  });
}

// ── public API (each fn wrapped, never throws) ───────────────────────────────
function list() {
  try { return { ok: true, servers: load().servers.map(_public) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function get(id) {
  try { const s = _find(load(), id); return s ? { ok: true, server: _public(s) } : { ok: false, error: 'not found' }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function add(cfg = {}) {
  try {
    const name = String(cfg.name || '').trim();
    if (!name) return { ok: false, error: 'name required' };
    const host = String(cfg.host || '').trim();
    const doToken = cfg.doToken ? String(cfg.doToken) : '';
    // Any host the owner gives is allowed (it's their machine). We only require that
    // there IS a target: a host to reach, or a DO token to provision one later.
    if (!host && !doToken) return { ok: false, error: 'host required (or provider + doToken to provision)' };
    const provider = cfg.provider || (host ? 'ssh' : 'digitalocean');
    const rec = {
      id: _id(),
      name,
      provider,
      host,
      user: String(cfg.user || 'root'),
      keyPath: String(cfg.keyPath || ''),
      port: Number(cfg.port) || 22,
      doToken,
      dropletId: cfg.dropletId || null,
      createdAt: Date.now(),
    };
    const st = load();
    st.servers.push(rec);
    save(st);
    return { ok: true, server: _public(rec) };
  } catch (e) { return { ok: false, error: e.message }; }
}

function update(id, patch = {}) {
  try {
    const st = load();
    const s = _find(st, id);
    if (!s) return { ok: false, error: 'not found' };
    const allowed = ['name', 'user', 'keyPath', 'port', 'doToken', 'host', 'dropletId'];
    for (const k of allowed) {
      if (!(k in patch)) continue;
      if (k === 'port') s.port = Number(patch.port) || 22;
      else if (k === 'name' || k === 'user' || k === 'keyPath' || k === 'host') s[k] = String(patch[k] || '');
      else s[k] = patch[k];
    }
    save(st);
    return { ok: true, server: _public(s) };
  } catch (e) { return { ok: false, error: e.message }; }
}

function remove(id) {
  try {
    const st = load();
    const before = st.servers.length;
    st.servers = st.servers.filter((x) => x.id !== String(id));
    const removed = st.servers.length < before;
    if (removed) save(st);
    return { ok: true, removed };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function test(id) {
  try {
    const s = _find(load(), id);
    if (!s) return { ok: true, reachable: false, detail: 'server not found' };
    if (!s.host) return { ok: true, reachable: false, detail: 'no host set yet' };
    const r = await _ssh(s, 'echo cfhub-ok');
    const reachable = r.exit === 0 && String(r.output).includes('cfhub-ok');
    const detail = reachable ? 'reachable' : (r.timedOut ? 'timed out' : _short(r.output) || 'unreachable');
    return { ok: true, reachable, detail };
  } catch (e) { return { ok: true, reachable: false, detail: e.message }; }
}

// The power primitive the Code agent tool calls. `cmd` is a SINGLE argv element to
// ssh; the remote shell runs it. ok:true means we ran it — inspect `exit` for result.
async function run(id, cmd) {
  try {
    const s = _find(load(), id);
    if (!s) return { ok: false, error: 'server not found' };
    if (!s.host) return { ok: false, error: 'server has no host yet' };
    const r = await _ssh(s, String(cmd || ''));
    if (r.spawnError) return { ok: false, error: r.output };
    return { ok: true, output: r.output, exit: r.exit, truncated: !!r.truncated, timedOut: !!r.timedOut };
  } catch (e) { return { ok: false, error: e.message }; }
}

function automations() {
  return { ok: true, items: AUTOMATIONS.map((a) => ({ ...a })) };
}

async function runAutomation(id, key) {
  try {
    const script = REMOTE[String(key)];
    if (!script) return { ok: false, error: 'unknown automation: ' + key };
    const r = await run(id, script);
    return { ...r, key };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function deployAgent(id, opts = {}) {
  try {
    const s = _find(load(), id);
    if (!s) return { ok: false, error: 'server not found' };
    if (!s.host) return { ok: false, error: 'server has no host yet (provision/boot first)' };
    const safe = String(opts.name || '').replace(/[^A-Za-z0-9._-]/g, '');
    if (!safe || safe === '.' || safe === '..' || safe.includes('..')) return { ok: false, error: 'invalid agent name' };
    // Default the source to the app's own agent folder (~/CloneFrame/Agents/<name>) so the
    // LAB "Send my agent" button and the server_deploy tool work with no localDir argument.
    let localDir = String(opts.localDir || '');
    if (!localDir) {
      try { const m = await import('./folders.mjs'); const F = m.Folders || m.default; const r = F && F.agentDir(safe); if (r && r.ok && r.dir) localDir = r.dir; } catch {}
    }
    if (!localDir) return { ok: false, error: 'no source folder — create the agent under Folders → Agents, or pass localDir' };
    let st; try { st = fs.statSync(localDir); } catch { return { ok: false, error: 'source folder not found: ' + localDir }; }
    if (!st.isDirectory()) return { ok: false, error: 'source is not a directory' };

    const remoteDir = `clone-agent/${safe}`;
    const steps = [];

    const mk = await _ssh(s, `mkdir -p ~/${remoteDir}`);
    steps.push({ step: 'mkdir', exit: mk.exit, output: _short(mk.output) });
    if (mk.exit !== 0) return { ok: false, steps, error: 'could not create remote dir' };

    const hasRsync = (await _spawnCapped('rsync', ['--version'], { timeout: 5_000 })).code === 0;
    const sync = hasRsync ? await _rsync(s, localDir, remoteDir) : await _tarOverSsh(s, localDir, remoteDir);
    steps.push({ step: 'sync', method: hasRsync ? 'rsync' : 'tar', exit: sync.code, output: _short(sync.output) });
    if (sync.code !== 0) return { ok: false, steps, error: 'file sync failed' };

    const start = await _ssh(s, startScript(safe));
    steps.push({ step: 'start', exit: start.exit, output: _short(start.output) });

    return { ok: true, steps };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function provision(cfg = {}) {
  try {
    const name = String(cfg.name || '').trim();
    if (!name) return { ok: false, error: 'name required' };
    // The client NEVER sends secrets — read the DO token from a stored server record.
    let token = cfg.doToken ? String(cfg.doToken) : '';
    if (!token) { const wt = load().servers.find((x) => x.doToken); if (wt) token = wt.doToken; }
    if (!token) return { ok: false, error: 'no DigitalOcean token — add one to a server in Settings → Servers first' };
    const body = {
      name,
      region: cfg.region || 'nyc1',
      size: cfg.size || 's-1vcpu-1gb',
      image: cfg.image || 'ubuntu-24-04-x64',
    };
    // Attach the account's SSH keys so the droplet boots with key auth (else it's unreachable).
    let sshKeys = Array.isArray(cfg.sshKeyIds) ? cfg.sshKeyIds.slice() : [];
    if (!sshKeys.length) {
      const kr = await _doFetch('GET', '/v2/account/keys', token);
      if (kr.ok && kr.data && Array.isArray(kr.data.ssh_keys)) sshKeys = kr.data.ssh_keys.map((k) => k.id);
    }
    if (sshKeys.length) body.ssh_keys = sshKeys;
    const r = await _doFetch('POST', '/v2/droplets', token, body);
    if (!r.ok) return { ok: false, error: r.error };
    const droplet = r.data && r.data.droplet;
    if (!droplet || !droplet.id) return { ok: false, error: 'DigitalOcean returned no droplet id' };
    const rec = {
      id: _id(),
      name,
      provider: 'digitalocean',
      host: '',
      user: 'root',
      keyPath: '',
      port: 22,
      doToken: token,
      dropletId: droplet.id,
      createdAt: Date.now(),
    };
    // Re-read after the (slow) provisioning fetch so a server added meanwhile
    // isn't clobbered by a store snapshot taken before the API round-trip.
    const st = load();
    st.servers.push(rec);
    save(st);
    return { ok: true, server: _public(rec), note: 'booting — call dropletStatus to get the IP' };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function dropletStatus(id) {
  try {
    const s0 = _find(load(), id);
    if (!s0) return { ok: false, error: 'not found' };
    if (!s0.dropletId) return { ok: false, error: 'not a provisioned droplet' };
    if (!s0.doToken) return { ok: false, error: 'no DigitalOcean token on record' };
    const r = await _doFetch('GET', '/v2/droplets/' + s0.dropletId, s0.doToken);
    if (!r.ok) return { ok: false, error: r.error };
    const d = r.data && r.data.droplet;
    if (!d) return { ok: false, error: 'droplet not found' };
    const ip = _publicIPv4(d);
    if (ip) {
      // Re-read AFTER the network round-trip and do the host update as a single
      // synchronous read-modify-write, so a concurrent write that landed during
      // the await is not clobbered by a stale pre-await snapshot. (Read-per-call
      // surfaced this lost-update; the old shared in-memory singleton masked it.
      // No mutate() needed — the await is OUTSIDE this read-modify-write.)
      const st = load();
      const s = _find(st, id);
      if (s && ip !== s.host) { s.host = ip; save(st); }
    }
    return { ok: true, status: d.status, ip: ip || '' };
  } catch (e) { return { ok: false, error: e.message }; }
}

const POWER = new Set(['power_on', 'power_off', 'reboot', 'shutdown']);
async function powerAction(id, action) {
  try {
    if (!POWER.has(String(action))) return { ok: false, error: 'invalid action' };
    const s = _find(load(), id);
    if (!s) return { ok: false, error: 'not found' };
    if (!s.dropletId) return { ok: false, error: 'not a provisioned droplet' };
    if (!s.doToken) return { ok: false, error: 'no DigitalOcean token on record' };
    const r = await _doFetch('POST', '/v2/droplets/' + s.dropletId + '/actions', s.doToken, { type: action });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, action, status: r.data && r.data.action && r.data.action.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

export const Servers = {
  list, get, add, update, remove,
  test, run, automations, runAutomation,
  deployAgent, provision, dropletStatus, powerAction,
};
export default Servers;

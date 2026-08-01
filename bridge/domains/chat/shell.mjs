// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — domains/chat/shell  (T-030)
//
// The /shell "smart-mode" command runner, extracted from hub-bridge.mjs so the
// router keeps only transport + security + dispatch. Owns: the tracked shell
// cwd, the built-in cd/pwd/clear, the catastrophic-command guard (via the shared
// platform/shell-guard port — this RETIRES the 4th and last inline copy of that
// regex, completing T-023), per-request sudo/root gating, output cap + timeout,
// and the per-command process registry that /interrupt drives.
//
// CWD SEMANTICS (T-030 follow-up): cwd is PER-SESSION. A terminal that passes a
// stable `sid` gets its OWN tracked cwd, so two tabs in different directories
// never stomp each other. (The old single-shared-cwd model broke the CODE
// terminal, which reuses a fresh random command id every command and relied on a
// global cwd that ANY other terminal could move out from under it.) id-less /
// sid-less one-shots — the git-branch indicator's `git rev-parse`, `pwd` home
// resolution, the agent's open_app/run_shell — share the AMBIENT session, which
// follows the most-recently-active terminal's `cd`, so "run where I am" stays
// intuitive. `body.id` remains the interrupt/kill-registry key (unchanged);
// `body.sid` is the new cwd-session key. Backward compatible: no sid → AMBIENT,
// exactly the previous shared behavior.
//
// Zero npm deps — Node built-ins + the shared shell-guard + permissions modules.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isDestructive } from '../../platform/shell-guard.mjs';
import Permissions from '../../permissions.mjs';

const OUT_CAP = 512 * 1024;   // 512 KiB max output per command
const CMD_TIMEOUT = 120_000;  // 2 min hard cap per command

// ── per-session cwd (see CWD SEMANTICS above) ────────────────────────────────
const HOME = () => process.env.HOME || homedir();
const AMBIENT = '';            // reserved sid: the shared session for id-less one-shots
const MAX_SESSIONS = 256;      // bound the map (evict oldest keyed session, never AMBIENT)
const sessions = new Map();    // sid -> { cwd, prev }
sessions.set(AMBIENT, { cwd: HOME(), prev: null });

// Resolve (creating if new) the cwd session for a caller's sid. A brand-new
// terminal opens at HOME — NOT another tab's cwd — matching how a real terminal
// starts; the renderer then `cd`s it to any intended directory.
function sess(sid) {
  const k = sid || AMBIENT;
  let s = sessions.get(k);
  if (!s) {
    s = { cwd: HOME(), prev: null };
    sessions.set(k, s);
    if (sessions.size > MAX_SESSIONS) {
      for (const key of sessions.keys()) { if (key !== AMBIENT) { sessions.delete(key); break; } }
    }
  }
  return s;
}

// A `cd` in ANY keyed session also advances AMBIENT, so id-less one-shots track
// the terminal you last used. (For AMBIENT itself the second step is skipped.)
function commitCwd(s, dir) {
  s.prev = s.cwd; s.cwd = dir;
  const amb = sessions.get(AMBIENT);
  if (s !== amb) { amb.prev = amb.cwd; amb.cwd = dir; }
}

const running = new Map(); // id -> killGroup(sig)  (interrupt registry; independent of cwd)

// The AMBIENT cwd — read by the router's /pair response and boot banner (the
// "where the machine is" answer for a client that names no session).
export function cwd() { return sessions.get(AMBIENT).cwd; }

function resolveCd(arg, s) {
  const home = HOME();
  if (!arg || arg === '~') return home;
  if (arg === '-') return s.prev || s.cwd;
  let p = arg.startsWith('~') ? path.join(home, arg.slice(1)) : arg;
  if (!path.isAbsolute(p)) p = path.resolve(s.cwd, p);
  return p;
}

// POST /shell {cmd, id?, sudoPass?} → streamed text with \x00-framed control
// markers (CWD/CLEAR/EXIT/ERR/NEEDSUDO). `streamHead` is injected by the router
// (the one shared streaming-response head, also used by chat).
export async function handleShell(req, res, body, { streamHead }) {
  const cmd = String(body.cmd || '').trim();
  const id = String(body.id || randomBytes(4).toString('hex')); // interrupt/kill-registry key
  const s = sess(body.sid ? String(body.sid) : '');             // cwd session (no sid → AMBIENT)
  streamHead(res);
  if (!cmd) { res.end(); return; }

  // built-in cd (persists this session's tracked cwd; real terminals need this).
  // Only a BARE cd. The old pattern was `^cd(?:\s+(.+))?$`, which swallowed the whole line —
  // so `cd repo && npm test` was handed to statSync as the directory "repo && npm test" and
  // came back "cd: no such file or directory". The command never ran, and the most ordinary
  // shell idiom there is looked like a broken path. Anything with a shell operator in it goes
  // to zsh, which is the only thing that can interpret it.
  const cdMatch = /[;&|]|\$\(|`/.test(cmd) ? null : cmd.match(/^cd(?:\s+(.+))?$/);
  if (cdMatch) {
    const target = resolveCd((cdMatch[1] || '').trim().replace(/^["']|["']$/g, ''), s);
    try {
      if (fs.statSync(target).isDirectory()) { commitCwd(s, target); res.end('\x00CWD\x00' + s.cwd); }
      else res.end('cd: not a directory: ' + target + '\n');
    } catch { res.end('cd: no such file or directory: ' + target + '\n'); }
    return;
  }
  if (cmd === 'pwd') { res.end(s.cwd + '\n\x00CWD\x00' + s.cwd); return; }
  if (cmd === 'clear') { res.end('\x00CLEAR\x00'); return; }

  // destructive-pattern guard — blocked even with root, always (shared port).
  if (isDestructive(cmd)) {
    res.end('\x00ERR\x00refused: catastrophic pattern blocked for safety\n'); return;
  }
  // sudo / root — only when Root mode is ON; password is per-request, never stored/logged
  let spawnCmd = cmd, sudoPass = null;
  if (/^\s*sudo\b/.test(cmd)) {
    let allowed = false;
    try { allowed = Permissions.can && Permissions.can('root'); } catch {}
    if (!allowed) { res.end('\x00ERR\x00root/sudo is OFF. Enable "Root mode" in Settings → Agent and try again.\n'); return; }
    sudoPass = body.sudoPass || '';
    if (!sudoPass) { res.end('\x00NEEDSUDO\x00'); return; }
    spawnCmd = cmd.replace(/^\s*sudo\b/, 'sudo -S -p ""');
  }

  let sent = 0, killedForCap = false;
  const child = spawn('zsh', ['-lc', spawnCmd], {
    cwd: fs.existsSync(s.cwd) ? s.cwd : HOME(),
    env: process.env,
    detached: true, // own process group → SIGINT/SIGKILL the whole tree (npm run dev, sleep, …)
  });
  // stdin is closed either way. This endpoint is one-shot — there is no channel to type into
  // it — so leaving the pipe open on non-sudo commands meant anything that reads stdin (`cat`
  // with no file, `sort`, `grep foo` alone) blocked on a pipe nobody would ever write to and
  // held the response open for the full two-minute timeout. Closed, they see EOF and finish.
  try { if (sudoPass) child.stdin.write(sudoPass + '\n'); child.stdin.end(); } catch {}
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  running.set(id, killGroup);
  const to = setTimeout(() => { killGroup('SIGKILL'); res.write('\n\x00ERR\x00command timed out (2m)\n'); }, CMD_TIMEOUT);
  const push = (buf) => {
    if (killedForCap) return;
    sent += buf.length;
    if (sent > OUT_CAP) { killedForCap = true; killGroup('SIGKILL'); res.write('\n\x00ERR\x00output capped (512 KiB)\n'); return; }
    res.write(buf);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => { res.write('\x00ERR\x00' + e.message + '\n'); });
  child.on('close', (code) => {
    clearTimeout(to); running.delete(id);
    res.end('\x00EXIT\x00' + (code ?? 0) + '\x00CWD\x00' + s.cwd);
  });
  req.on('close', () => killGroup('SIGKILL'));
}

// POST /interrupt {id} → SIGINT the running command with this id. Returns whether
// one was found (the router serializes this into {ok:<found>}).
export function interrupt(id) {
  const c = running.get(String(id));
  if (c) c('SIGINT');
  return !!c;
}

export const Shell = { handleShell, interrupt, cwd };
export default Shell;

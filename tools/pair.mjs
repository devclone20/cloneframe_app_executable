#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — pair this app with this machine
//
//   npm run pair       put the pairing link on the clipboard
//   npm run pair:new   mint a NEW token first — the old one stops working instantly
//
// The link is `http://127.0.0.1:<port>#token=<token>`. It goes straight to the
// clipboard: paste it into MY MACHINE and press CONNECT.
//
// It is NEVER printed. Whoever holds that token holds a shell on this machine with
// the owner's privileges, so it must not land in a terminal scrollback, a screen
// recording, a shell history file, or a log. The clipboard is the one channel that
// carries it from here to the field it belongs in without ever being displayed.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../bridge/session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = { dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', x: '\x1b[0m' };
const say = (s = '') => process.stdout.write(s + '\n');
const PORT = Number(process.env.HUB_BRIDGE_PORT || 8765);
const URL = `http://127.0.0.1:${PORT}`;

/** Copy without the value ever reaching a terminal or an argv the process table can see. */
function toClipboard(text) {
  const cmd = process.platform === 'darwin' ? ['pbcopy', []]
    : process.platform === 'win32' ? ['clip', []]
      : ['xclip', ['-selection', 'clipboard']];
  try {
    const p = spawnSync(cmd[0], cmd[1], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    return p.status === 0;
  } catch { return false; }
}

const rotate = process.argv.includes('--new');

let token;
if (rotate) {
  const r = Session.rotate();
  if (!r || r.ok === false) { say(`${C.r}✗${C.x} could not mint a new token: ${(r && r.error) || 'unknown'}`); process.exit(1); }
  token = r.token;
} else {
  token = Session._token();
}
if (!token) { say(`${C.r}✗${C.x} no token available`); process.exit(1); }

const link = `${URL}#token=${token}`;
const copied = toClipboard(link);

// The daemon must be running for the link to connect to anything, and after a rotate it
// must be restarted so it stops honouring the token that just died.
const health = spawnSync('/usr/bin/curl', ['-s', '--max-time', '3', `${URL}/health`], { encoding: 'utf8' });
const up = (health.stdout || '').includes('"ok":true');
const stale = (health.stdout || '').includes('"stale":true');
if (!up || stale || rotate) {
  process.stdout.write(`  ${C.dim}${up ? 'restarting' : 'starting'} the bridge…${C.x} `);
  const r = spawnSync('/bin/zsh', [path.join(HERE, '..', 'bridge', 'launch.sh')], { stdio: 'ignore', timeout: 60_000 });
  say(r.status === 0 ? `${C.g}up${C.x}` : `${C.y}check it with: zsh bridge/launch.sh${C.x}`);
}

say();
if (rotate) {
  say(`  ${C.g}✓${C.x} New token minted. ${C.dim}The previous one no longer works anywhere — any window`);
  say(`    still holding it is disconnected, which is the point.${C.x}`);
}
if (copied) {
  say(`  ${C.g}✓${C.x} ${C.b}Pairing link copied to your clipboard.${C.x}`);
  say();
  say(`    ${C.c}1${C.x}  open ${C.b}MY MACHINE${C.x} in the app`);
  say(`    ${C.c}2${C.x}  paste into the field that says ${C.dim}"paste: ${URL}#token=…"${C.x}`);
  say(`    ${C.c}3${C.x}  press ${C.b}CONNECT${C.x}`);
  say();
  say(`  ${C.dim}The token is not shown here on purpose: whoever has it has a shell on this`);
  say(`  machine as you. It is on the clipboard only — paste it and it is done.${C.x}`);
} else {
  // Never fall back to printing it. An unavailable clipboard is not a reason to put a
  // shell credential on screen.
  say(`  ${C.y}Could not reach the clipboard on this system.${C.x}`);
  say(`  ${C.dim}The app injects the token by itself when you launch it the normal way:${C.x}`);
  say(`     ${C.c}zsh bridge/launch.sh${C.x}`);
  say(`  ${C.dim}That opens the window already paired — no pasting, no token on screen.${C.x}`);
}
say();

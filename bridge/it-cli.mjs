#!/usr/bin/env node
// it — the CLONE FRAME terminal's command line.
// (same names) against the local HUB Bridge; the iT window executes and answers.
// Local-only: 127.0.0.1 + the pairing token from ~/.clone-frame-hub/bridge.token.
// `it` / `it welcome`, `it --help`, `it docs` and `it feedback` work offline;
// everything else needs the app open with an iT window.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENDPOINT = process.env.CFHUB_BRIDGE || 'http://127.0.0.1:8765';
const CONFIG = path.join(os.homedir(), '.clone-frame-hub');
const argv = process.argv.slice(2);
const cmd = argv[0] || 'welcome';

const C = { b: '\x1b[1m', d: '\x1b[38;5;244m', a: '\x1b[38;5;176m', g: '\x1b[32m', r: '\x1b[31m', x: '\x1b[0m' };

const SHORTCUTS = [
  ['⌘N', 'New workspace'], ['⌘T', 'New tab'],
  ['⌘P', 'Go to workspace'], ['⌘B', 'Toggle left sidebar'],
  ['⌘⌥B', 'Toggle right sidebar'], ['⌘D', 'Split right'],
  ['⌘⇧D', 'Split down'], ['⌘⇧P', 'Command palette'],
  ['⌘⇧R', 'Rename workspace'], ['⌘R', 'Rename tab'],
  ['⌘⇧U', 'Jump to latest unread'], ['⌥⌘U', 'Mark all read'],
  ['⌘⇧↩', 'Zoom pane'], ['⌃⌘=', 'Equalize splits'],
  ['⌥⌘←→↑↓', 'Focus pane'], ['⌘K', 'Clear terminal'],
];

function welcome() {
  // The mark: the iT wordmark in big blocks beside the CLONE FRAME triangle (the ▲ of
  // the app's menu), on a soft violet→red 256-color ramp. Colorful, never loud — and
  // pure ASCII/ANSI so every terminal since 1995 renders it the same.
  const P = (n) => `\x1b[38;5;${n}m`;                  // 256-color foreground
  const ramp = [183, 177, 176, 170, 169, 168, 167];    // violet → magenta → red, one per row
  const tri = P(203);                                  // the triangle keeps the accent red
  const rows = [
    { i: '██', t: '          ', y: '       ' },
    { i: '  ', t: '          ', y: '   ▲   ' },
    { i: '██', t: '██████████', y: '  ▲▲▲  ' },
    { i: '██', t: '    ██    ', y: ' ▲▲▲▲▲ ' },
    { i: '██', t: '    ██    ', y: '▲▲▲▲▲▲▲', x: `${C.b}iT${C.x} ${C.d}·${C.x} the CLONE FRAME terminal` },
    { i: '██', t: '    ██    ', y: '       ', x: `${C.d}workspaces · splits · agents${C.x}` },
    { i: '██', t: '    ██    ', y: '       ' },
  ];
  const l = [];
  l.push('');
  rows.forEach((r, k) => l.push(`   ${P(ramp[k])}${r.i}    ${r.t}${C.x}   ${tri}${r.y}${C.x}   ${r.x || ''}`));
  l.push('');
  l.push(`  ${C.b}Shortcuts${C.x}`);
  l.push('');
  for (const [k, v] of SHORTCUTS) l.push(`  ${C.b}${k.padEnd(12)}${C.x}      ${v}`);
  l.push('');
  l.push(`  ${C.b}Docs${C.x}          cloneframe.io · Settings → iT — Terminal`);
  l.push(`  ${C.b}Open source${C.x}   CLONE FRAME is MIT — the terminal, the bridge and the app`);
  l.push('');
  l.push(`  Run ${C.b}it --help${C.x} for all commands.`);
  l.push(`  Run ${C.b}it shortcuts${C.x} to view & edit shortcuts.`);
  l.push(`  Run ${C.b}it feedback --body "..."${C.x} to report a bug.`);
  l.push('');
  console.log(l.join('\n'));
}

function help() {
  console.log(`it - control iT (the CLONE FRAME terminal) via the local HUB Bridge

Usage:
  it [command] [options]

Targets:
  Commands that take a workspace accept an index (1-9), "workspace:N", or a name.
  Inside an iT shell, CFHUB_IT_WORKSPACE / CFHUB_IT_SURFACE are auto-set and used
  as the default target.

Commands:
  welcome                                   this screen (also plain \`it\`)
  ping                                      is the app + iT window alive?
  version
  docs
  context                                   the CLONE FRAME agent field guide (AGENTS.md)
  shortcuts [list]                          view the keymap (list = table)
  shortcuts set <action> <combo|none>       rebind, e.g. it shortcuts set split-right cmd+e
  shortcuts reset [action]                  back to defaults
  hooks <setup|status|remove> [claude|codex]  wire coding agents → iT notifications (⌘I)
  feedback [--body <text>]                  record a bug report locally
  open </absolute/path>                     folder → new workspace · file → the viewer
  edit [folder]                             code editor split (⌘⇧E) — file tree + view/edit/save
  diff                                      diff viewer split (⌃⌘⇧D) — git diff, colored
  list-workspaces
  current-workspace
  new-workspace [--cwd <path>] [--name <title>]
  select-workspace <ref>
  rename-workspace [--workspace <ref>] <title>
  close-workspace [--workspace <ref>]
  set-workspace-color <name|#hex|none>      red crimson orange amber olive green teal aqua
                                            blue navy indigo purple magenta rose brown charcoal
  set-status <key> <value> [--icon <emoji>] [--color <#hex>] [--priority <n>]
  clear-status [key] · list-status          workspace pills in the sidebar
  set-progress <0..1> [--label <text>]      workspace progress bar
  clear-progress
  jump-to-unread
  mark-all-read
  new-split <left|right|up|down>
  list-panes
  focus-pane <index>
  equalize-splits
  toggle-split-zoom
  break-pane                                the active tab becomes its own pane
  move-surface <left|right|up|down>         send the active tab to a neighbour pane
  toggle-canvas · tidy-canvas               free-floating panes (⌃⌘C · ⌃⌘T)
  canvas-zoom <in|out|reset|0.25..3> · canvas-overview · canvas-reveal
  group <new|collapse|dissolve|list>        collapsible workspace groups (⌃⌘G)
  find-in-directory                         file find / content search (⌘⇧F)
  new-browser                               browser split beside the terminal (⌘⇧L)
  new-surface [--cwd <path>] [--type <terminal|smart|browser|code>] [--url <url>]
  close-surface
  rename-tab <title>
  next-tab | previous-tab
  send <text>                               type into the focused terminal
  send-key <key>                            enter · escape · tab · up/down/left/right · ctrl+c …
  read-screen [--lines <n>]                 read the focused terminal's screen
  run <command> [--host <alias>]            run + capture output (locally, or on a saved SSH host)
  pipe <on|off> [--file <path>]             tee the terminal's output to a file
  notify --title <text> [--body <text>]
  right-sidebar <toggle|show|hide|files>
  toggle-left-sidebar

  Surface commands also take --workspace <ref> [--pane pane:N] [--surface surface:N] [--host <alias>].

  # remote hosts (SSH) — your own servers/VMs, gated by the "Remote servers (SSH)" permission
  host list                                 saved hosts
  host add --alias <a> --host <h> [--user <u>] [--port <n>] [--identity <path>]
  host connect <alias>                      open a remote shell in a new tab
  host fingerprint <alias> · host rm <alias> · host disconnect <alias> · host forget-key <alias>

  # screen access
  capture-pane [--lines <n>]                alias of read-screen
  display-message <text>

Environment:
  CFHUB_IT_WORKSPACE   auto-set in iT shells — default --workspace
  CFHUB_IT_SURFACE     auto-set in iT shells — default surface target
  CFHUB_BRIDGE         bridge endpoint (default http://127.0.0.1:8765)`);
}

function docs() {
  console.log(`iT docs
  In-app     Settings → iT — Terminal (shortcuts, defaults, live sessions)
  Help       press ? in the iT sidebar, or ⌘⇧P for the command palette
  Context    it context — the CLONE FRAME agent field guide
  Site       cloneframe.io
  Licenses   Settings → Licenses — CLONE FRAME is MIT; bundled engines keep their own`);
}

// The agent field guide — every AI/LLM launched in CLONE FRAME reads this first.
function context() {
  const local = path.join(CONFIG, 'AGENTS.md');
  try { process.stdout.write(fs.readFileSync(local, 'utf8')); return; } catch {}
  // fall back to the bundle copy next to the bridge
  try {
    const bundled = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'context', 'AGENTS.md');
    process.stdout.write(fs.readFileSync(bundled, 'utf8')); return;
  } catch {}
  console.error('field guide not found — expected ~/.clone-frame-hub/AGENTS.md (reopen CLONE FRAME to regenerate it)');
  process.exit(1);
}

function feedback() {
  const i = argv.indexOf('--body');
  const body = i >= 0 ? argv.slice(i + 1).join(' ') : argv.slice(1).join(' ');
  if (!body.trim()) { console.error('usage: it feedback --body "what happened"'); process.exit(1); }
  try {
    fs.mkdirSync(CONFIG, { recursive: true, mode: 0o700 });
    const f = path.join(CONFIG, 'feedback.md');
    fs.appendFileSync(f, `\n## ${new Date().toISOString()}\n${body.trim()}\n`, { mode: 0o600 });
    console.log(`${C.g}✓${C.x} feedback recorded → ${f}`);
    rpc(['notify', '--title', 'iT feedback recorded', '--body', body.slice(0, 120)]).catch(() => {});
  } catch (e) { console.error('could not record feedback:', e.message); process.exit(1); }
}

// ---- agent hooks (`it hooks setup`) — wire the user's coding agents so a
// finished task raises an iT notification. Real files, opt-in only, idempotent, backed up:
//   Claude Code → ~/.claude/settings.json  (hooks.Stop + hooks.Notification, marker = our bin path)
//   Codex       → ~/.codex/config.toml     (top-level notify = [wrapper]; never overwrites a foreign one)
const IT_BIN = path.join(CONFIG, 'bin', 'it');
const HOOK_MARK = '.clone-frame-hub/bin/it';
const CODEX_WRAP = path.join(CONFIG, 'bin', 'it-codex-notify');

function hooksClaude(action) {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { if (action === 'status') return 'claude: no settings.json'; }
  j.hooks = j.hooks || {};
  const ours = (arr) => (arr || []).some((m) => (m.hooks || []).some((h) => String(h.command || '').includes(HOOK_MARK)));
  const wired = ours(j.hooks.Stop) && ours(j.hooks.Notification);
  if (action === 'status') return 'claude: ' + (wired ? 'wired' : 'not wired');
  if (action === 'remove') {
    for (const ev of ['Stop', 'Notification']) {
      j.hooks[ev] = (j.hooks[ev] || []).map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !String(h.command || '').includes(HOOK_MARK)) })).filter((m) => (m.hooks || []).length);
      if (!j.hooks[ev].length) delete j.hooks[ev];
    }
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
    return 'claude: hooks removed';
  }
  if (wired) return 'claude: already wired';
  if (fs.existsSync(file) && !fs.existsSync(file + '.bak-it-hooks')) fs.copyFileSync(file, file + '.bak-it-hooks');
  const entry = (title, body) => ({ matcher: '', hooks: [{ type: 'command', command: `"$HOME/${HOOK_MARK}" notify --title "${title}" --body "${body}" >/dev/null 2>&1 || true` }] });
  j.hooks.Stop = (j.hooks.Stop || []).concat([entry('Claude Code', 'finished — back to you')]);
  j.hooks.Notification = (j.hooks.Notification || []).concat([entry('Claude Code', 'needs your attention')]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  return 'claude: wired (Stop + Notification → it notify)';
}

function hooksCodex(action) {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { if (action === 'status') return 'codex: no config.toml'; }
  const oursRe = /^\s*notify\s*=\s*\[[^\]]*it-codex-notify[^\]]*\]\s*$/m;
  const anyRe = /^\s*notify\s*=/m;
  const wired = oursRe.test(txt);
  if (action === 'status') return 'codex: ' + (wired ? 'wired' : anyRe.test(txt) ? 'foreign notify present — left alone' : 'not wired');
  if (action === 'remove') {
    if (!wired) return 'codex: nothing to remove';
    fs.writeFileSync(file, txt.replace(oursRe, '').replace(/\n{3,}/g, '\n\n'));
    try { fs.unlinkSync(CODEX_WRAP); } catch {}
    return 'codex: notify removed';
  }
  if (wired) return 'codex: already wired';
  if (anyRe.test(txt)) return 'codex: a notify is already configured — not touching it';
  fs.mkdirSync(path.dirname(CODEX_WRAP), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CODEX_WRAP, `#!/bin/sh\n# iT — Codex notify wrapper (receives a JSON arg from Codex)\nexec "$HOME/${HOOK_MARK}" notify --title "Codex" --body "turn finished" >/dev/null 2>&1 || true\n`, { mode: 0o755 });
  if (fs.existsSync(file) && !fs.existsSync(file + '.bak-it-hooks')) fs.copyFileSync(file, file + '.bak-it-hooks');
  const line = `notify = ["${CODEX_WRAP}"]\n`;
  const secIdx = txt.search(/^\[/m); // top-level keys must sit before the first [section]
  const out = secIdx < 0 ? (txt.trimEnd() + (txt.trim() ? '\n' : '') + line) : (txt.slice(0, secIdx) + line + txt.slice(secIdx));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return 'codex: wired (notify → it notify)';
}

function hooks() {
  const sub = argv[1] || 'status';
  const which = (argv[2] || 'all').toLowerCase();
  const act = sub === 'setup' ? 'setup' : sub === 'remove' ? 'remove' : 'status';
  if (!['setup', 'remove', 'status'].includes(sub)) { console.error('usage: it hooks <setup|status|remove> [claude|codex]'); process.exit(1); }
  const outs = [];
  try {
    if (which === 'all' || which === 'claude') outs.push(hooksClaude(act));
    if (which === 'all' || which === 'codex') outs.push(hooksCodex(act));
  } catch (e) { console.error(`${C.r}✗${C.x} ` + e.message); process.exit(1); }
  for (const o of outs) console.log(`${C.g}✓${C.x} ` + o);
  if (act === 'setup') console.log(`${C.d}Finished agent tasks now land in iT notifications (⌘I). Undo: it hooks remove${C.x}`);
}

function token() {
  try { return fs.readFileSync(path.join(CONFIG, 'bridge.token'), 'utf8').trim(); }
  catch { return ''; }
}

async function rpc(vector) {
  const t = token();
  if (!t) throw new Error('no bridge token — is CLONE FRAME installed? (~/.clone-frame-hub/bridge.token)');
  const ctx = { workspace: process.env.CFHUB_IT_WORKSPACE || '', surface: process.env.CFHUB_IT_SURFACE || '' };
  let res;
  try {
    res = await fetch(ENDPOINT + '/mod/it', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ fn: 'cmd', args: [vector, ctx] }),
    });
  } catch { throw new Error('the HUB Bridge is not running — open CLONE FRAME first'); }
  if (!res.ok) throw new Error('bridge said HTTP ' + res.status);
  return await res.json();
}

function printResult(r) {
  if (!r || typeof r !== 'object') { console.log(String(r)); return; }
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  if (!r.ok) { console.error(`${C.r}✗${C.x} ` + (r.error || 'failed')); process.exit(1); }
  if (Array.isArray(r.rows) && r.rows.length) {
    const cols = Object.keys(r.rows[0]);
    const width = cols.map((c) => Math.max(c.length, ...r.rows.map((x) => String(x[c] ?? '').length)));
    console.log(C.d + cols.map((c, i) => c.padEnd(width[i])).join('  ') + C.x);
    for (const row of r.rows) console.log(cols.map((c, i) => String(row[c] ?? '').padEnd(width[i])).join('  '));
    return;
  }
  if (r.out !== undefined) { console.log(String(r.out)); return; }
  console.log(`${C.g}✓${C.x} ok`);
}

(async () => {
  if (cmd === 'welcome') return welcome();
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') return help();
  if (cmd === 'docs') return docs();
  if (cmd === 'context') return context();
  if (cmd === 'feedback') return feedback();
  if (cmd === 'hooks') return hooks();
  try { printResult(await rpc(argv)); }
  catch (e) { console.error(`${C.r}✗${C.x} ` + e.message); process.exit(1); }
})();

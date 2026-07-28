#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — the model key, from the command line
//
//   npm run key            what keys exist on this machine, and which one is used
//   npm run key:set        paste a new key — the old one is destroyed first
//   npm run key:reset      remove every key this app owns
//
// Why this exists: a key can live in three different places — the macOS Keychain
// (where a registered provider keeps it), a raw field on disk, and an environment
// file. Replacing one of them left the others behind, so the app kept reporting a
// key the owner had already replaced. This is the one door that sees all three.
//
// The key itself is never echoed, never passed as an argument (a shell argument
// lands in history), never written to a log, and never printed back. It is typed
// into a hidden prompt or piped on stdin, checked with the provider, and stored.
// ─────────────────────────────────────────────────────────────────────────────
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Models } from '../bridge/models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = { dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', x: '\x1b[0m' };
const say = (s = '') => process.stdout.write(s + '\n');
const die = (s) => { say(`${C.r}✗${C.x} ${s}`); process.exit(1); };

/** Read a secret without echoing it. Accepts a pipe so it works unattended too. */
function askSecret(prompt) {
  if (!process.stdin.isTTY) {
    return new Promise((res) => {
      let buf = '';
      process.stdin.on('data', (d) => { buf += d; });
      process.stdin.on('end', () => res(buf.split('\n')[0].trim()));
    });
  }
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout;
    // Swallow the echo of everything typed after the prompt — the key must never
    // appear on screen, in a scrollback buffer, or in a screen recording.
    rl._writeToOutput = (s) => { if (s.startsWith(prompt) || s === '\r\n' || s === '\n') out.write(s); };
    rl.question(prompt, (a) => { rl.close(); out.write('\n'); res(String(a || '').trim()); });
  });
}

function ask(prompt) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (a) => { rl.close(); res(String(a || '').trim()); });
  });
}

async function status() {
  const a = await Models.keyAudit();
  say();
  say(`${C.b}KEYS ON THIS MACHINE${C.x}`);
  say();
  const api = a.providers.filter((p) => p.kind === 'api');
  if (!api.length) say(`  ${C.dim}no provider registered${C.x}`);
  for (const p of api) {
    const live = a.active.source === 'provider' && a.active.id === p.id;
    say(`  ${live ? C.g + '●' + C.x : C.dim + '○' + C.x} ${p.label.padEnd(14)} ${C.dim}key in the ${p.where}${C.x}${live ? `  ${C.g}← in use${C.x}` : ''}`);
  }
  for (const p of a.providers.filter((x) => x.kind === 'local')) {
    say(`  ${C.dim}○ ${p.label.padEnd(14)} local — no key needed${C.x}`);
  }
  if (a.env.length) {
    say();
    say(`  ${C.y}the environment carries ${a.env.length} more cop${a.env.length === 1 ? 'y' : 'ies'}${C.x}`);
    for (const e of a.env) {
      const art = /^[aeiou]/.test(e.provider) ? 'an' : 'a';
      say(`    ${e.name.padEnd(20)} ${C.dim}${e.source}${C.x}  ${e.shadowed ? C.dim + `· ignored, ${art} ${e.provider} provider is registered` + C.x : C.g + '· this is the one in use' + C.x}`);
    }
    say();
    say(`  ${C.dim}An environment copy is a second key the app can fall back to. It is only`);
    say(`  used when NO provider is registered here — but it is still a copy, and it is`);
    say(`  why a screen can report a key you thought you had replaced.${C.x}`);
  }
  say();
  if (a.active.source === 'none') say(`  ${C.y}Nothing is connected.${C.x} Run ${C.c}npm run key:set${C.x} to paste one.`);
  say();
}

async function set(argv) {
  const known = Models.knownProviders().filter((p) => p.kind !== 'local');
  let provider = (argv[0] || '').toLowerCase();
  if (!provider) {
    say();
    say(`${C.b}WHICH PROVIDER?${C.x}  ${C.dim}${known.map((k) => k.provider).join(' · ')}${C.x}`);
    provider = (await ask('  provider: ')).toLowerCase();
  }
  const known1 = known.find((k) => k.provider === provider);
  if (!known1 && !argv[1]) die(`unknown provider "${provider}" — pass a base URL as the second argument for a custom one`);
  const baseUrl = argv[1] || known1.baseUrl;

  const before = await Models.keyAudit();
  const existing = before.providers.find((p) => p.provider === provider && p.kind === 'api');
  if (existing) say(`\n  ${C.y}${provider} already has a key in the ${existing.where}. It will be destroyed.${C.x}`);

  const key = await askSecret(`\n  paste the ${provider} key (it will not be shown): `);
  if (!key) die('no key given — nothing changed');

  process.stdout.write('  checking it with the provider… ');
  let t;
  try { t = await Models.testProvider({ kind: 'api', provider, baseUrl, apiKey: key }); }
  catch (e) { say(`${C.r}failed${C.x}`); die(e.message || String(e)); }
  if (!t || !t.ok) { say(`${C.r}rejected${C.x}`); die((t && t.error) || 'the provider did not accept this key — the old one is untouched'); }
  say(`${C.g}accepted${C.x}`);

  // Only now is anything destroyed. A key that does not work must never be able to
  // take out the key that does.
  const r = Models.addProvider({ kind: 'api', provider, baseUrl, apiKey: key });
  if (!r.ok) die(r.error);
  say(`  ${C.g}✓${C.x} stored in the macOS Keychain${r.replaced ? `, ${r.replaced} old record${r.replaced === 1 ? '' : 's'} and ${r.replaced === 1 ? 'its' : 'their'} key destroyed` : ''}`);

  try {
    const list = await Models.listModels(r.id);
    if (list && list.ok && (list.models || []).length) {
      Models.setModels(r.id, list.models);
      say(`  ${C.g}✓${C.x} ${list.models.length} models available`);
    }
  } catch {}

  const after = await Models.keyAudit();
  const shadow = after.env.filter((e) => e.provider === provider);
  for (const e of shadow) {
    say();
    say(`  ${C.y}note${C.x} ${e.source} still contains ${C.b}${e.name}${C.x}.`);
    say(`  ${C.dim}It is now ignored — the provider you just registered wins. Delete that line`);
    say(`  if you want only one copy of this key on the machine; this command will not`);
    say(`  edit a file that holds your other projects' secrets.${C.x}`);
  }

  restartDaemon();
  say(`\n  ${C.g}Connected.${C.x} ${C.dim}The app is already using it — no relaunch needed.${C.x}\n`);
}

async function reset() {
  const a = await Models.keyAudit();
  const api = a.providers.filter((p) => p.kind === 'api');
  if (!api.length) { say(`\n  ${C.dim}no provider key to remove${C.x}`); }
  for (const p of api) {
    const r = Models.removeProvider(p.id);
    say(`  ${r.ok ? C.g + '✓' + C.x : C.r + '✗' + C.x} ${p.label} — record and Keychain entry removed`);
  }
  const after = await Models.keyAudit();
  if (after.env.length) {
    say();
    say(`  ${C.y}${after.env.length} key${after.env.length === 1 ? '' : 's'} remain in your environment${C.x} ${C.dim}— this command does not edit those files${C.x}`);
    for (const e of after.env) say(`    ${e.name.padEnd(20)} ${C.dim}${e.source}${C.x}`);
    say();
    say(`  ${C.dim}Remove the line yourself if you want the machine truly key-free:${C.x}`);
    for (const e of new Set(after.env.map((x) => x.source))) say(`    ${C.c}open ${e}${C.x}`);
  }
  restartDaemon();
  say();
}

// The daemon holds no key in memory — it resolves one per call — but it does cache the
// store, so a restart is what makes a fresh key visible to a window that is already open.
function restartDaemon() {
  const sh = path.join(HERE, '..', 'bridge', 'launch.sh');
  const r = spawnSync('/bin/zsh', [sh], { stdio: 'ignore', timeout: 60_000 });
  if (r.status !== 0) say(`  ${C.y}could not restart the bridge — run ${C.c}zsh bridge/launch.sh${C.y} yourself${C.x}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const run = { set, reset, status }[cmd || 'status'];
if (!run) die(`unknown command "${cmd}" — use status, set or reset`);
run(rest).catch((e) => die(e.message || String(e)));

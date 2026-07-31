// Eight controls reported success and changed nothing. Each one is its own small story, and
// they share one shape: a writer and a reader that disagree about a name, or a control whose
// click derives its new value from what is PAINTED rather than from what is STORED.
//
//  1 MY AGENTS → USE IN CODE      wrote `activeAgent` (LAB's key). CODE binds `pinnedAgents`.
//                                 The toast said "active in CODE"; CODE was untouched.
//  2 FOLDERS → Open in iT         `pendingShellCwd` is read only when an iT window MOUNTS, so
//                                 with iT already open nothing consumed it — and it stayed set,
//                                 poisoning the next iT that opened. terminal.js's open_terminal
//                                 tool already got this right; the button did not.
//  3 APPROVAL → reject / save edit  bare RPC + unconditional toast. The daemon reports refusal
//                                 as {ok:false,error} and does NOT throw, and act() exists for
//                                 exactly this — it is used one line above, on approve.
//  4 close_panel(alias)           open_panel and read_panel resolve aliases; their twin did not,
//                                 so the agent could open "browser" and fail to close it.
//  5 a docked AGENT VIEW          painted a blank square: occupyEl indexed ICON directly while
//                                 Grid.iconFor — in the same module — has the fallback.
//  6 the shortcuts overlay        advertised `g a` "go to Agent", which opens CODE, and did not
//                                 mention `g n` and `g u`, which work.
//  7 SETTINGS → a granular permission under Full machine control
//                                 the row renders the EFFECTIVE value and the click derived the
//                                 new value from that class, so it wrote false over false.
//  8 SETTINGS → CAPABILITIES      switches that gate nothing, under a heading that says they do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

test('USE IN CODE writes the key CODE actually reads', () => {
  const agents = decomment(read('web/panels/agents.js'));
  assert.match(agents, /st0\.pinnedAgents\.push\(\{contract:a\.contract/,
    'CODE binds pinnedAgents (terminal.js:442) — writing only activeAgent binds LAB, not CODE');
  assert.match(agents, /st0\.activeAgent=tid/, 'and activeAgent still selects it in LAB, which does read it');
  assert.doesNotMatch(agents, /Toast\.show\(\(a&&a\.name\|\|'agent'\)\+' active in CODE'\)/,
    'the old sentence promised a binding that did not happen');
  // Same shape LAB writes, or the two panels drift again.
  const lab = read('web/panels/lab.js');
  for (const field of ['contract', 'tokenId', 'name', 'collection', 'image', 'animation', 'mediaType']) {
    assert.ok(lab.includes(field + ':a.' + field), 'LAB should still write ' + field);
    assert.ok(agents.includes(field + ':a.' + field), 'MY AGENTS must write ' + field + ' too');
  }
});

test('FOLDERS → Open in iT reaches an iT that is already open', () => {
  const folders = decomment(read('web/panels/folders.js'));
  assert.match(folders, /instancesOf\('shell'\)\.length>0/,
    'it must know whether iT is already mounted — pendingShellCwd is only read on mount');
  assert.match(folders, /Bus\.emit\('shell:addcwd',cwd\)/,
    'and use the live path, the one terminal.js open_terminal already used correctly');
});

test('APPROVAL reports what the daemon said, in English', () => {
  const ap = decomment(read('web/panels/approval.js'));
  for (const fn of ['reject', 'edit']) {
    assert.match(ap, new RegExp("await act\\('approvals','" + fn + "'"),
      fn + ' must go through act(), which reads {ok:false} — a bare RPC reports refusals as success');
  }
  assert.doesNotMatch(ap, /Rejeitado/, 'the app is English (owner’s decision, 2026-07-11)');
});

test('all three panel tools resolve a name the same way', () => {
  const t = decomment(read('web/panels/terminal.js'));
  const close = t.match(/if\(c\.name==='close_panel'\)\{[\s\S]{0,220}/)[0];
  assert.match(close, /resolvePanelKey\(a\.panel\)/,
    'close_panel must resolve aliases like open_panel and read_panel do');
  // and the resolver must still know the aliases the agent is told about
  assert.match(t, /PANEL_ALIASES=\{browser:'research'/);
});

test('a frame square paints through the fallback its own module already has', () => {
  const idx = decomment(read('web/index.html'));
  assert.doesNotMatch(idx, /<use href="\$\{ICON\[type\]\}"/,
    'indexing ICON directly leaves a blank square for any type not in the map (agentview, browser…)');
  assert.match(idx, /<use href="\$\{Grid\.iconFor\(type\)\}"/, 'use the accessor with the fallback');
  assert.match(idx, /iconFor:t=>ICON\[t\]\|\|'#i-agent'/, 'and the fallback must still be there');
});

test('the shortcuts overlay lists the bindings that exist, and no others', () => {
  const idx = read('web/index.html');
  const go = read('web/panels/harness.js').match(/const GO=\{[^}]+\}/)[0];
  assert.ok(go.includes("a:'agent'"), 'the GO table still maps a → agent…');
  assert.match(idx, /openPanel\('terminal'\); \/\/ the CONSOLE is gone/,
    '…and openPanel redirects agent → terminal, which is why the overlay must not say "Agent"');
  const overlay = idx.match(/<h5>PANELS<\/h5>[\s\S]*?<h5>CODE CHAT<\/h5>/)[0];
  assert.doesNotMatch(overlay, /go to Terminal · Harness · LAB · Agent/, 'that row named a destination it does not reach');
  for (const shown of ['MY AGENTS', 'AUTOMATIONS']) {
    assert.ok(overlay.includes(shown), shown + ' is a working binding (g n / g u) and was undocumented');
  }
});

test('a permission switch decides from what is STORED, not from what is painted', () => {
  const st = decomment(read('web/panels/settings.js'));
  assert.doesNotMatch(st, /const k=sw\.dataset\.perm,on=!sw\.classList\.contains\('on'\)/,
    'deriving the new value from the painted class is the defect — the paint is the EFFECTIVE value');
  assert.match(st, /const on=!perms\[k\];/, 'derive from the stored flag');
  assert.match(st, /Governed by Full machine control/,
    'and when the master switch is what turns this row on, say so instead of writing a no-op');
});

test('the capability switches no longer claim to be a gate', () => {
  const st = decomment(read('web/panels/settings.js'));
  assert.doesNotMatch(st, /CAPABILITIES — enable only what you use/,
    'nothing reads Caps as a permission — openPanel only ever SETS it');
  assert.match(st, /a <b>record, not a gate<\/b>/, 'say what it is');
  assert.doesNotMatch(st, /\(v\?'Enabled: ':'Disabled: '\)\+k/, 'and the toast must not say "Disabled"');
  // The one thing that must NOT have happened: no panel may be hidden behind this.
  const idx = decomment(read('web/index.html'));
  assert.doesNotMatch(idx, /if\(!Caps\.on\(/, 'Caps must never become something that hides a panel');
});

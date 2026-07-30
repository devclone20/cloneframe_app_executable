// A safety gate that cannot be evaluated must fail CLOSED. This one failed open, three ways.
//
// harnessGates(cur) returned `[]` for three situations that are not the same thing:
//
//   1 · no crew chosen                          → nothing to apply. Correct.
//   2 · loadHarnesses() failed (catch(_){})     → "I never found out"
//   3 · the crew was DELETED under a session    → "it named a crew that is gone"
//
// and the call site read all three as "nothing to approve":
//
//   if(gates.length && GATED_TOOLS.has(c.name)) { …approval… } else r = await execTool(…)
//
// In 2 and 3 the session STILL DISPLAYED the crew's name, so the owner had every reason to
// believe the approval gates were live while run_shell, write_file and send_email went through
// unapproved.
//
// The fourth way was quieter and is the interesting one. There are two representations of the
// same idea — `roles[].gate` and `gates[]` — and they were protected in different places.
// bridge/harness.mjs add() floors an empty gate list to ['SAFETY','OWNER']. But:
//
//   · update() recomputed `gates` from the roles and did NOT re-apply the floor, so editing a
//     duplicated crew down to zero gate roles wiped `gates` too
//   · harnessGates() read roles[].gate, never `gates`, so the daemon's floor was invisible to
//     the only code that enforces anything
//
// The UI calls these gates "non-collapsible" and the agent's own system prompt says "nothing
// irreversible passes without" them. That has to be true on every path that can write a crew,
// including the agent's own update_harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const term = fs.readFileSync(path.join(APP, 'web/panels/terminal.js'), 'utf8');
const hbridge = fs.readFileSync(path.join(APP, 'bridge/harness.mjs'), 'utf8');

test('harnessGates tells "no gates" apart from "cannot tell"', () => {
  const fn = term.match(/function harnessGates\(cur\)\{[\s\S]*?\n {4}\}/)[0];
  assert.match(fn, /if\(!cur\|\|!cur\.harness\|\|!cur\.harness\.id\)return \[\]/, 'no crew → []');
  assert.match(fn, /if\(!harnessesLoaded\)return null/, 'never loaded → cannot tell');
  assert.match(fn, /if\(!hd\)return null/, 'crew deleted → cannot tell');
});

test('the gate list is read from the field the daemon actually protects', () => {
  const fn = term.match(/function harnessGates\(cur\)\{[\s\S]*?\n {4}\}/)[0];
  assert.match(fn, /if\(Array\.isArray\(hd\.gates\)&&hd\.gates\.length\)return hd\.gates\.slice\(\)/,
    'gates[] is authoritative — it carries the floor');
  assert.match(fn, /hd\.roles\.filter\(r=>r\.gate\)/, 'roles stay the fallback for older records');
});

test('the tool loop fails CLOSED when the gates cannot be evaluated', () => {
  assert.match(term, /if\(GATED_TOOLS\.has\(c\.name\)&&gates===null\)\{/,
    'null must be handled BEFORE the length check');
  assert.match(term, /r='BLOCKED — this conversation is set to the crew/, 'and nothing may run');
  assert.match(term, /gates could not be applied/, 'and it must say why, not just refuse');
  // the ordering matters: a `gates.length` test first would treat null as falsy and run the tool
  assert.ok(term.indexOf('gates===null') < term.indexOf('gates&&gates.length&&GATED_TOOLS'),
    'the null branch must come first');
});

test('a null gate list can never be mistaken for an empty one downstream', () => {
  assert.doesNotMatch(term, /if\(gates\.length&&GATED_TOOLS\.has\(c\.name\)\)\{/,
    'the original condition threw null and [] into the same bucket');
});

test('harnessesLoaded starts false and only a real list sets it', () => {
  assert.match(term, /let harnessesLoaded=false;/, 'before the first list, nothing is known');
  assert.match(term, /harnessesLoaded=Array\.isArray\(harnesses\)/, 'a real array sets it');
  assert.match(term, /catch\(_\)\{harnessesLoaded=false\}/, 'and a failure clears it again');
});

test('update() applies the same gate floor as add()', () => {
  const upd = hbridge.match(/update\(id, patch\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(upd, /if \(Array\.isArray\(p\.gates\) && !p\.gates\.length\) p\.gates = \['SAFETY', 'OWNER'\]/,
    'editing to zero gates must not wipe the floor');
  const add = hbridge.match(/add\(\{ name, description, kind, roles, gates \} = \{\} \) \{[\s\S]*?\n {2}\},/)
           || hbridge.match(/add\(\{[^)]*\}\s*=\s*\{\}\) \{[\s\S]*?\n {2}\},/);
  assert.ok(add, 'add() must still be there');
  assert.match(add[0], /g\.length \? g : \['SAFETY', 'OWNER'\]/, 'the floor add() has always had');
});

test('the floor really holds through a create → strip → update round trip', async () => {
  // Behavioural, against the real module, on a scratch data tree so the owner's crews are safe.
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-'));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = tmp;
    const mod = await import('../bridge/harness.mjs?floor=' + Date.now());
    const H = mod.Harness;
    const made = H.add({ name: 'zz-debug3-crew', roles: [{ name: 'SAFETY', gate: true }, { name: 'WORKER', gate: false }] });
    assert.equal(made.ok, true);
    const before = H.get(made.id);
    assert.deepEqual(before.gates, ['SAFETY']);
    // strip every gate role — the exact edit the UI's ✕ button performs
    H.update(made.id, { roles: [{ name: 'WORKER', gate: false }] });
    const after = H.get(made.id);
    assert.ok(after.gates.length > 0, 'gates were wiped by the edit — the floor did not hold');
    assert.deepEqual(after.gates, ['SAFETY', 'OWNER']);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The `app_rpc` tool description in agent/.pi/extensions/clone-frame.ts is a CONTRACT. It is
// the only list pi has of what the app can do, and pi calls exactly what it reads there.
//
// Measured against the live daemon during H3:
//
//   app_rpc {module:'email', fn:'accounts'}  →  {"ok":false,"error":"no such fn: accounts"}
//
// because bridge/email.mjs exports `listAccounts`. So pi, following its own tool description
// faithfully, hit a wall the description created. Nothing on either side was broken — the
// contract between them was.
//
// That class of defect cannot be caught by reading either file alone, and it drifts every time
// a module is refactored. So this test walks the description, extracts every `module (fn, fn…)`
// claim, imports the real module and checks the name exists. A rename that forgets the contract
// now goes red here instead of arriving as "the agent keeps trying something that fails".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const ext = fs.readFileSync(path.join(APP, 'agent/.pi/extensions/clone-frame.ts'), 'utf8');

// `module (a, b, c)` and the `module (fn 'x')` form the description also uses.
function promisedFns() {
  const out = {};
  const add = (m, f) => { (out[m] ||= new Set()).add(f); };
  for (const m of ext.matchAll(/\b([a-z][a-z0-9]*) \(fn '([a-zA-Z]+)'/g)) add(m[1], m[2]);
  for (const m of ext.matchAll(/\b([a-z][a-z0-9]*) \(([a-zA-Z][a-zA-Z,\s]*?)\)/g)) {
    // Split on COMMAS only. Splitting on `/` too made prose look like a list —
    // "browser (CDP engine via /mod/webengine)" yielded the fns `mod` and `webengine`.
    // Two or more comma-separated bare identifiers is a function list; anything else is prose.
    const fns = m[2].split(',').map((s) => s.trim()).filter((s) => /^[a-zA-Z]+$/.test(s));
    if (fns.length >= 2) fns.forEach((f) => add(m[1], f));
  }
  return out;
}

async function realFns(mod) {
  try {
    const m = await import(path.join(APP, 'bridge', mod + '.mjs'));
    const key = Object.keys(m).find((k) => k[0] === k[0].toUpperCase() && m[k] && typeof m[k] === 'object');
    return new Set(Object.keys(m[key] || m.default || {}));
  } catch { return null; }
}

test('every function the contract promises pi actually exists', async () => {
  const promised = promisedFns();
  const broken = [];
  for (const [mod, fns] of Object.entries(promised)) {
    const real = await realFns(mod);
    if (!real || !real.size) continue;   // not a bridge module — prose, or a nested namespace
    for (const f of fns) if (!real.has(f)) broken.push(mod + '.' + f);
  }
  assert.deepEqual(broken, [], 'the agent is told these exist and they do not: ' + broken.join(', '));
});

test('the one that was wrong is right', () => {
  assert.match(ext, /email \(listAccounts, folders, list, message, send, removeAccount\)/,
    'email exports listAccounts, not accounts');
  assert.doesNotMatch(ext, /email \(accounts,/, 'the old claim must be gone');
});

test('the sweep is not vacuous — it does find real modules', async () => {
  // If realFns() ever silently returns nothing for everything, the test above passes for the
  // wrong reason. Pin a few modules that must resolve.
  for (const mod of ['notes', 'tasks', 'reminders', 'brain', 'email']) {
    const real = await realFns(mod);
    assert.ok(real && real.size > 0, 'could not read the real exports of ' + mod);
  }
});

test('and it would have caught the original defect', async () => {
  const real = await realFns('email');
  assert.ok(real.has('listAccounts'), 'the real name');
  assert.ok(!real.has('accounts'), 'the name the contract used to promise');
});

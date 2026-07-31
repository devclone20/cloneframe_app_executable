// Six places where the tree gave two answers to one question, or an answer to a question
// nobody asks any more.
//
// · TWO default models. chat.mjs and llm.mjs each declared "the concrete model for a bare env
//   ANTHROPIC_API_KEY", with the same sentence in both headers and the same env override — and
//   different values (claude-opus-4-8 vs claude-sonnet-5). Which one answered depended on
//   whether the call came through /chat or through the shared LLM port, which is not something
//   anyone should have to know. bridge/README.md documented one of the two.
//
// · The Docker volume was mounted where the app does not write. compose mounts
//   cfhub-data:/root/CloneFrame; the Dockerfile runs as USER node, so homedir() is /home/node.
//   The volume was real, empty, and never touched, while the tree the app created sat on the
//   container's writable layer and died with the container — against a README that promises it
//   persists.
//
// · The app_rpc allowlist exempted `rpcallow` itself, so the agent it constrains could call
//   rpcallow.set and widen it. Nothing was gained (the module's header notes a token-holder can
//   omit the header entirely), but a policy its own subject can edit is not a policy.
//
// · files.write was ungated while two places SAID it was gated — files.mjs's own header, and
//   the pi extension's description handed to the model. The only check lived in the browser's
//   tool loop, which pi does not go through.
//
// · bridge/README.md listed three routes that were deleted (`/proxy`, `/email/accounts`,
//   `/email/<op>`), and bridge/SEARCH.md published a seven-module contract for an aggregator
//   with four, three of which are not modules in this bridge at all.
//
// · Web.fetchRaw was on the RPC surface with no caller anywhere — the reader for the removed
//   browser proxy. SSRF-guarded, so surface without a purpose rather than a hole.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const { DEFAULT_MODEL } = await import('../bridge/llm.mjs');

test('there is one default model, and the docs name that one', () => {
  const chat = decomment(read('bridge/domains/chat/chat.mjs'));
  assert.doesNotMatch(chat, /BRAIN_MODEL = process\.env\.HUB_BRIDGE_MODEL/,
    'a second literal for the same idea is how the two drifted apart');
  assert.match(chat, /await import\('\.\.\/\.\.\/llm\.mjs'\)/, 'take it from the one definition');
  assert.match(chat, /await brainModel\(\)/, 'and both call sites must await it');
  assert.equal((chat.match(/await brainModel\(\)/g) || []).length, 2, 'brain() and handleChat, both');
  assert.ok(read('bridge/README.md').includes('| `HUB_BRIDGE_MODEL` | `' + DEFAULT_MODEL + '`'),
    'the documented default must be the real one, whatever it is');
});

test('the Docker volume is mounted where the app actually writes', () => {
  const compose = read('docker-compose.yml');
  const dockerfile = read('Dockerfile');
  const user = (dockerfile.match(/^USER\s+(\S+)/m) || [, 'root'])[1];
  const home = user === 'root' ? '/root' : '/home/' + user;
  assert.ok(compose.includes('cfhub-data:' + home + '/CloneFrame'),
    `the image runs as ${user}, so homedir() is ${home} — the volume must mount there, not elsewhere`);
});

test('an agent may read the rules that constrain it, and may not rewrite them', () => {
  // This began as a special case for `rpcallow` and had to become a PRINCIPLE. The special
  // case left `permissions.set` on the agent's own RPC surface, so the gate built one commit
  // earlier could be switched off by the very thing it gated. Proven against a live daemon:
  //   AGENT email.send → 403 · AGENT permissions.set{autoEmail:true} → 200 · AGENT email.send → 200
  // A hand-written per-module check is also what let `scheduled.reschedule` through. So: one
  // table, DENY-BY-DEFAULT inside each control-plane module, with the reads named explicitly.
  const hb = decomment(read('bridge/hub-bridge.mjs'));
  assert.doesNotMatch(hb, /=== 'agent' && name !== 'rpcallow'/,
    'exempting a whole module let the agent widen its own allowlist');
  assert.match(hb, /const forbidden = CP\.agentForbidden\(name, fn\)/,
    'every agent call must pass the control plane');
  assert.match(hb, /if \(forbidden\) return fail\(403, 'refused: ' \+ forbidden\)/, 'and be refused by name');

  const table = read('bridge/permissions.mjs').match(/const CONTROL_PLANE = \{[\s\S]*?\n\};/)[0];
  for (const mod of ['permissions', 'rpcallow', 'admin', 'session']) {
    assert.ok(table.includes(mod + ':'), mod + ' edits what the agent may do — it belongs in the table');
  }
  // The literal in the source is inside a single-quoted JS string, so the apostrophe is escaped.
  assert.ok(/the app_rpc policy is the owner\\?'s/.test(table), 'and each says whose it is');
});

test('the control plane denies by default and still lets the agent look', async () => {
  const { Permissions } = await import('../bridge/permissions.mjs');
  // Reads stay open, or the agent cannot see what it is allowed to do — the only part of the
  // original rpcallow exemption worth keeping.
  for (const [m, f] of [['permissions', 'get'], ['rpcallow', 'get'], ['rpcallow', 'check'],
    ['admin', 'tools'], ['session', 'get'], ['session', 'keys']]) {
    assert.equal(Permissions.agentForbidden(m, f), null, m + '.' + f + ' is a read and must pass');
  }
  for (const [m, f] of [['permissions', 'set'], ['permissions', 'reset'], ['rpcallow', 'set'],
    ['rpcallow', 'reset'], ['admin', 'setToolEnabled'], ['admin', 'addTool'],
    ['session', 'rotate'], ['session', 'issue'], ['session', 'revoke'], ['session', 'set']]) {
    assert.ok(Permissions.agentForbidden(m, f), m + '.' + f + ' changes the rules and must be refused');
  }
  // The point of a principle: a function added to one of these modules tomorrow is already
  // out of reach, rather than out of reach if somebody remembers to add a line.
  assert.ok(Permissions.agentForbidden('permissions', 'somethingAddedLater'),
    'a new control-plane function must be refused by default');
  // …and an ordinary module is untouched by any of it.
  assert.equal(Permissions.agentForbidden('notes', 'create'), null);
  assert.equal(Permissions.agentForbidden('email', 'send'), null, 'email.send is GATED, not forbidden');
});

test('every file operation that writes needs the switch that says "Write files"', () => {
  const perms = read('bridge/permissions.mjs');
  for (const fn of ['write', 'writeB64', 'mkdir', 'remove', 'move', 'copy']) {
    assert.ok(perms.includes(`'files.${fn}': 'fileWrite'`), `files.${fn} writes to the owner's disk`);
  }
  for (const fn of ['list', 'read', 'stat']) {
    assert.ok(!perms.includes(`'files.${fn}'`), `files.${fn} is a read — gating it blinds the agent`);
  }
  // The two places that claimed the gate must now be describing something real.
  assert.match(read('bridge/files.mjs'), /Permissions\.agentGateFor/,
    'files.mjs’s header must point at the gate that exists, not assert one that did not');
});

test('the bridge docs describe routes and modules that exist', () => {
  const rd = read('bridge/README.md');
  // Up to the NEXT heading, not to the first blank line — the table now has a note under it,
  // and matching to `\n\n` grabbed the heading alone and nothing else.
  const table = rd.match(/## Endpoints[\s\S]*?(?=\n## )/)[0];
  for (const gone of ['`/proxy`', '`/email/accounts`', '`/email/<op>`']) {
    assert.ok(!table.includes(gone), gone + ' was removed from the daemon and must leave the table');
  }
  assert.ok(table.includes('`/mod/<name>`'), 'the route email actually uses must still be there');

  const sm = read('bridge/SEARCH.md');
  const real = read('bridge/search.mjs').match(/const MODULES = \[[^\]]+\]/)[0];
  for (const key of ['library', 'contacts', 'cookbook']) {
    assert.ok(!real.includes(key), key + ' is not a module in this bridge');
    assert.ok(!sm.includes('| `' + key + '`'), 'SEARCH.md must not map ' + key);
  }
  assert.ok(sm.includes("order: `['notes', 'tasks', 'reminders', 'research']`"),
    'the published contract must be the real set');
});

test('nothing is reachable over RPC that nothing calls', () => {
  // RAW, not decommented: web.mjs is full of regex literals, and a `/*` inside one opens a
  // phantom block comment that swallows the file to the next `*/`. The first draft of this
  // test lost 90 lines that way and reported the export as missing. Both lines below are
  // unambiguous in raw text, so there is nothing to strip.
  const web = read('bridge/web.mjs');
  assert.match(web, /export const Web = \{ fetchUrl, search, research \};/,
    'fetchRaw was the reader for a proxy that no longer exists, with no caller anywhere');
  // It must remain defined — removing the function would be a bigger change than the finding.
  assert.match(web, /export async function fetchRaw\(/, 'the function itself stays, just not on the surface');
});

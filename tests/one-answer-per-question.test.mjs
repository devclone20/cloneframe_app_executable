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

test('the agent may read the policy that constrains it, and may not rewrite it', () => {
  const hb = decomment(read('bridge/hub-bridge.mjs'));
  assert.doesNotMatch(hb, /=== 'agent' && name !== 'rpcallow'/,
    'exempting the whole module let the agent widen its own allowlist');
  assert.match(hb, /if \(fn === 'set' \|\| fn === 'reset'\) return fail\(403/,
    'writes to the policy must be refused');
  assert.match(hb, /the app_rpc policy is the owner's/, 'and say whose it is');
  // Reads must still work, or the exemption's original purpose is lost.
  const branch = hb.match(/if \(name === 'rpcallow'\) \{[\s\S]*?\n {4}\}/)[0];
  assert.doesNotMatch(branch, /fn === 'get'|fn === 'check'/, 'get and check must pass through');
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

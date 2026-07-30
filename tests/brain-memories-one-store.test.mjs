// The owner's memories live on his machine. Every control in the BRAIN panel goes through
// RPC('brain', …) — list, update, remove, tidy, setEnabled, the migration — except three,
// which read and wrote a localStorage twin nothing else ever looked at:
//
//   Add     → db.memories.unshift(...); save(); Toast.show('Memory added')
//   Export  → JSON.stringify({memories: db.memories, ...})
//   Import  → db.memories.push(...)
//
// So "Memory added" was false. The row never appeared in the Memories tab (which reads
// RPC('brain','list')), was never counted, and never reached the model. Verified on this
// machine: zero cfhub brain keys in localStorage, and RPC('brain','list') returning the
// owner's 2 real memories — so an added memory started a fresh orphan store.
//
// It could not even be rescued afterwards. migrateOnce() carried legacy rows to the daemon,
// but only `if (mem.total > 0) return` — i.e. only while the machine store was EMPTY, which
// it was not. The guard was also unnecessary: importMemories → add() dedupes on flattened
// text and returns duplicate:true without writing, so a second run is a no-op by
// construction. It protected nothing and stranded everything.
//
// Export was the quietest of the three: it said "Exported brain-export.json" over a file
// containing NONE of the owner's real memories. He would only have found out restoring it.
//
// Skills are a different matter and are deliberately untouched: the daemon has no skills
// store, so db.skills is where skills genuinely live.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(APP, 'web/panels/brain.js'), 'utf8');
const daemon = fs.readFileSync(path.join(APP, 'bridge/brain.mjs'), 'utf8');

test('adding a memory goes to the machine, not to a browser twin', () => {
  const fn = src.match(/const addMem=async\(\)=>\{[\s\S]*?\n {6}\};/)[0];
  assert.match(fn, /RPC\('brain','add',\{text:t,topic:body\.querySelector\('#bamty'\)\.value,source:'owner'\}\)/);
  assert.doesNotMatch(fn, /db\.memories/, 'the localStorage twin must be gone from this path');
  assert.match(fn, /r\.ok===false/, 'a refusal must not read as success');
  assert.match(fn, /r\.duplicate\?'Already remembered'/, 'and a duplicate is not a new memory');
  assert.match(fn, /await memLoad\(\)/, 'the list the owner is looking at must refresh');
});

test('export reads the memories that actually exist', () => {
  const fn = src.match(/#bexp'\)\.addEventListener\('click',async\(\)=>\{[\s\S]*?\n {6}\}\);/)[0];
  assert.match(fn, /RPC\('brain','list',\{\}\)/, 'memories come from the machine');
  assert.match(fn, /skills:db\.skills/, 'skills genuinely live in the browser — leave them');
  assert.doesNotMatch(fn, /memories:db\.memories/, 'the empty twin must not be what gets exported');
  assert.match(fn, /Nothing exported/, 'a failed read must not claim a file was written');
  assert.match(fn, /'Exported '\+mems\.length/, 'and the count must be measured, not implied');
});

test('import lands memories where the panel and the model read from', () => {
  const fn = src.match(/#bimp'\)\.addEventListener[\s\S]*?f\.click\(\)\}\);/)[0];
  assert.match(fn, /RPC\('brain','importMemories',mIn\)/, 'the same door migrateOnce uses');
  assert.doesNotMatch(fn, /db\.memories\.push/, 'the twin must not be written');
  assert.match(fn, /Skills imported; memories failed/, 'a partial import must say which half failed');
});

test('the migration is once by construction, not once by guard', () => {
  const fn = src.match(/async function migrateOnce\(\)\{[\s\S]*?\n {4}\}/)[0];
  assert.doesNotMatch(fn, /if\(mem\.total>0\)return/,
    'that guard stranded every legacy memory on a machine that already had some');
  assert.match(fn, /old\.memories=\[\]/, 'the handed-over copy must be cleared');
  assert.match(fn, /if\(!r\|\|r\.ok===false\)return/,
    'and NOT cleared when the hand-over failed — that would be data loss');
  // the dedupe that makes re-running safe must still be on the daemon side
  assert.match(daemon, /if \(dup\) return \{ ok: true, id: dup\.id, duplicate: true \}/);
});

test('the topic dropdown offers only topics the daemon accepts', () => {
  // topicOf() coerces anything outside TOPICS to 'fact' in silence. The Add form offered a
  // fifth value, 'contact', which therefore filed itself as 'fact' without saying so.
  assert.doesNotMatch(src, /TYPES=\['contact'/, "the phantom 'contact' topic must be gone");
  assert.doesNotMatch(src, /\bTYPES\b/, 'and its stale list with it');
  assert.match(src, /id="bamty"[^>]*>\$\{\(mem\.topics\|\|Object\.keys\(TOPIC_NOTE\)\)/,
    'the Add form must use the same source as the memory editor');
  assert.match(daemon, /export const TOPICS = \['identity', 'preference', 'project', 'fact'\]/);
});

test('nothing else in the panel still reads the memory twin', () => {
  // Counting occurrences is the wrong instrument — the defensive init alone mentions it
  // twice. What matters is that only two LINES touch it: the init that keeps the legacy
  // shape readable for migrateOnce, and the clear that retires it.
  const lines = src.split('\n')
    .map((l, i) => ({ n: i + 1, l: l.trim() }))
    .filter((x) => /db\.memories/.test(x.l));
  assert.equal(lines.length, 2, 'lines touching db.memories: ' + lines.map((x) => x.n).join(', '));
  assert.match(lines[0].l, /^db\.memories=db\.memories\|\|\[\];/, 'first must be the defensive init');
  assert.match(lines[1].l, /^db\.memories=\[\];$/, 'second must be the clear inside migrateOnce');
  // and no path may read it back out
  assert.doesNotMatch(src, /db\.memories\.(map|filter|find|forEach|unshift|push|some|slice)/,
    'a live read of the twin has come back');
});

test('the built document carries it', () => {
  const dist = path.join(APP, 'dist/index.html');
  if (!fs.existsSync(dist)) return;
  const d = fs.readFileSync(dist, 'utf8');
  assert.ok(d.includes("RPC('brain','add',{text:t,topic:"), 'dist is stale — rebuild');
  assert.ok(!d.includes("TYPES=['contact'"), 'dist still carries the phantom topic');
});

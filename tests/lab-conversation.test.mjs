// Docking the LAB tucks it into a frame square, and the toast says "click the square to
// reopen". But LAB is a single-window panel, so docking ran close(p) — which threw away the
// mount closure and every message in it. A whole conversation, gone, with no warning and no
// way back. The stream in flight was not aborted either: it kept billing the owner's key
// while writing into a bubble nobody would ever see.
//
// The conversation now lives at module scope and on disk; a window is only a VIEW of it.
// Verified in the running app: docked mid-answer with no window open the answer finished
// into the transcript (22 → 362 chars), reopening the square rendered it in full with the
// button back on SEND, a reload restored all four messages, ✕ mid-stream froze the answer
// at 38 chars and kept it, and ＋ cleared both the view and the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const lab = read('web/panels/lab.js');
const app = read('web/index.html');
const dist = fs.existsSync(path.join(HERE, '..', 'dist', 'index.html')) ? read('dist/index.html') : '';
const wire = lab.slice(lab.indexOf('function wireLab(p){'));
const preamble = lab.slice(0, lab.indexOf('function wireLab(p){'));

test('the conversation outlives the window', () => {
  // The whole fix in one line: the mount must not own the messages.
  assert.match(preamble, /const labChat=labChatLoad\(\);/, 'the conversation must be created at module scope');
  assert.match(wire, /const chat=labChat;/, 'wireLab must adopt the shared conversation, not build its own');
  assert.doesNotMatch(wire, /let chat=\{[^}]*msgs:\s*\[\]/, 'a per-window msgs array is back — docking will delete it again');
});

test('it survives a reload too, and cannot eat the storage quota', () => {
  assert.match(preamble, /localStorage\.setItem\(LAB_CHAT_KEY/, 'the transcript must be persisted');
  assert.match(preamble, /addEventListener\('pagehide'/, 'a reload runs no dispose hook — it needs its own save');
  // Unbounded growth in localStorage is a slow-motion outage: one pasted file and every
  // setItem in the app starts throwing.
  assert.match(preamble, /while\(out\.length>LAB_CHAT_BYTES&&msgs\.length>1\)\{msgs\.shift\(\)/,
    'the transcript must be trimmed from the oldest end to a byte ceiling');
  assert.match(preamble, /slice\(-LAB_CHAT_MAX\)/, 'and capped by message count');
  assert.match(preamble, /catch\(_\)\{\}\s*\/\/ a full quota must never break the chat itself/,
    'a storage failure must not propagate into the chat');
});

test('a restored transcript is treated as data, not as trusted state', () => {
  // localStorage is writable by anything that can run script in this origin. A restored
  // message with role:'system' would be a free system-prompt injection on the next send.
  assert.match(preamble, /m\.role==='user'\|\|m\.role==='ai'/, 'restored roles must be allowlisted');
  assert.match(preamble, /typeof m\.content==='string'/, 'restored content must be a string');
  assert.match(preamble, /if\(!o\|\|!Array\.isArray\(o\.msgs\)\)return c;/, 'a corrupt entry must fall back to a blank chat');
});

test('an answer that outlives its window paints nothing and still lands', () => {
  // The old code held the bubble element captured at send time. The painter belongs to the
  // window instead, so a stream whose window is gone finds it null and just fills the
  // transcript — which is exactly what makes "dock mid-answer" work.
  assert.match(wire, /const onTok=t=>\{if\(chat\.gen!==myGen\)return;bot\.content\+=t;if\(chat\.paint\)chat\.paint\(\)\}/,
    'tokens must go to the transcript first and to the DOM only through the live painter');
  assert.match(wire, /function paintStream\(\)\{/, 'the window must own a painter');
  assert.match(wire, /if\(chat\.paint===paintStream\)chat\.paint=null;/,
    'dispose must clear only its OWN painter — never a newer window\'s');
  assert.doesNotMatch(wire, /botRef|botEl|ctEl/, 'a captured bubble element is back — it dies with the window');
});

test('docking keeps the answer running; ✕ cancels it', () => {
  // Two different intentions, one teardown path. The flag is the only thing that tells them
  // apart, and its ABSENCE must mean cancel, so any other close path stops the stream.
  assert.match(app, /p\.dataset\.docking='1';/, 'minimizeToCell must mark a dock before closing a single-window panel');
  assert.match(wire, /if\(!p\.dataset\.docking&&chat\.ctl\)\{chat\.gen\+\+;try\{chat\.ctl\.abort\(\)\}/,
    'closing without the dock flag must abort the stream');
  assert.match(wire, /p\._dispose=\(\)=>\{/, 'LAB must register a dispose hook at all');
  assert.match(wire, /labChatSave\(\);\n\s*\};/, 'dispose must save what is on screen');
});

test('a retired stream cannot write back over the conversation that replaced it', () => {
  // Abort-then-send-again, or ＋ mid-answer: the old send is still unwinding and would set
  // streaming=false and save ITS state over the new one. One generation counter per send.
  assert.match(wire, /const myGen=\+\+chat\.gen;/, 'each send must take a generation');
  assert.match(wire, /if\(chat\.gen!==myGen\)return; \/\/ retired mid-flight/, 'the tail must bail out when retired');
});

test('there is a way to end a conversation', () => {
  // A transcript that now survives docking AND reloads is permanent without this.
  assert.match(lab, /id="labcnew"/, 'the chat bar needs a new-conversation control');
  assert.match(wire, /chat\.msgs\.length=0;chat\.id='c'\+Date\.now\(\)\.toString\(36\)/, 'it must clear the messages and start a new id');
  assert.match(wire, /chat\.gen\+\+;\s*\n?\s*if\(chat\.ctl\)try\{chat\.ctl\.abort\(\)\}/, 'it must retire and abort an answer still in flight');
  assert.match(app, /\.labcbar \.labcnew\{/, 'and it must be styled with the bar it lives in');
});

test('the shipped artifact carries it', () => {
  if (!dist) return;
  for (const needle of ["const LAB_CHAT_KEY='cfhub.lab.chat'", 'const chat=labChat;', "p.dataset.docking='1'",
    'chat.paint=paintStream', 'id="labcnew"']) {
    assert.ok(dist.includes(needle), 'dist/index.html is missing: ' + needle);
  }
});

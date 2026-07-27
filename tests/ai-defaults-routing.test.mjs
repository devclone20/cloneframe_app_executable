// Settings → AI Defaults let the owner say which model does what. It wrote the map to disk,
// showed "Saved", and nothing ever read it: every consumer resolved through the port with no
// capability, which means "whichever provider sorts first". Proven against the real modules
// with two local stub providers — before the fix all four cases answered from the same
// provider with the same model, whatever the map said.
//
// The same resolution gap broke COMPARE differently: the panel sent bare model names, so a
// run mixing two vendors sent BOTH to one of them — and the foreign model came back
// "model not found". The one thing COMPARE exists to do was the one thing it could not do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelPort } from '../bridge/model/port.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');

const A = { id: 'a1', provider: 'openai', kind: 'api', baseUrl: 'https://alpha.test/v1', apiKey: 'k-a', models: ['alpha-fast', 'alpha-max'] };
const B = { id: 'b1', provider: 'openai', kind: 'api', baseUrl: 'https://beta.test/v1', apiKey: 'k-b', models: ['beta-pro'] };
const registry = (defaults) => ({
  _raw: (id) => [A, B].find((p) => p.id === id) || null,
  getDefaults: () => defaults,
  listProviders: () => [A, B].map((p) => ({ id: p.id, enabled: true, models: p.models })),
  _isAnthropic: (provider, baseUrl) => provider === 'anthropic' || /anthropic\.com/.test(String(baseUrl || '')),
});

test('a capability with no default of its own follows Chat', () => {
  // Without this, choosing a model for Chat left every other job — research, recipes,
  // comparisons, an email reply with no row of its own — on "first provider added".
  const port = createModelPort({ registry: registry({ chat: { providerId: 'b1', model: 'beta-pro' } }) });
  for (const cap of ['email_reply', 'email_summary', 'email_tags', 'something_new']) {
    const t = port.resolveTarget({ capability: cap });
    assert.equal(t.providerId, 'b1', cap + ' did not follow the Chat default');
    assert.equal(t.model, 'beta-pro', cap + ' followed the right provider but not its model');
  }
});

test('a capability WITH its own default overrides Chat', () => {
  const port = createModelPort({ registry: registry({ chat: { providerId: 'b1', model: 'beta-pro' }, email_tags: { providerId: 'a1', model: 'alpha-max' } }) });
  const t = port.resolveTarget({ capability: 'email_tags' });
  assert.equal(t.providerId, 'a1');
  assert.equal(t.model, 'alpha-max');
});

test('Chat itself never chases its own tail', () => {
  // defs.chat is the fallback — asking for 'chat' when it is unset must fall through to the
  // provider list, not loop back into the same lookup.
  const port = createModelPort({ registry: registry({}) });
  const t = port.resolveTarget({ capability: 'chat' });
  assert.equal(t.providerId, 'a1', 'an unset chat default must fall back to the first provider');
});

test('an explicit provider still beats every default', () => {
  const port = createModelPort({ registry: registry({ chat: { providerId: 'b1', model: 'beta-pro' } }) });
  assert.equal(port.resolveTarget({ providerId: 'a1', capability: 'chat' }).providerId, 'a1');
});

test('every consumer of ask() actually names a capability', () => {
  const llm = read('bridge/llm.mjs');
  assert.match(llm, /const capability = opts\.capability \|\| 'chat';/, 'ask() must default to the Chat capability');
  assert.match(llm, /const target = port\.resolveTarget\(pick\);/, 'ask() must resolve WITH the capability, not with {}');
  assert.match(llm, /return port\.ask\(msgs, \{ \.\.\.pick,/, 'the port re-resolves internally — the capability must ride along');
  // The email jobs are the three rows Settings offers besides Chat.
  const tasks = read('bridge/tasks.mjs');
  for (const cap of ['email_summary', 'email_reply', 'email_tags']) {
    assert.match(tasks, new RegExp("capability: '" + cap + "'"), 'the ' + cap + ' job does not name its capability');
  }
});

test('an Anthropic model chosen in Settings is not overwritten by the built-in default', () => {
  // ask() used to substitute DEFAULT_MODEL for ANY Anthropic target. That substitution
  // exists only because a bare env key carries no model id — it must not stomp a model the
  // owner picked.
  const llm = read('bridge/llm.mjs');
  assert.match(llm, /target\.anthropic && \(!target\.model \|\| target\.model === 'auto'\) \? DEFAULT_MODEL : target\.model/,
    'the Anthropic default model must only fill in for a missing/auto model');
});

test('the /chat route is governed by the Chat row', () => {
  const chat = read('bridge/domains/chat/chat.mjs');
  assert.match(chat, /const pick = \{ model: body\.model, capability: 'chat' \};/, '/chat must resolve as the chat capability');
  assert.match(chat, /await p\.stream\(messages, \{ \.\.\.pick,/,
    'stream() resolves the target again — without the capability it would pick a different provider than the one just checked');
  assert.match(chat, /resolveTarget\(\{ capability: 'chat' \}\)/, 'the reported brain must be the one that will actually answer');
});

test('COMPARE routes each model to the provider that serves it', () => {
  const cmp = read('bridge/compare.mjs');
  assert.match(cmp, /function splitTarget\(id\) \{/, 'a qualified "<providerId>::<model>" id must be understood');
  assert.match(cmp, /if \(providerId\) opts\.providerId = providerId;/, 'and it must reach ask() as a provider, not just a name');
  assert.match(cmp, /providerId: t\.providerId, model: t\.providerId \? t\.model : await resolveModelId/,
    'a qualified id names a concrete model — only the bare legacy form needs the alias lookup');
  assert.match(cmp, /return i > 0 \?/, 'a bare id must still work — older saved runs and hand-typed aliases');

  const panel = read('web/panels/compare.js');
  assert.match(panel, /const wireId=m=>m\.pid\?m\.pid\+'::'\+m\.model:m\.model;/, 'the panel must send the provider with the model');
  assert.match(panel, /models=st\.models\.map\(wireId\)/, 'and it must actually use it when running');
  assert.match(panel, /data-p="\$\{escAttr\(pr\.id\)\}"/, 'the picker must carry the provider ID, not its display label');
  assert.match(panel, /const sel=new Set\(st\.models\.filter\(m=>m\.pid\)\.map\(wireId\)\);/,
    'two vendors can offer the same model name — the checkbox state must be keyed by provider AND model');
  assert.match(panel, /st\.models=st\.models\.filter\(x=>!\(x\.model===m&&\(x\.pid===pid\|\|!x\.pid\)\)\);/,
    'ticking a model must also clear an older unrouted entry for it, or the run sends it twice');
  assert.match(panel, /const shortModel=/, 'the column header must show the model, not the wire id');
});

test('no source file carries an invisible NUL byte', () => {
  // A stray \x00 landed in compare.js during this change. It is invisible in an editor, it
  // breaks grep, and \x00 is already the app's error-frame marker — an accidental one is a
  // bug waiting to be unexplainable. (mdlite.js and mem-store.mjs use it on purpose, at the
  // repo root and in bridge/platform; the panels never should.)
  const dir = path.join(HERE, '..', 'web', 'panels');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const buf = fs.readFileSync(path.join(dir, f));
    assert.equal(buf.indexOf(0), -1, 'web/panels/' + f + ' contains a raw NUL byte');
  }
});

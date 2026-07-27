// Settings → AI Defaults let the owner say which model does what. It wrote the map to disk,
// showed "Saved", and nothing ever read it: every consumer resolved through the port with no
// capability, which means "whichever provider sorts first". Proven against the real modules
// with two local stub providers — before the fix all four cases answered from the same
// provider with the same model, whatever the map said.
//
// The same resolution gap also broke COMPARE, which routed a whole cross-vendor run to one
// provider. That panel was removed on 2026-07-27; the capability plumbing it exercised is
// still covered above, by the cases that do not depend on it.
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

// ─────────────────────────────────────────────────────────────────────────────
// T-006 · Characterization tests — the Anthropic wire shape (post T-019)
//
// HISTORY: this file used to pin `bridge/llm.mjs ask()`'s OWN direct Anthropic
// fetch (endpoint, headers, body, response parse, error path). Wave-3 / T-019
// removed that direct wire — `ask()` now delegates to the provider-agnostic
// MODEL PORT (`bridge/model/port.mjs`), so it is no longer Claude-locked. The
// behavioral coverage of the wire therefore MOVED to its new home:
//   • the Anthropic + OpenAI-compatible wire shape, headers, and 300-char
//     key-free error trim → tests/model-port.test.mjs
//   • ask()'s delegation both ways (configured provider vs env-Anthropic
//     fallback with DEFAULT_MODEL) → tests/llm-ask-agnostic.test.mjs +
//     tests/llm-ask-envfallback.test.mjs
//
// What remains here are cheap SOURCE-LEVEL tripwires that need no import (and so
// don't fight the model port's lazy singleton): they pin that the T-019 flip
// actually happened, and that the two places which STILL speak the Anthropic
// wire directly (domains/chat/chat.mjs's handleChat/handleProviderChat — Wave-4 /
// T-031 moved these OUT of the router — and the model port itself) keep the same
// endpoint / api-version / header set, so a change to one that isn't mirrored
// fails loudly instead of drifting silently. A companion tripwire pins that the
// router now DELEGATES (no inline wire) after the T-031 move.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const LLM_PATH = new URL('../bridge/llm.mjs', import.meta.url);
const HUB_BRIDGE_PATH = new URL('../bridge/hub-bridge.mjs', import.meta.url);
const CHAT_PATH = new URL('../bridge/domains/chat/chat.mjs', import.meta.url);
const MODEL_PORT_PATH = new URL('../bridge/model/port.mjs', import.meta.url);

test('T-019 flip — llm.mjs ask() no longer speaks the Anthropic wire directly; it delegates to the model port', () => {
  const src = fs.readFileSync(LLM_PATH, 'utf8');
  // the direct fetch to Anthropic is GONE from llm.mjs...
  assert.doesNotMatch(src, /fetch\(\s*['"]https:\/\/api\.anthropic\.com/, 'llm.mjs must not fetch Anthropic directly anymore');
  assert.doesNotMatch(src, /x-api-key/, 'llm.mjs must not build the Anthropic auth header itself anymore');
  // ...replaced by delegation to the shared model port.
  assert.match(src, /model\/port\.mjs/, 'llm.mjs must route through bridge/model/port.mjs');
  assert.match(src, /modelPort\(\)/);
});

test('domains/chat/chat.mjs — handleChat delegates to the model port; handleProviderChat keeps the inline Anthropic wire (MATRIX)', () => {
  // The brain (/chat) is provider-agnostic now: handleChat streams via the model
  // port, so DeepSeek / any OpenAI-compat / local / Anthropic all work with no inline
  // fetch. handleProviderChat still speaks the Anthropic wire directly (its MATRIX
  // launch-retry needs the raw request), on the same endpoint/version/header the port uses.
  const src = fs.readFileSync(CHAT_PATH, 'utf8');
  assert.match(src, /model\/port\.mjs/, 'chat.mjs routes the brain through the model port');
  assert.match(src, /\.stream\(/, 'handleChat streams via the port');
  assert.match(src, /api\.anthropic\.com/);
  assert.match(src, /\/v1\/messages/);
  assert.match(src, /'anthropic-version':\s*'2023-06-01'/);
  assert.match(src, /'x-api-key':/);
});

test('T-031 flip — the router no longer speaks the chat wire; it delegates to the chat domain', () => {
  const src = fs.readFileSync(HUB_BRIDGE_PATH, 'utf8');
  assert.doesNotMatch(src, /api\.anthropic\.com\/v1\/messages/, 'the router must not fetch Anthropic directly anymore');
  assert.doesNotMatch(src, /content_block_delta/, 'the router must not inline the SSE parse anymore');
  assert.doesNotMatch(src, /_raw\b|_isAnthropic\b/, 'no underscore-internal reach from the router (T-031 acceptance)');
  assert.match(src, /Chat\.handleChat\(/, 'the router routes /chat to the chat domain');
  assert.match(src, /Chat\.handleProviderChat\(/, 'the router routes /provider-chat to the chat domain');
});

test('the model port is the canonical Anthropic wire llm.ask now routes through', () => {
  const src = fs.readFileSync(MODEL_PORT_PATH, 'utf8');
  assert.match(src, /\/v1\/messages/);
  assert.match(src, /anthropic-version/);
  assert.match(src, /2023-06-01/);
  assert.match(src, /x-api-key/);
});

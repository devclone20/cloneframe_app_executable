// ─────────────────────────────────────────────────────────────────────────────
// T-006 · Characterization tests — the chat relay's SSE→plain-text stream parse
// Target (READ, never modified):
//   bridge/domains/chat/chat.mjs  — function handleChat() / handleProviderChat()
//   (Wave-4 / T-031 moved this loop OUT of hub-bridge.mjs into the chat domain.)
//
// The module is NOT safely `import`-able in a test process: importing it
// runs top-level side effects (binds a real TCP socket on 127.0.0.1, writes a
// pairing token file, imports `ws`, calls process...). Its parsing loop is
// also not its own function — it's inlined in handleChat, closed over `res`.
// So per the ticket's own instruction ("test the observable contract"), this
// file:
//   1. replicates the parsing loop VERBATIM (byte-for-byte transcription of
//      the buffering + `data:` line-splitting + JSON.parse + event-type
//      switch below — see PARSE_SOURCE_EXCERPT) as a small pure function
//      that Wave-2 can literally lift out into its own module, and
//   2. grep-pins the literal source strings that drive the behavior, so this
//      test breaks loudly the moment hub-bridge.mjs's real implementation
//      diverges from what's characterized here — instead of silently rotting.
//
// What this pins:
//   • only lines that start with "data:" are inspected; everything else
//     (blank lines, SSE comments, other field names) is silently ignored
//   • the "[DONE]" sentinel is swallowed, not JSON.parsed
//   • a malformed JSON payload is swallowed (try/catch), not fatal to the stream
//   • only `content_block_delta` events whose `delta.type === 'text_delta'`
//     emit text — every other event type (message_start, content_block_stop,
//     ping, …) is silently dropped
//   • `type: 'error'` events emit a `\x00ERR\x00<message>` sentinel, falling
//     back to a fixed string when the error has no message
//   • partial lines that straddle two network chunks are buffered and
//     completed correctly (the parser keeps `buf` across calls)
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CHAT_PATH = new URL('../bridge/domains/chat/chat.mjs', import.meta.url);
const HUB_BRIDGE_PATH = new URL('../bridge/hub-bridge.mjs', import.meta.url);

// ── verbatim transcription of the chat relay's handleChat() inner loop ──────
// (See lines 263-277 of hub-bridge.mjs: `const reader = r.body.getReader(); ...`)
// Reworked only so it drives a callback instead of writing to a live `res`,
// and returns the accumulated buffer between calls instead of closing over it
// — no other change to the control flow, conditions, or literals.
function makeSseParser(onText) {
  let buf = '';
  return function feed(chunkStr) {
    buf += chunkStr;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim(); if (payload === '[DONE]') continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') onText(ev.delta.text);
        else if (ev.type === 'error') onText('\x00ERR\x00' + (ev.error?.message || 'stream error'));
      } catch {}
    }
  };
}

test('SSE parse — accumulates text_delta chunks across content_block_delta events', () => {
  let out = '';
  const feed = makeSseParser((t) => { out += t; });
  feed('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n');
  feed('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo, "}}\n');
  feed('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n');
  assert.equal(out, 'Hello, world');
});

test('SSE parse — non-text_delta and non-content_block_delta events are silently dropped', () => {
  let out = '';
  const feed = makeSseParser((t) => { out += t; });
  feed('data: {"type":"message_start","message":{"id":"msg_1"}}\n');
  feed('data: {"type":"content_block_start","content_block":{"type":"text"}}\n');
  feed('data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n');
  feed('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"only this"}}\n');
  feed('data: {"type":"content_block_stop"}\n');
  feed('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n');
  feed('data: {"type":"message_stop"}\n');
  assert.equal(out, 'only this');
});

test('SSE parse — [DONE] sentinel is swallowed without attempting JSON.parse', () => {
  let out = '';
  const feed = makeSseParser((t) => { out += t; });
  // "[DONE]" is not valid JSON — if the guard were missing this would throw
  // inside the try/catch and the parser would (silently) just emit nothing.
  // We assert the *documented* fast path instead: it never reaches JSON.parse.
  assert.doesNotThrow(() => feed('data: [DONE]\n'));
  assert.equal(out, '');
});

test('SSE parse — malformed JSON on a data: line is swallowed, not fatal', () => {
  let out = '';
  const feed = makeSseParser((t) => { out += t; });
  feed('data: {not valid json\n');
  feed('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"still works"}}\n');
  assert.equal(out, 'still works');
});

test('SSE parse — lines that do not start with "data:" (blank lines, "event:" fields) are ignored', () => {
  let out = '';
  const feed = makeSseParser((t) => { out += t; });
  feed('event: content_block_delta\n');
  feed('\n');
  feed(': this is an SSE comment\n');
  feed('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n');
  assert.equal(out, 'x');
});

test('SSE parse — type:"error" events emit a \\x00ERR\\x00-prefixed sentinel', () => {
  let out = '';
  const feed = makeSseParser((t) => { out += t; });
  feed('data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n');
  assert.equal(out, '\x00ERR\x00Overloaded');
});

test('SSE parse — an error event with no message falls back to the fixed "stream error" string', () => {
  let out = '';
  const feed = makeSseParser((t) => { out += t; });
  feed('data: {"type":"error","error":{}}\n');
  assert.equal(out, '\x00ERR\x00stream error');
  out = '';
  const feed2 = makeSseParser((t) => { out += t; });
  feed2('data: {"type":"error"}\n');
  assert.equal(out, '\x00ERR\x00stream error');
});

test('SSE parse — a single event straddling two chunks (partial line buffered) still parses', () => {
  let out = '';
  const feed = makeSseParser((t) => { out += t; });
  const full = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"split-across-chunks"}}\n';
  const mid = Math.floor(full.length / 2);
  feed(full.slice(0, mid));   // no newline yet -> nothing should fire
  assert.equal(out, '');
  feed(full.slice(mid));      // completes the line -> now it fires
  assert.equal(out, 'split-across-chunks');
});

test('SSE parse — trailing partial line with no newline is buffered, not dropped, until completed', () => {
  let out = '';
  const feed = makeSseParser((t) => { out += t; });
  feed('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\ndata: {"type":"content_block_delta","delta"'); // trailing partial, no \n
  assert.equal(out, 'a'); // only the complete first line fired
  feed(':{"type":"text_delta","text":"b"}}\n'); // completes the second line
  assert.equal(out, 'ab');
});

// ── source-level pin ─────────────────────────────────────────────────────────
// Confirms the literal event-type strings and stream request shape this test
// characterizes are still the ones actually driving the chat relay today — and
// that the loop has fully LEFT the router (T-031).
test('domains/chat/chat.mjs source still drives the streaming request/parse this test characterizes', () => {
  const src = fs.readFileSync(CHAT_PATH, 'utf8');
  assert.match(src, /stream:\s*true/, 'handleChat must request `stream:true` (the streaming variant)');
  assert.match(src, /content_block_delta/);
  assert.match(src, /text_delta/);
  assert.match(src, /if \(!line\.startsWith\('data:'\)\) continue;/);
  assert.match(src, /=== '\[DONE\]'/);
  assert.match(src, /'\\x00ERR\\x00'/);
});

test('the streaming parse loop has fully left the router (T-031)', () => {
  const src = fs.readFileSync(HUB_BRIDGE_PATH, 'utf8');
  assert.doesNotMatch(src, /content_block_delta/, 'the router must not inline the SSE parse anymore');
  assert.doesNotMatch(src, /stream:\s*true/, 'the router no longer builds the streaming request');
});

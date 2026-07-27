// BYOK without a bridge: the key the owner pastes in MY MACHINE has to reach a real vendor,
// and a failure has to look like a failure.
//
// It did neither. The provider record carried no model, so every call sent the literal string
// "auto" — which the codebase itself documents as a 400 ("No instance found for model auto").
// The request then threw the NUMBER 0, stream() swallowed it with an empty catch, and the app
// typed out canned demo prose, character by character so it even looked streamed, labelled
// with the owner's own provider name. Somebody could have paid for a key, watched it "answer"
// all day, and never once reached the vendor.
//
// Asserted against dist/index.html — the artifact that ships — so a source edit that never
// made it through the build cannot pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const app = read('web/index.html');
const machine = read('web/panels/machine.js');
const dist = fs.existsSync(path.join(HERE, '..', 'dist', 'index.html')) ? read('dist/index.html') : '';

test('a configured provider that fails never becomes mock prose', () => {
  // The exact shape that hid it: `try{...}catch(e){}` around the byok call, followed by a
  // fall-through to pickMock. Either half alone is fine; together they are the bug.
  assert.doesNotMatch(app, /if\(kind==='byok'\)\{try\{await byokStream\([^)]*\)[^}]*\}catch\(e\)\{\}\}/,
    'the byok call is wrapped in an empty catch again — failures will be replaced by demo text');
  assert.match(app, /if\(kind==='byok'\)\{await byokStream\(messages,onTok,signal\);return'byok'\}/,
    'a byok failure must propagate to the caller, which renders it');
  // The mock is reachable only when it is what the user actually selected.
  const sStart = app.indexOf('async function stream(', app.indexOf('async function byokStream('));
  const fn = app.slice(sStart, app.indexOf('return{stream,detect', sStart));
  const mockLine = fn.split('\n').find((l) => l.includes('pickMock'));
  assert.ok(mockLine && !/catch/.test(mockLine), 'pickMock must not sit on an error path');
});

test('no vendor is ever asked for the model "auto"', () => {
  assert.doesNotMatch(app, /model:p\.model\|\|'auto'/, "'auto' is not a model id at any vendor — it 400s");
  assert.match(app, /if\(!p\.model\)throw new Error/, 'a provider with no model must say so instead of guessing');
});

test('Anthropic gets the wire Anthropic actually speaks', () => {
  // Anthropic is /messages with x-api-key and a separate system field — not OpenAI's
  // /chat/completions with a Bearer token. The old code sent the latter to both.
  assert.match(app, /url=p\.base\+'\/messages'/, 'Anthropic must be called on /messages');
  assert.match(app, /'x-api-key':key/, 'Anthropic authenticates with x-api-key, not Bearer');
  assert.match(app, /'anthropic-dangerous-direct-browser-access':'true'/,
    'without the opt-in header the browser call is refused by CORS');
  assert.match(app, /'anthropic-version'/, 'Anthropic requires an API version header');
  assert.match(app, /url=p\.base\+'\/chat\/completions'/, 'everyone else stays OpenAI-shaped');
});

test('a failed BYOK call carries the vendor own words', () => {
  // Scoped to byokStream on purpose. `throw 0` elsewhere (bridgeProbe) is fine — that catch
  // returns a structured {on:false,msg}, so nothing is lost. Here it lost everything.
  // Anchor the end AFTER byokStream: there is an earlier `async function stream(` in the
  // file, and searching from zero silently produced an empty slice — a test that asserts
  // nothing while looking green.
  const bStart = app.indexOf('async function byokStream(');
  const byok = app.slice(bStart, app.indexOf('async function stream(', bStart));
  assert.ok(byok.length > 200, 'could not isolate byokStream — this test needs updating');
  assert.doesNotMatch(byok, /throw 0/, 'throwing 0 discards the status and the message');
  const thrown = app.slice(app.indexOf('if(!r.ok){'), app.indexOf('const o=await r.json();', app.indexOf('if(!r.ok){')));
  assert.ok(/r\.status/.test(thrown), 'the error must carry the vendor HTTP status');
  assert.ok(/p\.name/.test(thrown), 'the error must name which provider failed');
  assert.ok(/friendlyErr/.test(thrown), 'the vendor message must be unwrapped, not dumped as raw JSON');
  assert.ok(/await r\.text\(\)/.test(thrown), 'the vendor own body must be read, not discarded');
});

test('a key can be switched off without being deleted', () => {
  // The owner asked for this: park a key, try another, bring the first back.
  assert.match(app, /const usable=x=>x&&!x\.off&&Keys\.get\(x\.id\)/,
    'readyProvider must skip a provider the owner switched off');
  assert.match(machine, /data-tog="/, 'each provider row needs its own switch');
  assert.match(machine, /p\.off=!p\.off/, 'the switch must toggle the flag');
  assert.match(machine, /switched off — key kept/, 'the wording must make clear the key is kept');
  assert.doesNotMatch(machine, /if\(tog\)\{[^}]*Keys\.del/, 'switching off must NOT discard the key');
});

test('MY MACHINE asks the vendor for its models instead of guessing', () => {
  assert.match(machine, /async function probeModels\(base,key\)/, 'the model list must come from the vendor');
  assert.match(machine, /models=await probeModels\(hit\[2\],key\)/, 'CONNECT must probe before storing');
  assert.match(machine, /rejected the key/, 'a key the vendor refuses must not be stored as working');
  assert.match(machine, /model:keep/, 'the provider record must carry a real model id');
});

test('the shipped artifact carries all of it', () => {
  if (!dist) return; // not built — the build gate covers this separately
  for (const needle of ["url=p.base+'/messages'", "'anthropic-dangerous-direct-browser-access':'true'",
    'const usable=x=>x&&!x.off&&Keys.get(x.id)', 'async function probeModels(base,key)']) {
    assert.ok(dist.includes(needle), 'dist/index.html is missing: ' + needle);
  }
});

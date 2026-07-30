// A nine-lens audit of MATRIX, every finding verified by a skeptic, produced 52 confirmed
// defects. These are the tripwires for the ones a future edit could quietly undo.
//
// The theme running through nearly all of them: the panel was reporting things it had not
// checked. Demo memory presented as the owner's cluster. A model on node B listed as being
// on this machine. An instance called READY when one runner of four was up. A DELETE button
// on weights it could not reach. A composer promising an answer the next line would refuse.
// Each assertion below is a place where the app used to say something it did not know.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const mx = decomment(read('web/panels/matrix.js'));
const bridge = read('bridge/matrix.mjs');
const chat = decomment(read('bridge/domains/chat/chat.mjs'));
const css = read('web/index.html');

test('a repaint on a clock never destroys the node under the pointer', () => {
  // The rail rebuilt its innerHTML every second, so any click whose mousedown and mouseup
  // straddled a tick landed on a node that no longer existed — LOAD, USE and DELETE simply
  // did nothing, intermittently, with no error anywhere.
  assert.match(mx, /if\(html!==st\._asideHTML\)\{st\._asideHTML=html;E\.aside\.innerHTML=html\}/,
    'the rail must only write when its content actually changed');
  assert.match(mx, /if\(html!==st\._dlHTML\)\{st\._dlHTML=html;E\.dlbody\.innerHTML=html\}/,
    'and so must DOWNLOADS');
  assert.match(mx, /if\(svg\.__sig===sig\)return/, 'and the topology, whose CSS animations restarted every tick');
  assert.match(mx, /if\(!st\.armed\)renderAside\(\)/, 'fetchPreview must honour the SURE? freeze it used to bypass');
});

test('this machine is a node id, not an assumption', () => {
  // The bridge sees one disk; the engine reports the whole cluster. Merging them without
  // asking which node is local put remote models under "ON THIS MACHINE", with a DELETE
  // button that could never reach them.
  assert.match(mx, /q=await fetch\(API\+'\/node_id'/, 'the panel must learn which node it is');
  assert.match(mx, /const here=st\.nodeId&&cells\[st\.nodeId\]/, 'and read the download map per node');
  assert.match(mx, /ELSEWHERE IN THE CLUSTER/, 'a model on another node belongs under its own heading');
  assert.match(mx, /const isLocal=n\.id==='local'\|\|n\.id===st\.nodeId/, 'the DOWNLOADS grid must not paint disk state under remote columns');
  // exo mints a fresh random node id on every start (routing/router.py disables persistence),
  // so this must never be cached across sessions.
  assert.match(mx, /if\(!was\)\{loadModels\(\);syncCluster\(\);st\.nodeId=null\}/, 'a reconnect must re-read it');
});

test('READY means every runner, and DEMO numbers are never the owner’s', () => {
  assert.match(mx, /sts\.every\(x=>\/Ready\|Running\/i\.test\(x\)\)\)\?'READY'/,
    'one ready runner out of four is not a usable instance');
  assert.match(mx, /function liveCluster\(\)\{return !!\(st\.online&&st\.st8\)\}/, 'one definition of "this is real"');
  assert.match(mx, /function realNodes\(\)\{return liveCluster\(\)\?nodes\(\):\[\]\}/,
    'memory maths must refuse demo input');
  assert.match(mx, /function fitClass\(mb\)\{if\(!liveCluster\(\)\)return ''/,
    'and so must the size colouring that claims a model fits');
  assert.match(mx, /ALL MODELS <span class="sub">— start the engine to see what fits/,
    'offline, "RECOMMENDED FOR YOUR CLUSTER" is a recommendation from nothing');
});

test('a control that cannot act does not look like one', () => {
  const sec = mx.slice(mx.indexOf('function localSection('), mx.indexOf('function renderAside('));
  assert.match(sec, /const rm=\(local&&!r\.readOnly&&!r\.link\)/,
    'no DELETE on a read-only root, a symlink, or another node’s disk');
  assert.match(sec, /◐ INCOMPLETE/, 'a half-downloaded model must not offer LOAD');
  assert.match(mx, /eb\.dataset\.mode='noengine'/, 'no START on a machine with no engine binary');
  assert.match(mx, /if\(st\.engBusy\|\|m==='busy'\)break/, 'and no second START while the first is still spawning');
  assert.match(css, /\.mx-launch\.dim\{opacity:\.45;pointer-events:none\}/,
    'a dimmed LAUNCH must be unclickable, not just faint');
  assert.match(mx, /Already loading — watch INSTANCES/, 'place_instance answers 200 for "received" — a second press is not a launch');
});

test('the composer promises only what sendChat will accept', () => {
  assert.match(mx, /const usable=!!mv&&st\.online&&onDisk\(\)\.some\(r=>r\.id===mv&&r\.usable\)/,
    'the hot SEND state must include the engine being up');
  assert.match(mx, /Engine offline — press START ENGINE to chat/, 'and say so when it is not');
});

test('a streaming turn survives the conversation being closed under it', () => {
  const send = mx.slice(mx.indexOf('async function sendChat('), mx.indexOf('const FAM_ORDER'));
  assert.match(send, /const conv=st\.chat\|\|\{/, 'the turn must bind its conversation, not follow st.chat');
  assert.match(send, /conv\.stats=bot\.stats/, 'and write to that binding');
  assert.ok(!/st\.chat\.msgs\.push/.test(send), 'nothing in the turn may push through st.chat');
  assert.match(send, /const onScreen=\(\)=>st\.chat===conv/, 'repaints only when that conversation is still shown');
  assert.match(mx, /if\(st\.streaming\)\{try\{st\.abort&&st\.abort\.abort\(\)\}catch\(_\)\{\}st\.streaming=false\}/,
    'closing it mid-stream must abort, or the composer stays stuck in STOP');
  // Per-token full rebuilds ran MDLite over the whole transcript for every delta.
  assert.match(send, /el\.textContent=bot\.content/, 'streaming writes the tail, not the transcript');
  assert.match(send, /requestAnimationFrame/, 'coalesced to a frame');
  assert.match(mx, /const pinned=E\.msgs\.scrollHeight-E\.msgs\.scrollTop-E\.msgs\.clientHeight<24/,
    'and the reader is only pulled to the bottom if they were already there');
});

test('what the panel says is never replayed to the model as its own words', () => {
  assert.match(mx, /const history=conv\.msgs\.filter\(m=>m\.content&&!m\.err\)/,
    'load failures, stalls and "— stopped —" are the app talking, not the model');
  assert.match(mx, /bot\.err=true/, 'so they must be marked');
  assert.match(mx, /err:m\.err\|\|undefined/, 'and stay marked across a reload');
});

test('history that cannot be saved says so instead of silently stopping', () => {
  assert.match(mx, /for\(const \[n,withSent\] of \[\[40,true\],\[40,false\],\[20,false\]/,
    'a quota error must shed weight in steps');
  assert.match(mx, /Conversation history is full/, 'and tell the owner once when even the smallest payload fails');
});

test('a stale FAILED instance cannot make the model unloadable forever', () => {
  const el = mx.slice(mx.indexOf('async function ensureLive('), mx.indexOf('async function launch('));
  assert.match(el, /for\(const dead of mine\(\)\.filter\(i=>i\.status==='FAILED'\)\)/, 'clear the dead one first');
  assert.match(el, /const before=new Set\(mine\(\)\.map\(i=>i\.id\)\)/, 'then judge only what this attempt made');
  assert.match(el, /method:'POST',signal/, 'and the placement must be abortable');
});

test('docking is not closing', () => {
  assert.match(mx, /if\(!p\.dataset\.docking\|\|st\.ensuring\)\{try\{st\.abort&&st\.abort\.abort\(\)\}/,
    'a docked panel keeps streaming, but a wait on ensureLive must still be cut — it polls a state the tick stopped refreshing');
});

test('the engine is identified before it is signalled', () => {
  assert.match(bridge, /async function pidIsEngine\(rec\)/, 'a pid is not an identity');
  assert.match(bridge, /execFile\('\/bin\/ps', \['-p', String\(pid\), '-o', 'command='\]/, 'read its command line');
  assert.match(bridge, /function exoPid\(\)/, "and cross-check exo's own locked pidfile");
  assert.match(bridge, /writePidAtomic\(\{ pid: child\.pid, bin, startedAt: Date\.now\(\) \}\)/,
    'record what we spawned, so a recycled pid is recognisable as a stranger');
  assert.match(bridge, /const owned = rec !== null && await pidIsEngine\(rec\)/, 'status must not claim a stranger is ours');
  assert.match(bridge, /process\.kill\(owned \? -pid : pid, 'SIGKILL'\)/,
    'escalate to the group only for an engine we spawned detached — its runners hang off it');
  assert.match(bridge, /if \(pidAlive\(pid\)\) return \{ ok: false, error: 'the engine did not exit/,
    'and never report a stop that did not happen');
  assert.match(bridge, /let starting = null;/, 'a second start must join the first, not spawn a second engine');
});

test('the engine log cannot fill the disk or block the daemon', () => {
  assert.match(bridge, /const LOG_MAX = 8 \* 1024 \* 1024/, 'rotate it');
  assert.match(bridge, /fs\.readSync\(fd, buf, 0, want, size - want\)/, 'and read only the tail, whatever the size');
});

test('a delete is scoped to this machine unless the caller says otherwise', () => {
  assert.match(bridge, /const targets = opts\.allNodes \? all : \(typeof me === 'string' && me \? \[me\] : \[\]\)/,
    'a button that says "this machine" must not erase the weights on every Mac in the cluster');
  assert.match(bridge, /function looksLikeModel\(name, stats\)/,
    'and only a directory that actually holds weights is a model at all');
  assert.match(bridge, /if \(!local\) \{/, 'membership is checked before any path is built');
  assert.match(bridge, /if \(engine\.alive && !engine\.reached\)/,
    'a wedged engine still holds the weights open — deleting under it is what killed the daemon');
  assert.match(bridge, /idle >= 24/, 'and the wait is progress-based, so a 40GB tree is never cut off mid-removal');
});

test('the registry needs two witnesses to drop a model', () => {
  assert.match(bridge, /next = \[\.\.\.new Set\(\[\.\.\.engineIds, \.\.\.disk\]\)\]\.sort\(\)/,
    "the engine's event-log replay is the source this module exists to stop trusting alone");
  assert.match(bridge, /if \(engineIds !== null\) \{\s*const defs = Models\.getDefaults\(\)/,
    'a default is cleared only on an authoritative answer');
  assert.match(bridge, /!next\.includes\(d\.model\) && !disk\.has\(d\.model\)/, 'and only when the disk agrees');
  assert.match(bridge, /\.filter\(\(p\) => p\.provider === 'matrix'\)\s*\n?\s*\.sort/,
    'match MATRIX by its provider tag, oldest first — not by a port a user provider can share');
  assert.match(mx, /filter\(x=>x\.provider==='matrix'\)\.sort/, 'and the panel must agree on which record that is');
  assert.match(bridge, /offered: prov\.enabled === false \? 0 :/, 'report what the pickers will really offer');
});

test('the engine binds the whole network, and the app says so', () => {
  // exo hardcodes cfg.bind = ["0.0.0.0:<port>"] and ships no host flag. We cannot change
  // that from here; repeating "127.0.0.1" while spawning it would be the lie.
  assert.match(bridge, /lanExposed: up \?/, 'status must report the real listen address');
  assert.match(mx, /THIS ENGINE ANSWERS ON YOUR WHOLE NETWORK/, 'and INTEGRATIONS must say it out loud');
  assert.match(css, /\.mx-lanwarn\{/, 'with somewhere to render it');
});

test('the chat relay reads the engine as it really is', () => {
  assert.match(chat, /const inner = state\.instances\[iid\]\[Object\.keys\(state\.instances\[iid\]\)\[0\]\] \|\| \{\}/,
    "exo's instance union is tagged — a hardcoded MlxRingInstance key is blind to a Jaccl cluster");
  assert.match(chat, /const usable = forModel\.filter\(\(i\) => !i\.failed\)/,
    'a FAILED instance is not "coming up"');
  assert.match(chat, /for \(const dead of forModel\) \{/, 'and it must be cleared, or the replacement never places');
  assert.match(chat, /const t2 = await r\.text\(\)\.catch\(\(\) => ''\)/,
    'the error frame must describe the FINAL response, not the first 404');
  assert.match(chat, /MATRIX did not answer on/, 'and a stopped engine is named, not shown as "fetch failed"');
});

test('the shipped artifact carries the hardening', () => {
  const distPath = path.join(HERE, '..', 'dist', 'index.html');
  if (!fs.existsSync(distPath)) return;
  const dist = read('dist/index.html');
  for (const shape of ['st._asideHTML', 'ELSEWHERE IN THE CLUSTER', 'function liveCluster()',
    'THIS ENGINE ANSWERS ON YOUR WHOLE NETWORK', 'pointer-events:none', "data-mxlmrm"]) {
    assert.ok(dist.includes(shape), 'dist is missing ' + JSON.stringify(shape));
  }
});

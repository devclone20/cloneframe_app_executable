// The CODE ↔ pi path: conversation context across process death, model honesty, a stop that
// stops, per-conversation composer state, and the turn actually ending.
//
// Every test here pins a defect the owner met on screen: "the agent has no context", "it is
// not using the model I picked", "the stop button does nothing", "my sentence follows me into
// another session", "it clogs and never finishes".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A temp HOME before ANY bridge import: pi.mjs resolves CONFIG_DIR at module load.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-pipath-'));
process.env.HOME = HOME;
const APP = path.resolve(import.meta.dirname, '..');

const src = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
// Comments describe intent; assertions must hold against CODE, not prose. Line comments go
// FIRST: a prose line like `// any bridge/*.mjs newer on disk` opens a block comment that
// otherwise swallows real code up to the next `*/`.
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const PI = decomment(src('bridge/pi.mjs'));
const PANEL = decomment(src('web/panels/terminal.js'));
const SHELL = decomment(src('web/index.html'));
const BRIDGE = decomment(src('bridge/hub-bridge.mjs'));

// ── 1. conversation context survives the process ────────────────────────────
test('a fresh pi process is handed the conversation it is joining', async () => {
  const { Pi } = await import('../bridge/pi.mjs');
  assert.ok(typeof Pi.handlePiChat === 'function');
  // the transcript travels on the request…
  assert.match(SHELL, /body\.history\s*=\s*history/, 'piChat must send the history it was given');
  assert.match(PANEL, /\},sig,imgs\|\|\[\],history\)/, 'piRun must pass a history to the client');
  // …and is replayed only into a process that has no memory of it
  assert.match(PI, /if\s*\(!this\.primed\)/, 'priming must be conditional on the process being new');
  assert.match(PI, /this\.primed\s*=\s*false/, 'a spawn must reset primed');
});

test('the replayed transcript is framed as the agent’s own memory, not as new instructions', () => {
  const m = PI.match(/function historyPreamble[\s\S]*?\n}/);
  assert.ok(m, 'historyPreamble must exist');
  const fn = m[0];
  assert.match(fn, /conversation_so_far/, 'the block must be delimited');
  assert.match(fn, /do NOT redo tool calls/i, 'it must forbid re-running tools it already ran');
  assert.match(fn, /HIST_CHARS|24_000|\d{4,}/, 'it must be budgeted, not unbounded');
});

test('history is budgeted newest-first so a long conversation keeps its tail', async () => {
  const { Pi } = await import('../bridge/pi.mjs');
  // exercised through the module's own limit constant: the loop walks backwards
  const fn = PI.match(/function historyPreamble[\s\S]*?\n}/)[0];
  assert.match(fn, /for\s*\(let i = history\.length - 1; i >= 0; i--\)/, 'must walk newest → oldest');
  assert.match(fn, /rows\.unshift/, 'and restore chronological order for the model');
  assert.ok(Pi);
});

test('the message being sent is not duplicated at the tail of the replayed history', () => {
  assert.match(PANEL, /history\[history\.length-1\]\.role==='user'\)history\.pop\(\)/,
    'the current turn arrives as the prompt; it must not also close the history');
});

// ── 2. the model that answers is the model that was picked ──────────────────
test('an unresolvable provider pick is an error, never a silent swap to pi’s own model', () => {
  const fn = PI.match(/async function resolveModel[\s\S]*?\n}/)[0];
  assert.match(fn, /return \{ error:/, 'must return an error marker');
  assert.doesNotMatch(fn, /if \(!cfg \|\| !modelId\) return \{ key: '__pi__'/,
    'the old silent fallback must be gone');
  // and the route must refuse rather than run
  assert.match(PI, /if \(resolved\.error\)[\s\S]{0,220}res\.end\(\)/, 'handlePiChat must stop on it');
});

test('Google’s /v1beta/openai base is not corrupted by appending /v1', () => {
  const fn = PI.match(/async function resolveModel[\s\S]*?\n}/)[0];
  assert.ok(fn.includes('!/\\/v\\d+[a-z]*(\\/[^/]*)?$/i.test(base)'),
    'the version-segment guard must accept a versioned segment anywhere at the tail');
  // reproduce the guard the module uses and prove the real Gemini base is left alone
  const guard = /\/v\d+[a-z]*(\/[^/]*)?$/i;
  assert.ok(guard.test('https://generativelanguage.googleapis.com/v1beta/openai'),
    'Gemini base must be recognised as already versioned');
  assert.ok(guard.test('https://api.openai.com/v1'), 'a bare /v1 base must still be recognised');
  assert.ok(!guard.test('https://openrouter.ai/api'), 'an unversioned base must still get /v1');
});

test('the stream states which engine actually answered', () => {
  assert.match(PI, /t: 'meta', model: this\.model/, 'a meta frame must carry the resolved model');
  assert.match(PANEL, /ev\.t==='meta'/, 'the panel must render it');
});

test('a session pinned to pi never falls through to the machine brain', () => {
  assert.match(PANEL, /if\(wants&&!piOk\)await refreshPiOk\(\)/,
    'a stale probe must be re-asked before routing');
  assert.match(PANEL, /pi is not available on this machine right now/,
    'and if pi is really gone the owner is told, not silently rerouted');
  assert.match(PANEL, /async function refreshPiOk/);
});

test('a failed pi status probe does not erase a working piOk', () => {
  const fn = PANEL.match(/async function loadModels[\s\S]*?\n    }/)[0];
  assert.doesNotMatch(fn, /catch\(_\)\{piOk=false\}/, 'a probe failure is not an answer');
});

// ── 3. stop stops ───────────────────────────────────────────────────────────
test('the tool loop checks the abort signal before every call', () => {
  assert.match(PANEL, /for\(const c of calls\)\{[\s\S]{0,200}if\(sig\.aborted\)/,
    'each queued tool must be re-checked against the stop');
});

test('every machine-touching tool call carries the abort signal and an interrupt id', () => {
  const fn = PANEL.match(/async function execTool[\s\S]*?\n    }/)[0];
  assert.equal((fn.match(/Bridge\.shell\(/g) || []).length, 1,
    'the ONLY Bridge.shell in execTool must be the one inside the stoppable helper');
  assert.match(fn, /const sh=async\(cmd,onTok\)=>\{[\s\S]*?Bridge\.shell\(cmd,onTok\|\|\(\(\)=>\{\}\),signal,id\)/,
    'the helper must pass the signal AND an id the bridge can kill');
  assert.match(fn, /Bridge\.interrupt\(id\)/, 'and interrupt the command it started');
});

test('a gate opened on an already-stopped turn resolves instead of hanging forever', () => {
  const fn = PANEL.match(/function gateApprove[\s\S]*?\n    }/)[0];
  assert.match(fn, /if\(signal&&signal\.aborted\)return Promise\.resolve\(false\)/,
    'an abort listener added after the abort never fires');
});

test('a stopped gate is recorded as cancelled, never as rejected by the owner', () => {
  const fn = PANEL.match(/function gateApprove[\s\S]*?\n    }/)[0];
  assert.match(fn, /done\(false,'cancelled'\)/, 'the owner never pressed reject');
});

test('a late settle cannot close the next turn’s stream', () => {
  assert.match(PI, /_endIfOwned\(turn\)\s*\{[\s\S]{0,140}turn === this\.resTurn/,
    'closing must be gated on owning the current stream');
  assert.match(PI, /if \(type === 'agent_settled'\)[\s\S]{0,120}_endIfOwned\(this\.turn\)/);
});

test('a prompt whose viewer already left is never submitted to pi', () => {
  const fn = PI.match(/async function prompt|async prompt\(res, message[\s\S]*?\n  }/)[0];
  assert.match(fn, /if \(gone \|\| this\.res !== res\)/, 'the handshake window must be re-checked');
});

test('the message sent right after stop waits for the abort instead of being refused', () => {
  assert.match(PI, /async _settle\(/, 'there must be a settle wait');
  assert.match(PI, /if \(this\.busy\) \{\s*\n\s*await this\._settle\(\)/);
});

test('stop targets the conversation on screen, not whatever the panel last streamed', () => {
  assert.match(PANEL, /const runs=new Map\(\)/, 'a turn belongs to its conversation');
  assert.match(PANEL, /const c=active\(\),ctl=c&&runs\.get\(c\.id\);/,
    'the ■ button must resolve the ACTIVE session’s run');
});

// ── 4. per-conversation composer ────────────────────────────────────────────
test('the composer text and attachments belong to the conversation', () => {
  assert.match(PANEL, /function stashDraft\(\)/);
  assert.match(PANEL, /function loadDraft\(\)/);
  assert.match(PANEL, /c\.draftFiles=draftFiles;c\.draftImgs=draftImgs;/,
    'attached files and images must be stashed too, not just the text');
  assert.match(PANEL, /function switchTo\(id\)\{[\s\S]{0,200}stashDraft\(\);/,
    'every switch must stash the outgoing draft first');
});

test('no session switch bypasses the draft handover', () => {
  // Every place that changes which conversation is displayed must hand the draft over. Judge
  // by the surrounding statement, not by the single line — `switchTo` stashes one line above.
  const re = /st\.active\s*=\s*(?!=)/g;
  let m, checked = 0;
  while ((m = re.exec(PANEL))) {
    const win = PANEL.slice(Math.max(0, m.index - 400), m.index + 400);
    // the two lifecycle paths that legitimately have no outgoing draft to keep: a conversation
    // being created (newSession stashes first) and one being closed/archived (its draft dies)
    const ok = /stashDraft|loadDraft/.test(win)
      || /draftFiles=\[\];draftImgs=\[\]/.test(win)   // closeSession clears instead
      || /if\(!st\.active\|\|!active\(\)\)/.test(win); // boot repair, no user-visible switch
    assert.ok(ok, 'unguarded session switch near: ' + PANEL.slice(m.index, m.index + 90).split('\n')[0]);
    checked++;
  }
  assert.ok(checked >= 4, 'the check must actually have found the switch sites');
});

test('a duplicated conversation does not inherit a live gate or another’s draft', () => {
  const fn = PANEL.match(/function forkSession[\s\S]*?\n    }/)[0];
  assert.match(fn, /m\.role==='gate'&&!m\.resolved\)m\.resolved='expired'/,
    'a copied pending gate would resolve the ORIGINAL conversation’s gate');
  assert.match(fn, /c\.draft='';/);
});

// ── 5. the turn ends, and says what happened ────────────────────────────────
test('streaming text and tool activity can cancel the quiet-end timer', () => {
  // the old guard listed message_update on a line that returned 40 lines earlier
  const m = PI.match(/if \(type === 'message_update'\) \{[\s\S]*?\n    \}/)[0];
  assert.match(m, /this\._live\(\)/, 'text deltas must count as activity');
  assert.match(PI, /if \(type === 'tool_execution_start'\) \{ this\._live\(\)/);
});

test('the quiet-end timer is bound to the turn that armed it', () => {
  const fn = PI.match(/_armQuietEnd\(ms = 2500\) \{[\s\S]*?\n  \}/)[0];
  assert.match(fn, /const mine = this\.turn/);
  assert.match(fn, /_endIfOwned\(mine\)/);
});

test('a provider failure reported as a stopped message is surfaced, not swallowed', () => {
  assert.match(PI, /if \(type === 'message_end'\)/, 'message_end must be handled at all');
  assert.match(PI, /stopReason[\s\S]{0,200}=== 'error'[\s\S]{0,200}t: 'error'/,
    'a stopReason of error must reach the owner');
  assert.match(PI, /max_tokens[\s\S]{0,120}cut short/i, 'a truncated reply must say so');
});

test('an error event ends the turn instead of leaving the stream open forever', () => {
  assert.match(PI, /if \(type === 'error'\) \{[\s\S]{0,220}_armQuietEnd\(1500\)/);
});

test('pi’s stderr is kept so a death at spawn has a cause', () => {
  assert.match(PI, /p\.stderr\.on\('data'/);
  assert.doesNotMatch(PI, /p\.stderr\.on\('data', \(\) => \{\}\)/, 'discarding it hid every cause');
  assert.match(PI, /the pi agent exited[\s\S]{0,160}why/);
});

test('the step cap tells the owner instead of abandoning the work in silence', () => {
  assert.match(PANEL, /reached the '\+MAX_STEPS\+'-step limit/);
  assert.match(PANEL, /Send “continue” to carry on/);
});

test('a turn that throws anywhere still reports to the owner', () => {
  const fn = PANEL.match(/const ctl=new AbortController\(\),sig=ctl\.signal;[\s\S]*?return;\n      \}/)[0];
  assert.doesNotMatch(fn, /catch\(_\)\{\}/, 'the turn must never fail silently');
  assert.match(fn, /catch\(e\)\{[\s\S]{0,320}friendlyErr/);
});

test('an empty reply is described honestly rather than as "(no reply)"', () => {
  assert.match(PANEL, /sig\.aborted\?'_\(stopped\)_'/, 'a stopped turn is not an empty answer');
  assert.match(PANEL, /the agent returned nothing/);
});

// ── 6. one turn paints into one conversation ────────────────────────────────
test('a streaming reply cannot paint into another conversation', () => {
  const fn = PANEL.match(/function paintBubble[\s\S]*?\n    }/)[0];
  assert.match(fn, /if\(!cur\|\|cur\.id!==sess\.id\)return/, 'wrong session → do not touch the DOM');
  assert.match(fn, /sess\.msgs\.indexOf\(msg\)/, 'address the bubble by index, not by "last .cdmsg.ai"');
  assert.doesNotMatch(PANEL, /querySelectorAll\('\.cdmsg\.ai'\)/,
    'the last-bubble-in-the-DOM pattern is what crossed the wires');
});

test('tool results are paired by pi’s own call id', () => {
  assert.match(PI, /id: ev\.toolCallId \|\| ev\.id \|\| ''/, 'the bridge must forward the id');
  assert.match(PANEL, /ev\.id\?pendingTools\.findIndex\(x=>x\.id===ev\.id\):-1/);
  assert.match(PANEL, /if\(i<0\)\{saveSt\(\);return\}/, 'an unowned end must not overwrite a stranger');
});

// ── 7. the owner's own documents, and their key ─────────────────────────────
test('an app update never overwrites a curriculum the owner edited', async () => {
  const { Pi } = await import('../bridge/pi.mjs');
  Pi.install();
  const agents = path.join(HOME, '.clone-frame-hub', 'agent', 'AGENTS.md');
  assert.ok(fs.existsSync(agents), 'the workspace must install');
  const mine = '# MY OWN CURRICULUM\nthe owner wrote this\n';
  fs.writeFileSync(agents, mine);
  // make the bundle look newer than the workspace — exactly what refreshTree() causes
  const bundleDoc = path.join(APP, 'agent', 'AGENTS.md');
  const now = new Date();
  fs.utimesSync(bundleDoc, now, now);
  Pi.ensureWorkspace({ force: true });
  assert.equal(fs.readFileSync(agents, 'utf8'), mine, 'the owner’s words must survive the sync');
  assert.ok(Pi.status().ownEdited.includes('AGENTS.md'), 'and the app must say it kept them');
});

test('the owner’s provider key never enters pi’s environment', () => {
  assert.match(PI, /const RELAY = new Map\(\)/, 'there must be a relay registry');
  assert.match(PI, /CFHUB_PI_APIKEY: token/, 'pi gets a loopback capability, not the key');
  assert.doesNotMatch(PI, /CFHUB_PI_APIKEY: this\.spec\.apiKey/, 'the old key-in-env path must be gone');
  assert.match(PI, /async function handleRelay/, 'and something must attach the real credential');
  // the relay is reachable, and an unknown token gets nothing
  assert.match(BRIDGE, /url\.pathname\.startsWith\('\/llm\/'\)/);
  assert.match(PI, /if \(!cfg\) \{ res\.writeHead\(401/);
});

test('a spawned fleet child gets a capability too, not the owner’s key', () => {
  const fn = PI.match(/async function buildFleetRuntime[\s\S]*?\n}/)[0];
  assert.match(fn, /env: \{ CFHUB_PI_APIKEY: token \}/);
  assert.doesNotMatch(fn, /apiKey: resolved\.spec\.apiKey/);
});

test('the isolated runtime no longer writes through to the owner’s global credentials', () => {
  const fn = PI.match(/function buildRuntimeDir[\s\S]*?\n  return rt;\n}/)[0];
  assert.doesNotMatch(fn, /'auth\.json'.*symlink|for \(const l of \['npm', 'auth\.json'/,
    'auth.json was symlinked read-write into the owner’s real ~/.pi');
  assert.match(fn, /for \(const l of \['npm', 'models-store\.json'\]\)/);
});

// ── 8. cost and honesty of the per-message path ─────────────────────────────
test('a chat message does not walk the bundle or spawn `pi --version` twice', () => {
  assert.match(PI, /install\(\{ light: true \}\)/, 'the per-message path must be the light one');
  assert.match(PI, /if \(_ver\.at && Date\.now\(\) - _ver\.at < VER_TTL\) return _ver\.v/,
    'the version spawn must be cached');
  assert.match(PI, /if \(!force && _wsCheck/, 'the mtime walk must be throttled');
});

test('a live conversation is never killed to list slash commands', () => {
  assert.match(PI, /const CMD_SESSION = '__commands__'/);
  assert.match(PI, /let oldest = SESSIONS\.get\(CMD_SESSION\)[\s\S]{0,120}: null;/,
    'the internal session must be evicted first');
  assert.match(PI, /if \(!oldest\) for \(const \[, v\] of SESSIONS\) if \(!v\.res && !v\.busy/,
    'and a busy conversation must never be evicted');
});

test('the scratch sweep cannot delete a live conversation’s file', () => {
  const fn = PI.match(/function purgeOrphanScratch[\s\S]*?\n}/)[0];
  assert.match(fn, /const unknown = \[\.\.\.SESSIONS\.values\(\)\]\.some\(\(s\) => s\.proc && !s\.piSid\)/,
    'a session whose handshake timed out cannot claim its own file');
  assert.match(fn, /if \(unknown\) return 0/);
});

test('an oversized message is answered, not dropped on the floor', () => {
  assert.match(BRIDGE, /const BODY_MAX = 64e6/, 'a pasted screenshot must fit');
  assert.match(BRIDGE, /res\.writeHead\(413/, 'and the client must be told when it does not');
  assert.match(BRIDGE, /const b = await readBody\(req, res\); if \(b === null\) return;/);
});

test('a stale app document is detectable at runtime', () => {
  assert.match(BRIDGE, /function appStale\(\)/);
  assert.match(BRIDGE, /appStale: appStale\(\)/, '/health must report it');
  assert.match(SHELL, /This window is an OLD build of the app/, 'and the window must say so');
});

// ── 9. the panel’s own surfaces ─────────────────────────────────────────────
test('the shell prompt escapes the machine’s cwd and branch', () => {
  const fn = PANEL.match(/function promptHTML\(\)[\s\S]*?\n    }/)[0];
  assert.match(fn, /escHtml\(cwd\)/);
  assert.match(fn, /escHtml\(branch\)/);
  assert.doesNotMatch(fn, /\$\{cwd\}/, 'a directory name is attacker-controllable input');
  assert.doesNotMatch(fn, /\$\{branch\}/, 'so is a branch name in a cloned repo');
});

test('the PROJECT pane reads the terminal’s own cwd session', () => {
  assert.match(PANEL, /const shell=cmd=>new Promise\(res=>\{let o='';Bridge\.shell\(cmd,t=>\{o\+=t\},null,null,\{sid:termSid\}\)/);
});

test('the model picker does not accumulate a keydown listener per open', () => {
  assert.match(PANEL, /if\(pop\._keys\)pop\.removeEventListener\('keydown',pop\._keys\)/);
  assert.match(PANEL, /pop\.addEventListener\('keydown',pop\._keys\)/);
});

test('docking CODE into a frame square does not end every conversation', () => {
  const fn = PANEL.match(/p\._dispose=\(\)=>\{[\s\S]*?\n    \};/)[0];
  assert.match(fn, /if\(p\.dataset\.docking\)return;/, 'docking is not closing');
  assert.match(fn, /stashDraft\(\);saveSt\(\);/, 'and the draft survives either way');
});

test('/goals clear does not first add "clear" as a goal', () => {
  assert.match(PANEL, /if\(arg==='clear'\)\{cur\.goals=\[\];saveSt\(\);note\('Goals cleared\.'\);return\}/);
});

test('/panel resolves names the way the agent’s own tool does, and reports the truth', () => {
  assert.match(PANEL, /const k=resolvePanelKey\(arg\)/);
  assert.match(PANEL, /note\(openPanel\(k\)\?/, 'success must be observed, not assumed');
});

test('goals and the bound iNFT reach the agent on the pi path', () => {
  assert.match(PANEL, /function standingContext\(cur\)/);
  assert.match(PANEL, /piRun\(cur,standingContext\(cur\)\+text,imgs,sig\)/);
  assert.match(PANEL, /standing_context/);
});

test('an exported transcript keeps the governance record', () => {
  const fn = PANEL.match(/function exportSession[\s\S]*?\n    }/)[0];
  assert.match(fn, /m\.role==='gate'/, 'a gate decision is the one thing worth exporting exactly');
  assert.match(fn, /HARNESS GATE/);
});

test('every conversation can be typed in while another one answers', () => {
  assert.match(PANEL, /if\(runHere\(\)\)\{Toast\.show/, 'only THIS conversation blocks, and it says so');
  assert.doesNotMatch(PANEL, /\|\|streaming\)return;/, 'the panel-wide block is gone');
});

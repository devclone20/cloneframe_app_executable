// H6 · what the adversarial pass found, pinned so it cannot come back.
//
// THREE findings, and the first one is mine.
//
// 1 · /health leaked the macOS username to an unauthenticated caller.
//     The handler's own comment, two lines above it, says:
//         "/health is open (needed for probing) — deliberately minimal: no cwd (leaks the
//          macOS username), no brain/model."
//     and the response carried `root: HUB_ROOT` — /Users/<name>/Desktop/… . Added in 3d18a2d,
//     in THIS session's earlier work, for a diagnostic that appStale already answers as a
//     boolean. Nothing read it: every `.root` in the client comes from RPC('folders','root'),
//     which is behind the token.
//
// 2 · settings.js built two shell paths with JSON.stringify — DOUBLE quotes. zsh expands
//     $(...), `...` and $VAR inside double quotes, so a folder whose NAME contained a command
//     substitution would have executed when the owner clicked "Open in Finder". Same defect
//     class as a971b2e (iT's qpath), a different panel, found by grepping for the pattern
//     rather than for the symptom.
//
// 3 · The scheduler swallowed the write that advances a task's schedule. `try { persistStore() }
//     catch {}` after a run meant that on a full or read-only disk, nextRunAt never moved and
//     lastRunAt was never recorded — so the task RAN AGAIN at the same time, repeatedly, while
//     the run log said it never happened. The only visible symptom was the work being done
//     twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const APP = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('/health discloses nothing about where this machine keeps things', () => {
  const bridge = decomment(read('bridge/hub-bridge.mjs'));
  const line = bridge.match(/res\.end\(j\(\{ ok: true, name: 'HUB Bridge'[^\n]*\n/)[0];
  assert.doesNotMatch(line, /root:/, 'HUB_ROOT contains /Users/<name>');
  assert.doesNotMatch(line, /cwd|HOME|homedir/, 'nor anything else path-shaped');
  // what it SHOULD still say, so the fix does not quietly break probing
  for (const k of ['ok: true', 'version', 'host', 'stale', 'appStale']) {
    assert.ok(line.includes(k), '/health must still report ' + k);
  }
});

test('the comment that forbids it is still next to it', () => {
  const bridge = read('bridge/hub-bridge.mjs');
  assert.match(bridge, /deliberately minimal: no cwd \(leaks the/,
    'if this comment ever goes, the next person will add it back');
});

test('no shell path in the panels is built with double quotes', () => {
  for (const f of fs.readdirSync(path.join(APP, 'web/panels'))) {
    if (!f.endsWith('.js')) continue;
    const src = decomment(read('web/panels/' + f));
    assert.doesNotMatch(src, /Bridge\.shell\([^)]*JSON\.stringify/,
      f + ' quotes a shell path with JSON.stringify — zsh expands inside double quotes');
    assert.doesNotMatch(src, /Bridge\.shell\('[^']*'\+'"'/, f + ' hand-builds double quotes');
  }
});

test('settings.js uses the same single-quoting shape as iT', () => {
  const s = read('web/panels/settings.js');
  assert.match(s, /const shq=v=>"'"\+String\(v\)\.replace\(\/'\/g,"'\\\\''"\)\+"'";/,
    'one helper, the same escaping as qpath');
  assert.match(s, /Bridge\.shell\('open '\+shq\(rr\.abs\),\(\)=>\{\}\)/);
  assert.match(s, /Bridge\.shell\('open '\+shq\(s\.root\),\(\)=>\{\}\)/);
});

test('a hostile folder name does not execute through the Finder-reveal path', () => {
  // Exercise the shipped expression against a real zsh, the same way the iT test does.
  const s = read('web/panels/settings.js');
  const shq = eval('(' + s.match(/const shq=([^;]+);/)[1] + ')'); // eslint-disable-line no-eval
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-set-'));
  const hostile = path.join(base, 'proj$(touch EXECUTED)x');
  try {
    fs.mkdirSync(hostile);
    execFileSync('zsh', ['-lc', 'cd ' + shq(hostile) + ' >/dev/null 2>&1; true'], { cwd: base, stdio: 'ignore' });
    assert.equal(fs.existsSync(path.join(base, 'EXECUTED')), false, 'the folder name executed');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the scheduler no longer swallows the write that advances the schedule', () => {
  const t = read('bridge/tasks.mjs');
  assert.doesNotMatch(t, /try \{ persistStore\(\); \} catch \{\}/,
    'a silent failure here makes a task run twice');
  assert.match(t, /could not save the schedule after running/, 'and it must say what will happen');
  assert.match(t, /it may run again at the same time/, 'in terms of the consequence, not the error');
});

test('every machine-supplied string in the panels is escaped before it reaches innerHTML', () => {
  // The XSS surface, swept structurally. Verified live as well: three payloads in note titles
  // (img/onerror, <script>, quote-breaking) rendered as literal text, window.__XSS stayed 0,
  // zero injected nodes.
  for (const f of fs.readdirSync(path.join(APP, 'web/panels'))) {
    if (!f.endsWith('.js')) continue;
    const src = decomment(read('web/panels/' + f));
    const bad = (src.match(/innerHTML=[^;\n]*\+\s*[a-z]\.(name|title|text|body|note|error|msg|label|host|cmd|path|url)\b/g) || [])
      .filter((m) => !/escHtml|escAttr/.test(m));
    assert.deepEqual(bad, [], f + ' renders a machine string unescaped: ' + bad.join(' | '));
  }
});

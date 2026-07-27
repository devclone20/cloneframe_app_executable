// The agent's file tools must never read a secret store. SECURITY.md states it plainly:
// ~/.clone-frame-hub, ~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh, Keychains, ~/.env*, ~/.netrc
// and ~/.npmrc are blocked server-side. This is the guard that has to make that true.
//
// It was a raw string comparison, and there was no test on it at all. Two ways past:
//
//   CASE     macOS ships APFS case-INSENSITIVE, so ~/.SSH/id_ed25519 is the SAME FILE as
//            ~/.ssh/id_ed25519 and a different string. An audit read a real private key
//            out that way, plus the Google token store and a full listing of the hub dir.
//   SYMLINK  a link anywhere the agent may write, pointing into ~/.ssh, was equally invisible.
//
// Both close with one realpath. These tests exist so neither can quietly come back — a
// security control with no test is a promise nobody is keeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Files } = await import('../bridge/files.mjs');
const HOME = os.homedir();
const FOLD = process.platform === 'darwin' || process.platform === 'win32';
const refused = (r) => !!(r && r.error && /protected location/.test(r.error));

test('the canonical secret paths are refused', () => {
  for (const p of ['~/.ssh/id_rsa', '~/.aws/credentials', '~/.gnupg/secring.gpg',
    '~/.config/gh/hosts.yml', '~/.clone-frame-hub/bridge.token', '~/.env.local', '~/.netrc']) {
    assert.ok(refused(Files.read(p)), 'read allowed on ' + p);
    assert.ok(refused(Files.write(p, 'x')), 'write allowed on ' + p);
  }
  for (const d of ['~/.ssh', '~/.clone-frame-hub', '~/.aws']) {
    assert.ok(refused(Files.list(d)), 'list allowed on ' + d);
  }
});

test('a path that does not exist yet is still inside the fence', () => {
  // write and mkdir are exactly how a new file appears in a secret directory, and a path
  // with no realpath must not fall out of the guard on its way there.
  assert.ok(refused(Files.write('~/.ssh/brand-new-key', 'x')), 'a new file inside ~/.ssh was allowed');
  assert.ok(refused(Files.write('~/.clone-frame-hub/nested/deep/new.json', 'x')), 'a new nested path was allowed');
});

test('case variants are refused on a case-insensitive filesystem', { skip: !FOLD && 'case-sensitive platform' }, () => {
  // The exact strings the audit walked out through.
  for (const p of ['~/.SSH/id_ed25519', '~/.Ssh/config', '~/.AWS/credentials',
    '~/.CLONE-FRAME-HUB/oauth.json', '~/.Clone-Frame-Hub/bridge.token', '~/.ENV.local']) {
    assert.ok(refused(Files.read(p)), 'read allowed through a case variant: ' + p);
  }
  for (const d of ['~/.SSH', '~/.Clone-Frame-Hub', '~/.Aws']) {
    assert.ok(refused(Files.list(d)), 'list allowed through a case variant: ' + d);
  }
});

test('a symlink pointing into a secret store is refused', (t) => {
  const target = path.join(HOME, '.ssh');
  if (!fs.existsSync(target)) { t.skip('no ~/.ssh on this machine to link at'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-linkguard-'));
  try {
    const link = path.join(tmp, 'innocent');
    fs.symlinkSync(target, link);
    assert.ok(refused(Files.list(link)), 'listing a directory symlink into ~/.ssh was allowed');
    assert.ok(refused(Files.read(path.join(link, 'config'))), 'reading through a directory symlink was allowed');
    // and a file symlink, which is the quieter version of the same trick
    const inner = fs.readdirSync(target).find((n) => fs.statSync(path.join(target, n)).isFile());
    if (inner) {
      const flink = path.join(tmp, 'notes.txt');
      fs.symlinkSync(path.join(target, inner), flink);
      assert.ok(refused(Files.read(flink)), 'reading through a file symlink into ~/.ssh was allowed');
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the guard does not over-block', () => {
  // A guard that refuses everything is not a guard, it is a broken tool. Ordinary files
  // must stay readable and writable.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-okfiles-'));
  try {
    const f = path.join(tmp, 'notes.md');
    assert.ok(Files.write(f, 'hello').ok, 'writing an ordinary file was refused');
    const r = Files.read(f);
    assert.ok(r.ok && r.text === 'hello', 'reading an ordinary file was refused');
    assert.ok(Files.list(tmp).ok, 'listing an ordinary directory was refused');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the two public hub docs stay readable, in any casing', (t) => {
  const doc = path.join(HOME, '.clone-frame-hub', 'AGENTS.md');
  if (!fs.existsSync(doc)) { t.skip('no mirrored hub docs on this machine'); return; }
  assert.ok(Files.read(doc).ok, 'the agent can no longer read its own field guide');
  if (FOLD) {
    const shouty = path.join(HOME, '.CLONE-FRAME-HUB', 'AGENTS.md');
    assert.ok(Files.read(shouty).ok, 'the allowlist must be canonicalised the same way the guard is');
  }
  // …and nothing else in that directory, whatever the casing.
  assert.ok(refused(Files.read(path.join(HOME, '.clone-frame-hub', 'bridge.token'))), 'the token became readable');
  if (FOLD) assert.ok(refused(Files.read(path.join(HOME, '.CLONE-FRAME-HUB', 'bridge.token'))), 'the token became readable through a case variant');
});

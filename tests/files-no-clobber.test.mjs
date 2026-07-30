// FOLDERS → "File" → type a name that already exists → the file is wiped to 0 bytes.
// No confirmation, no undo, and the toast says "File created".
//
// Two things combined. Files.write() truncates unconditionally (fs.writeFileSync), and the
// create row commits on BLUR — `inp.addEventListener('blur', () => done(true))` — so the owner
// does not even have to press Enter. Clicking away is enough.
//
// Measured before the fix:
//   /tmp/cf-h05/report.md          40 bytes
//   Files.write(path, '')       →  {"ok":true,"path":"…","bytes":0}
//   /tmp/cf-h05/report.md           0 bytes
//
// The guard is opt-in, not a new default. write() is also the editor's Save and the agent's
// write tool, and both MUST overwrite; refusing by default would break every save path in the
// app. Creating a file and saving one are different intentions, and only the second may
// destroy what is there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Files } from '../bridge/files.mjs';

const APP = path.resolve(import.meta.dirname, '..');
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-clobber-'));

test('noClobber refuses to write over an existing file', () => {
  const dir = mkTmp();
  const f = path.join(dir, 'report.md');
  try {
    fs.writeFileSync(f, 'a day of work\n');
    const before = fs.statSync(f).size;
    const r = Files.write(f, '', { noClobber: true });
    assert.equal(r.ok, false, 'it must refuse');
    assert.match(r.error, /already here/, 'and say why, by name');
    assert.equal(fs.statSync(f).size, before, 'the file must be byte-for-byte untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('noClobber still creates when nothing is in the way', () => {
  const dir = mkTmp();
  const f = path.join(dir, 'fresh.txt');
  try {
    const r = Files.write(f, 'hello', { noClobber: true });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'hello');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('WITHOUT the flag, overwriting still works — Save must not break', () => {
  const dir = mkTmp();
  const f = path.join(dir, 'doc.txt');
  try {
    fs.writeFileSync(f, 'old');
    const r = Files.write(f, 'new');
    assert.equal(r.ok, true, 'the editor saves through this path');
    assert.equal(fs.readFileSync(f, 'utf8'), 'new');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('append is unaffected by the guard', () => {
  const dir = mkTmp();
  const f = path.join(dir, 'log.txt');
  try {
    fs.writeFileSync(f, 'one\n');
    const r = Files.write(f, 'two\n', { append: true });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'one\ntwo\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the FOLDERS create row passes the flag', () => {
  const src = fs.readFileSync(path.join(APP, 'web/panels/folders.js'), 'utf8');
  assert.match(src, /RPC\('files','write',dest,'',\{noClobber:true\}\)/,
    'the one call site that means "make a new file"');
  // and the row still commits on blur — the fix is the guard, not removing the affordance
  assert.match(src, /inp\.addEventListener\('blur',\(\)=>done\(true\)\)/);
});

test('the editor Save path does NOT pass it', () => {
  // If a later change adds noClobber here, saving an existing file becomes impossible.
  const src = fs.readFileSync(path.join(APP, 'web/panels/folders.js'), 'utf8');
  const saves = (src.match(/RPC\('files','write'[^)]*noClobber/g) || []).length;
  assert.equal(saves, 1, 'exactly one call site may refuse to overwrite');
});

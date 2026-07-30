// The app shipped SIX version strings and they disagreed:
//
//   package.json / bridge/package.json   0.2.0
//   bridge/hub-bridge.mjs                '0.2.0'  — hard-coded, remembered by hand each release
//   Settings → About                     v0.4 EXTRACTION      ← the one the owner actually reads
//   `it version` in any iT shell         v0.4 EXTRACTION
//   the guide badge                      v0.28 · WEB
//
// A bug report quoting "v0.4 EXTRACTION" cannot be matched against a tag called v0.2.1. That is
// the whole cost, and it is not cosmetic.
//
// package.json is now the single origin. The sources carry @@CF_VERSION@@ and tools/build.mjs
// fills it in; the daemon reads the same file instead of repeating the number. The build REFUSES
// if the token disappears from the sources, because a silently un-substituted build would ship a
// stale version and look fine.
//
// The codenames — EXTRACTION, WEB — are deliberately left alone. Naming a release is the owner's
// call; the number is mechanical.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
const pkgVersion = JSON.parse(read('package.json')).version;

test('package.json has a version and it is the origin', () => {
  assert.match(pkgVersion, /^\d+\.\d+\.\d+/, 'the one number everything else derives from');
});

test('no source repeats the number by hand', () => {
  for (const f of ['web/index.html', 'web/panels/settings.js', 'web/panels/shell.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /v0\.4 EXTRACTION/, f + ' still hard-codes v0.4');
    assert.doesNotMatch(src, /v0\.28 · WEB/, f + ' still hard-codes v0.28');
  }
  const bridge = read('bridge/hub-bridge.mjs');
  assert.doesNotMatch(bridge, /const VERSION = '\d/, 'the daemon must read, not repeat');
  assert.match(bridge, /JSON\.parse\(fs\.readFileSync\(path\.join\(HUB_ROOT, 'package\.json'\)/,
    'and it reads the same file the build does');
});

test('every UI site carries the token instead', () => {
  const sites = [
    ['web/index.html', /v@@CF_VERSION@@ · WEB/],
    ['web/panels/settings.js', /v@@CF_VERSION@@ EXTRACTION/],
    ['web/panels/shell.js', /v@@CF_VERSION@@ EXTRACTION/],
  ];
  for (const [f, re] of sites) assert.match(read(f), re, f + ' lost its token');
});

test('the build substitutes it, and refuses if the token vanishes', () => {
  const b = read('tools/build.mjs');
  assert.match(b, /html = html\.replaceAll\('@@CF_VERSION@@', v\)/);
  assert.match(b, /build REFUSED — no @@CF_VERSION@@ token in the sources/,
    'a silent no-op substitution would ship a stale version looking fine');
  assert.match(b, /build REFUSED — package\.json has no version/);
});

test('the BUILT document carries the real number and no token', () => {
  const dist = path.join(APP, 'dist/index.html');
  if (!fs.existsSync(dist)) return;
  const d = fs.readFileSync(dist, 'utf8');
  assert.ok(!d.includes('@@CF_VERSION@@'), 'an un-substituted token reached dist');
  assert.ok(d.includes('v' + pkgVersion + ' · WEB'), 'the guide badge must show ' + pkgVersion);
  assert.ok(d.includes('v' + pkgVersion + ' EXTRACTION'), 'About must show ' + pkgVersion);
  // and the two former disagreements must be gone from the shipped surface
  assert.ok(!d.includes('v0.4 EXTRACTION'), 'dist still says v0.4');
  assert.ok(!d.includes('v0.28 · WEB'), 'dist still says v0.28');
});

test('the codenames survive — the number was the defect, not the naming', () => {
  const dist = path.join(APP, 'dist/index.html');
  if (!fs.existsSync(dist)) return;
  const d = fs.readFileSync(dist, 'utf8');
  assert.ok(d.includes('EXTRACTION'), 'the release name is the owner’s to keep or change');
  assert.ok(d.includes('· WEB'), 'and so is the surface label');
});

test('bridge/package.json agrees with the root one', () => {
  // Two package.json files that drift give the same class of defect back.
  const b = JSON.parse(read('bridge/package.json'));
  if (!b.version) return;
  assert.equal(b.version, pkgVersion, 'bridge/package.json has drifted from the root version');
});

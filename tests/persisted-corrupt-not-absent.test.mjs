// UNPARSEABLE IS NOT ABSENT.
//
// A key that is MISSING means "new install, use the defaults". A key that is PRESENT but will
// not parse means "the owner has data here and something damaged it". Both used to return the
// default, and the panel's very next save wrote that default over the damaged bytes.
//
//   persisted: get(){ try{ … JSON.parse(v) }catch(_){ return def } }
//   Store    : try{ if(raw)s=Object.assign(s,JSON.parse(raw)); … }catch(_){}
//
// Measured in the running app: cfhub.code.v1 was truncated to 70% of its length, the page was
// reloaded, and by the time anything could be observed the key was down to 137 bytes — one
// empty session. The replacement happened DURING LOAD, before a single pixel reached the
// screen. Every conversation gone, no error, nothing to notice.
//
// The same shape guarded cfhub.v3 — the owner's canvas, theme, wallet, agents and email
// drafts — where the outer catch{} left `s` at the defaults (cells:{}) for Store.save() to
// write out. That is the worst-kind defect this app names in its own vision: code that
// overwrites the owner's things without being asked.
//
// The fix does not try to repair the bytes. It refuses to lose them: park under `<key>.corrupt`
// and tell the owner once. Recovery stays possible; silence does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
const kernel = read('web/scripts/core/kernel.js');
const app = read('web/index.html');

test('parkCorrupt exists and never throws, whatever storage does', () => {
  const fn = kernel.match(/export function parkCorrupt\(key, raw\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /localStorage\.setItem\(key \+ '\.corrupt', raw\)/);
  assert.match(fn, /catch \(_\)/, 'quota may be the very thing that broke it');
  // first writer wins: a second failure must not overwrite the original damaged bytes
  assert.match(fn, /getItem\(key \+ '\.corrupt'\) == null/,
    'a later parse failure must not clobber the first parked copy');
});

test('persisted tells missing apart from unparseable', () => {
  const cell = kernel.match(/export const persisted = \(key, def\) => \(\{[\s\S]*?\n\}\);/)[0];
  assert.match(cell, /if \(v == null\) return def;/, 'absent → defaults, as before');
  assert.match(cell, /catch \(_\) \{ parkCorrupt\(key, v\); return def; \}/,
    'present-but-damaged must be parked before falling back');
  assert.doesNotMatch(cell, /return v == null \? def : JSON\.parse\(v\); \} catch \(_\) \{ return def; \}/,
    'the one-liner that lost the data must be gone');
});

test('parkCorrupt is reachable from the panels', () => {
  // The documented trap: a kernel helper only exists inside panels if it is in this list.
  // Without it, parkCorrupt is `undefined` at runtime while looking perfectly correct here.
  assert.match(kernel, /Object\.assign\(window, \{[^}]*parkCorrupt[^}]*\}\)/);
});

test('the canvas loader parks before it falls back', () => {
  const loader = app.match(/const KEY='cfhub\.v3';[\s\S]*?\n  \}catch/)[0];
  assert.match(loader, /catch\(e\)\{parkCorrupt\(KEY,raw\);throw e\}/,
    'the owner canvas is the most valuable key in the app');
  assert.doesNotMatch(loader, /if\(raw\)s=Object\.assign\(s,JSON\.parse\(raw\)\);\s*\n\s*else\{/,
    'the unguarded assign must be gone');
});

test('the legacy v2/v1 fallbacks are NOT used to replace damaged current data', () => {
  // Falling through to cfhub.v2 after cfhub.v3 failed to parse would silently restore a
  // months-old canvas over the current one — a different way to lose the same thing.
  const loader = app.match(/const KEY='cfhub\.v3';[\s\S]*?\n  \}catch/)[0];
  assert.match(loader, /throw e/, 'a damaged v3 must not fall through to v2');
  assert.ok(loader.indexOf('parkCorrupt(KEY,raw)') < loader.indexOf("cfhub.v2"),
    'the park must happen before any fallback is considered');
});

test('the owner is told once, in words, and nothing new appears on screen', () => {
  const notice = app.match(/const NAMES=\{'cfhub\.v3'[\s\S]*?\n\}\)\(\);/)[0];
  assert.match(notice, /endsWith\('\.corrupt'\)/, 'it must key off what was actually parked');
  assert.match(notice, /set aside, not deleted/, 'the reassurance is the point');
  assert.match(notice, /Toast\.show/, 'an existing surface — no new control');
  assert.match(notice, /your canvas and settings/, 'and it must name what it was');
  assert.match(notice, /said\.has\(key\)/, 'once per key, not once per read');
});

test('the notice covers BOTH moments damage is discovered', () => {
  // A boot-time scan alone told the owner one launch too late: the Store loader parks before
  // this listener exists (visible only as a leftover key), while panels mount long after boot
  // (visible only as an event). Measured live: with a damaged cfhub.code.v1, the bytes were
  // parked to `.corrupt` (733 B survived) but no toast appeared until the following launch.
  const notice = app.match(/const NAMES=\{'cfhub\.v3'[\s\S]*?\n\}\)\(\);/)[0];
  assert.match(notice, /addEventListener\('cf:corrupt'/, 'for parks that happen after boot');
  assert.match(notice, /hit\.forEach\(k=>say\(/, 'for parks that happened before this ran');
  assert.match(kernel, /dispatchEvent\(new CustomEvent\('cf:corrupt'/,
    'and the kernel must raise it — it has no Toast of its own');
});

test('every panel that persists state benefits without changing', () => {
  for (const p of ['terminal', 'brain']) {
    const src = read('web/panels/' + p + '.js');
    assert.match(src, /persisted\([A-Z_]+,\s*null\)/,
      p + ' must keep using the shared cell rather than its own try/catch');
  }
});

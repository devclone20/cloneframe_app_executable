// The app must say ONE version, and it must be the real one.
//
// 0.3.0 was released as "the version finally tells the truth" and KNOWN-ISSUES said the
// number now comes from package.json "everywhere, including places that used to carry
// their own codenamed number." Both claims were false in three places nobody looked:
//
//   web/panels/terminal.js   the CODE banner printed  "CLONE FRAME OS · v0.5"   ← on screen
//   package-lock.json        still carried 0.2.0
//   bridge/package-lock.json still carried 0.1.0
//
// The banner one is the defect a user meets: run the banner in CODE and the app tells you
// it is v0.5 while the status bar, Settings and the daemon all say 0.3.0. There is exactly
// one carrier for a user-visible version — the build token @@CF_VERSION@@, which
// tools/build.mjs fills from package.json and refuses to emit unsubstituted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

// What the test must NOT do is force a rewrite of SVG path data: in `d="M20 6 v6.7"` the
// `v` is a vertical-lineto command, not a version, and the first draft of this test flagged
// eight of them. Strip, in this order — line comments before block comments, or a `//`
// inside a block comment survives and defeats the assertion it was written to support:
//   JS line · JS+CSS block · HTML · then every SVG geometry attribute.
// Whatever version-shaped string is left is in live code or on screen.
const strip = (s) => s
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\b(?:d|points|viewBox|transform)="[^"]*"/g, '');

const PANELS = readdirSync(path.join(ROOT, 'web', 'panels')).filter((f) => f.endsWith('.js'));
const VERSIONISH = /v\d+\.\d+(\.\d+)?/g;

test('no source ships a hardcoded version string to the screen', () => {
  const offenders = [];
  for (const rel of ['web/index.html', ...PANELS.map((f) => 'web/panels/' + f)]) {
    const src = strip(read(rel));
    for (const m of src.matchAll(VERSIONISH)) {
      // The build token is the one sanctioned carrier; it reads as v@@CF_VERSION@@.
      if (src.slice(Math.max(0, m.index - 2), m.index).endsWith('@@')) continue;
      offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}  ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'a literal version in the sources is a second source of truth, and it is the one the ' +
    'user reads. Use v@@CF_VERSION@@ — the build fills it from package.json:\n  ' +
    offenders.join('\n  '));
});

test('the CODE banner asks the build for the version, like iT and SETTINGS already do', () => {
  const t = read('web/panels/terminal.js');
  assert.match(t, /CLONE FRAME OS · v@@CF_VERSION@@/,
    'the neofetch banner in CODE is on screen — it must carry the build token, not a number');
  // The two panels that already did it right, pinned so the contract stays shared.
  assert.match(read('web/panels/shell.js'), /v@@CF_VERSION@@/);
  assert.match(read('web/panels/settings.js'), /v@@CF_VERSION@@/);
});

test('every lockfile agrees with the package.json beside it', () => {
  for (const dir of ['', 'bridge']) {
    const pkg = json(path.join(dir, 'package.json'));
    let lock;
    try { lock = json(path.join(dir, 'package-lock.json')); } catch { continue; }
    const where = dir ? dir + '/' : '';
    assert.equal(lock.version, pkg.version,
      `${where}package-lock.json says ${lock.version} but ${where}package.json says ${pkg.version} — ` +
      'a release that bumps one and not the other publishes a lie in the file npm reads');
    if (lock.packages && lock.packages['']) {
      assert.equal(lock.packages[''].version, pkg.version,
        `${where}package-lock.json root package still says ${lock.packages[''].version}`);
    }
  }
});

test('the double-click .app reports the manifest version, not a frozen one', () => {
  // make-app.sh hardcoded '0.2.0' in CFBundleShortVersionString while package.json said 0.3.0,
  // so Finder's Get Info on the app the owner double-clicks named a version two releases old.
  const sh = read('bridge/make-app.sh');
  assert.doesNotMatch(sh, /CFBundleShortVersionString string '\d/,
    'a literal version in the bundler is a fourth source of truth');
  assert.match(sh, /APP_VERSION="\$\(node -p "require\(/,
    'it must read package.json, like every other surface reads it through the build token');
});

test('the built app carries the package.json version and nothing else', () => {
  const v = json('package.json').version;
  const dist = read('dist/index.html');
  assert.ok(dist.includes('v' + v), `dist must show v${v}`);
  assert.equal((dist.match(/@@CF_VERSION@@/g) || []).length, 0,
    'an unsubstituted build token would ship literally');
  const strays = [...new Set([...strip(dist).matchAll(VERSIONISH)].map((m) => m[0]))]
    .filter((s) => s !== 'v' + v && s !== 'v' + v.split('.').slice(0, 2).join('.'));
  assert.deepEqual(strays, [],
    'the shipped file names a version that is not this one: ' + strays.join(', '));
});

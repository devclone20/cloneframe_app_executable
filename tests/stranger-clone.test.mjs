// P1 · the stranger test. Nobody had ever run this app from a fresh clone with no prior
// state, which is the only experience the community will have. Two things fell out.
//
// (1) A fresh public clone COULD NOT BUILD. tools/build.mjs imports esbuild, but the
//     README only told you to `npm install` inside bridge/ — never at the root. So
//     `npm run build` died on a missing package and `npm test` failed three tests on a
//     missing dist/index.html. The app itself ran fine (the committed root index.html is
//     the prebuilt artifact), so this hit exactly the person being invited: a contributor.
//
// (2) The boot banner PRINTED THE PAIRING TOKEN. That token is the whole authentication
//     for the daemon, and the banner is the first thing anyone copies into a bug report
//     or a screen recording — so it landed in launch.log, in scrollback, and in every
//     "here is my terminal output". The dev path that needed it still exists behind
//     HUB_BRIDGE_SHOW_TOKEN=1; it is no longer the default.
//
// Verified on a real clone of github.com/devclone20/cloneframe_app_executable: after a
// root npm install, 610/610 pass, and the hash it builds is the same one the repo ships
// and the same one the canonical tree freezes — 71268e4a…, six ways.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('npm test builds first, so a fresh clone is not three failures deep', () => {
  // Without this, tests/html-escape, tools/build.test and the INV-7 framing invariant all
  // ENOENT on dist/index.html — a clone's very first command reports the project broken.
  assert.equal(pkg.scripts.pretest, 'npm run build', 'pretest must build dist/ before the suite runs');
  assert.ok(pkg.devDependencies?.esbuild, 'the build dependency must be declared at the root');
});

test('the boot banner does not print the pairing token', () => {
  const src = read('bridge/hub-bridge.mjs');
  const at = src.indexOf('For the dev preview');
  assert.ok(at > 0, 'could not find the banner — this test needs updating');
  const banner = src.slice(at, at + 900);
  assert.match(banner, /if \(process\.env\.HUB_BRIDGE_SHOW_TOKEN === '1'\)/,
    'printing the token must be opt-in, never the default');
  assert.match(banner, /hidden — HUB_BRIDGE_SHOW_TOKEN=1 to print it/,
    'the banner must say the token is hidden and how to get it — silence would read as a bug');
  // The unguarded print is the regression to prevent: `${pair}` reachable with no env check.
  const lines = banner.split('\n');
  const printsPair = lines.filter((l) => l.includes('${pair}'));
  assert.equal(printsPair.length, 1, 'the full pairing URL must be printed from exactly one guarded place');
  const idx = lines.findIndex((l) => l.includes('${pair}'));
  assert.ok(lines.slice(Math.max(0, idx - 3), idx).some((l) => l.includes('HUB_BRIDGE_SHOW_TOKEN')),
    'the print must sit inside the opt-in guard');
});

test('the token file is still where the banner says it is', () => {
  // The banner now points at the file instead of printing the value. That pointer has to
  // stay true, or the dev path becomes folklore.
  const src = read('bridge/hub-bridge.mjs');
  assert.match(src, /token at ~\/\.clone-frame-hub\/bridge\.token · chmod 600/,
    'the banner must tell the owner where the token lives');
});

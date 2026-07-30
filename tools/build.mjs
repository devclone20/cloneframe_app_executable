#!/usr/bin/env node
// CLONE FRAME HUB — single-file assembler.
//
// Compiles web/index.html into ONE self-contained dist/index.html.
//
// INVARIANT-IDENTITY: with a directive-free web/index.html, the output is a byte-for-byte
// copy of the input (provable by `cmp`). This is the anchor T-005 hangs from and CI checks
// forever. As the monolith is peeled into web/styles/*.css and web/scripts/*.js, two
// build directives inline the pieces back — the output is ALWAYS self-contained (never a
// new <script src>/<link href>), so single-file deployability is never lost:
//
//   <style  data-cfbuild-src="styles/x.css"></style>   → x.css inlined verbatim between the tags
//   <script data-cfbuild-src="scripts/x.js"></script>  → esbuild-bundle x.js (iife), inlined
//                                     add data-cfbuild-min to minify (only when re-freezing golden)
//
// At Step 0 there are zero directives, so this runs on plain node with no dependencies;
// esbuild is imported lazily, only when a <script> directive actually appears.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genAppMap } from './gen-app-map.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const SRC = path.join(WEB, 'index.html');
const OUT = path.join(ROOT, 'dist', 'index.html');

// Keep the agent's app map in step with the panel registry: writes context/app-map.json and
// refreshes the AUTO PANELS block in agent/AGENTS.md from the real DEFS. Best-effort — it never
// touches dist/index.html, so the golden identity is untouched, and it never fails the build.
try { genAppMap({ silent: true }); } catch (e) { console.warn('app-map skipped:', e.message); }
// The agent's self-map: agent/STRUCTURE.md — a branch tree of the whole body, read from the
// real sources, restamped on every build (this IS pi's change-awareness signal). Runs after
// genAppMap so the panel branch can reuse the fresh context/app-map.json. Same contract:
// never touches dist, never fails the build.
try { const { genStructureTree } = await import('./gen-structure-tree.mjs'); genStructureTree({ silent: true }); }
catch (e) { console.warn('structure-tree skipped:', e.message); }

let html = readFileSync(SRC, 'utf8');

// 1) <style data-cfbuild-src="…"></style> → inline the css verbatim between the same tags.
//    No transform: if the file equals the original inner bytes, the output is byte-identical.
html = html.replace(/<style\s+data-cfbuild-src="([^"]+)"\s*><\/style>/g,
  (_m, rel) => `<style>${readFileSync(path.join(WEB, rel), 'utf8')}</style>`);

// 1.5) //@cfbuild-include panels/x.js → splice the file's RAW text in place, at the SAME scope.
//    This is how the classic main <script> is peeled into web/panels/* SOURCE PARTIALS without
//    the closure loss an esbuild IIFE would cause: a panel's wireX() still sees Bus/RPC/openPanel/
//    escHtml/… by lexical scope, exactly as when it was inline. The directive line (indentation +
//    the trailing newline) is replaced by the partial's bytes, and each partial stores EXACTLY the
//    lines that were cut — so the built dist is byte-for-byte unchanged by any extraction (the
//    golden sha stays frozen across the whole peel; that identity IS the proof a cut changed nothing).
html = html.replace(/^[ \t]*\/\/@cfbuild-include (\S+)[ \t]*\r?\n/gm,
  (_m, rel) => readFileSync(path.join(WEB, rel), 'utf8'));

// 2) <script data-cfbuild-src="…"[ data-cfbuild-min]></script> → esbuild bundle (iife), inline.
const directives = [...html.matchAll(/<script\s+data-cfbuild-src="([^"]+)"(\s+data-cfbuild-min)?\s*><\/script>/g)];
if (directives.length) {
  const { build } = await import('esbuild'); // lazy — only once JS is peeled out of the monolith
  for (const m of directives) {
    const [full, rel, min] = m;
    const r = await build({
      entryPoints: [path.join(WEB, rel)],
      bundle: true, format: 'iife', platform: 'browser', target: ['chrome110'],
      splitting: false, sourcemap: false, minify: Boolean(min), write: false,
    });
    html = html.replace(full, `<script>${r.outputFiles[0].text}</script>`);
  }
}

// 3) PARSE GATE — refuse to emit a document whose own JavaScript does not compile.
//
// This is here because it already happened. A settings section was written opening with a
// backtick and closing with a single quote; every check we had stayed green — the build
// concatenates text, the tests exercise bridge modules, the golden sha only proves the bytes
// are the SAME bytes — and the app shipped with an inline script that threw
// `SyntaxError: Unexpected token 'class'` on load. A syntax error in a classic script kills
// the WHOLE block: no pairing, no panels, no agent control plane. The window opens, the top
// bar renders from HTML, and everything behind it is dead. It took a debugger attached to the
// real window to see it.
//
// vm.Script COMPILES without executing — no browser globals are touched. Any inline block
// that is not classic JS (JSON-LD, importmap, module) is skipped rather than mis-parsed.
// ONE version number. It lived in six places — package.json, bridge/package.json, a hard-coded
// string in hub-bridge.mjs, and three literals in the UI — and they disagreed: 0.2.0 against
// "v0.4 EXTRACTION" against "v0.28 · WEB". A bug report quoting one cannot be matched against a
// tag named after another. The sources now carry @@CF_VERSION@@ and the build fills it from
// package.json, so the number has a single origin. The codenames (EXTRACTION, WEB) are left
// where they are: naming a release is the owner's, the number is mechanical.
{
  const v = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (!v) { console.error('\n  build REFUSED — package.json has no version.\n'); process.exit(1); }
  const before = (html.match(/@@CF_VERSION@@/g) || []).length;
  html = html.replaceAll('@@CF_VERSION@@', v);
  if (!before) { console.error('\n  build REFUSED — no @@CF_VERSION@@ token in the sources; the version would ship stale.\n'); process.exit(1); }
}

{
  const { Script } = await import('node:vm');
  const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  for (const [, attrs, body] of blocks) {
    if (/\ssrc=/.test(attrs)) continue;                                  // external — nothing inline to parse
    const type = (attrs.match(/\stype=["']([^"']+)["']/) || [, ''])[1].toLowerCase();
    if (type && !/^(text\/javascript|application\/javascript)$/.test(type)) continue;
    if (!body.trim()) continue;
    try { new Script(body); }
    catch (e) {
      // Report the line in the DOCUMENT, not in the block, so the number is clickable.
      const offset = html.slice(0, html.indexOf(body)).split('\n').length;
      const line = offset + (Number((/(\d+)/.exec(String(e.stack || '').split('\n')[0]) || [])[1]) || 0) - 1;
      console.error(`\n  build REFUSED — dist/index.html would not parse.\n  ${e.message}\n  around line ${line} of the built document.\n`);
      process.exit(1);
    }
  }
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log('build → dist/index.html  ·  sha256', createHash('sha256').update(html).digest('hex'));

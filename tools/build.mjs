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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const SRC = path.join(WEB, 'index.html');
const OUT = path.join(ROOT, 'dist', 'index.html');

let html = readFileSync(SRC, 'utf8');

// 1) <style data-cfbuild-src="…"></style> → inline the css verbatim between the same tags.
//    No transform: if the file equals the original inner bytes, the output is byte-identical.
html = html.replace(/<style\s+data-cfbuild-src="([^"]+)"\s*><\/style>/g,
  (_m, rel) => `<style>${readFileSync(path.join(WEB, rel), 'utf8')}</style>`);

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

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log('build → dist/index.html  ·  sha256', createHash('sha256').update(html).digest('hex'));

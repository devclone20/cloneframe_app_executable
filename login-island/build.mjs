/* One-shot offline build: bundles react + react-dom + @privy-io/react-auth into a
   single self-contained file served by the bridge next to index.html.
   Run: npm install && npm run build   (build machine only) */
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

const out = new URL('../privy-login.js', import.meta.url).pathname;

// Some transitive deps (pino) probe optional Node-only pretty printers; stub them.
const stubs = {
  name: 'node-stubs',
  setup(b) {
    b.onResolve({ filter: /^(pino-pretty)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}', loader: 'js' }));
  },
};

await build({
  entryPoints: [new URL('./src/island.jsx', import.meta.url).pathname],
  outfile: out,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis',
  },
  plugins: [stubs],
});
console.log('built', out);

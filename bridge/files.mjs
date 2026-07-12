// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — files
// File operations exposed to the agent as tools. Path safety only; the
// permission gate (permissions.mjs) decides whether the agent may call write.
// ─────────────────────────────────────────────────────────────────────────────
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const HOME = homedir();
function resolve(p, base) {
  if (!p) return null;
  let s = String(p);
  if (s.startsWith('~')) s = path.join(HOME, s.slice(1));
  if (!path.isAbsolute(s)) s = path.resolve(base || HOME, s);
  return s;
}
const CATASTROPHIC = new Set(['/', HOME, path.join(HOME, ''), '/System', '/usr', '/bin', '/etc']);

// Secret stores the agent must NEVER read or write — even with every permission ON.
// This is the source-of-truth guard behind servers.mjs's _public() masking: the bridge's
// own modules write these via their own fs calls, so blocking the agent-facing Files tool
// here costs nothing and closes the "read_file ~/.clone-frame-hub/servers.json" leak.
const SECRET_DIRS = [
  path.join(HOME, '.clone-frame-hub'), path.join(HOME, '.ssh'), path.join(HOME, '.aws'),
  path.join(HOME, '.gnupg'), path.join(HOME, '.config', 'gh'), path.join(HOME, 'Library', 'Keychains'),
];
const SECRET_FILES = new Set([
  path.join(HOME, '.env'), path.join(HOME, '.env.local'), path.join(HOME, '.env.production'),
  path.join(HOME, '.netrc'), path.join(HOME, '.npmrc'), path.join(HOME, '.pgpass'),
]);
function isSecret(f) {
  if (!f) return false;
  if (SECRET_FILES.has(f)) return true;
  return SECRET_DIRS.some(b => f === b || f.startsWith(b + path.sep));
}
const SECRET_ERR = { ok: false, error: 'refused: protected location (keys/tokens/secrets)' };

export const Files = {
  list(dir, opts = {}) {
    const d = resolve(dir || '.', opts.cwd);
    if (isSecret(d)) return SECRET_ERR;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true }).map(e => {
        let size = 0; try { size = fs.statSync(path.join(d, e.name)).size; } catch {}
        return { name: e.name, type: e.isDirectory() ? 'dir' : (e.isSymbolicLink() ? 'link' : 'file'), size };
      });
      return { ok: true, dir: d, entries };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  read(p, opts = {}) {
    const f = resolve(p, opts.cwd); const maxKB = opts.maxKB || 512;
    if (isSecret(f)) return SECRET_ERR;
    try {
      const st = fs.statSync(f);
      if (st.size > maxKB * 1024) return { ok: false, error: `file too large (${Math.round(st.size / 1024)}KB > ${maxKB}KB)` };
      return { ok: true, path: f, text: fs.readFileSync(f, 'utf8') };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  write(p, content, opts = {}) {
    const f = resolve(p, opts.cwd);
    if (!f) return { ok: false, error: 'no path' };
    if (isSecret(f)) return SECRET_ERR;
    const s = String(content == null ? '' : content);
    if (s.length > 8 * 1024 * 1024) return { ok: false, error: 'content too large (>8MB)' };
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (opts.append) fs.appendFileSync(f, s); else fs.writeFileSync(f, s);
      return { ok: true, path: f, bytes: Buffer.byteLength(s) };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  mkdir(p, opts = {}) { const d = resolve(p, opts.cwd); if (isSecret(d)) return SECRET_ERR; try { fs.mkdirSync(d, { recursive: true }); return { ok: true, path: d }; } catch (e) { return { ok: false, error: e.message }; } },
  remove(p, opts = {}) {
    const f = resolve(p, opts.cwd);
    if (!f || CATASTROPHIC.has(f) || f === HOME) return { ok: false, error: 'refused: catastrophic path' };
    if (isSecret(f)) return SECRET_ERR;
    try { fs.rmSync(f, { recursive: true, force: true }); return { ok: true, path: f }; } catch (e) { return { ok: false, error: e.message }; }
  },
  stat(p, opts = {}) {
    const f = resolve(p, opts.cwd);
    if (isSecret(f)) return SECRET_ERR;
    try { const st = fs.statSync(f); return { ok: true, info: { path: f, size: st.size, dir: st.isDirectory(), mtime: st.mtimeMs } }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
  exists(p, opts = {}) { try { const f = resolve(p, opts && opts.cwd); if (isSecret(f)) return false; return fs.existsSync(f); } catch { return false; } },
};
export default Files;

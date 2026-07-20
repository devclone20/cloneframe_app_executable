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
const CATASTROPHIC = new Set(['/', HOME, '/System', '/usr', '/bin', '/etc']);

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

// Shallow, budgeted tree measurement for copy(). Uses lstat so symlinks are counted
// as entries but never followed — no infinite loops, no accidental traversal into
// linked secret stores. Bails the instant either budget is exceeded.
function measureTree(root, budget) {
  const stack = [root];
  let bytes = 0, files = 0, visited = 0;
  while (stack.length) {
    if (++visited > budget.maxFiles) return { over: true };
    const cur = stack.pop();
    let st; try { st = fs.lstatSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      let names; try { names = fs.readdirSync(cur); } catch { continue; }
      for (const n of names) stack.push(path.join(cur, n));
    } else {
      bytes += st.size; files += 1;
      if (bytes > budget.maxBytes || files > budget.maxFiles) return { over: true };
    }
  }
  return { over: false, bytes, files };
}

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
  move(src, dst, opts = {}) {
    const s = resolve(src, opts.cwd), d0 = resolve(dst, opts.cwd);
    if (!s || !d0) return { ok: false, error: 'no path' };
    if (isSecret(s) || isSecret(d0)) return SECRET_ERR;
    if (CATASTROPHIC.has(s) || s === HOME) return { ok: false, error: 'refused: catastrophic path' };
    if (!fs.existsSync(s)) return { ok: false, error: 'source not found' };
    let target = d0;
    try { if (fs.statSync(d0).isDirectory()) target = path.join(d0, path.basename(s)); } catch {}
    if (target === s || target.startsWith(s + path.sep)) return { ok: false, error: 'cannot move a folder into itself' };
    if (fs.existsSync(target) && opts.overwrite !== true) return { ok: false, error: 'destination exists' };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try { fs.renameSync(s, target); }
      catch (e) {
        if (e && e.code === 'EXDEV') { fs.cpSync(s, target, { recursive: true }); fs.rmSync(s, { recursive: true, force: true }); }
        else throw e;
      }
      return { ok: true, from: s, to: target };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  copy(src, dst, opts = {}) {
    const s = resolve(src, opts.cwd), d0 = resolve(dst, opts.cwd);
    if (!s || !d0) return { ok: false, error: 'no path' };
    if (isSecret(s) || isSecret(d0)) return SECRET_ERR;
    if (!fs.existsSync(s)) return { ok: false, error: 'source not found' };
    let target = d0;
    try { if (fs.statSync(d0).isDirectory()) target = path.join(d0, path.basename(s)); } catch {}
    if (target === s || target.startsWith(s + path.sep)) return { ok: false, error: 'cannot copy a folder into itself' };
    if (fs.existsSync(target) && opts.overwrite !== true) return { ok: false, error: 'destination exists' };
    if (measureTree(s, { maxBytes: 200 * 1024 * 1024, maxFiles: 20000 }).over) return { ok: false, error: 'too large to copy in-app' };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(s, target, { recursive: true, errorOnExist: !opts.overwrite, force: !!opts.overwrite });
      return { ok: true, from: s, to: target };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  writeB64(p, b64, opts = {}) {
    const f = resolve(p, opts.cwd);
    if (!f) return { ok: false, error: 'no path' };
    if (isSecret(f)) return SECRET_ERR;
    const maxMB = opts.maxMB || 25;
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length > maxMB * 1024 * 1024) return { ok: false, error: `file too large (>${maxMB}MB)` };
    if (fs.existsSync(f) && opts.overwrite !== true) return { ok: false, error: 'destination exists' };
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, buf);
      return { ok: true, path: f, bytes: buf.length };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  exists(p, opts = {}) { try { const f = resolve(p, opts && opts.cwd); if (isSecret(f)) return false; return fs.existsSync(f); } catch { return false; } },
};
export default Files;

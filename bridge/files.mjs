// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — files
// File operations exposed to the agent as tools. Path safety lives HERE (resolve + the secret
// -store blocklist); WHETHER an agent may write is decided one layer up, by the /mod router
// consulting Permissions.agentGateFor — write / writeB64 / mkdir / remove / move / copy need
// the owner's fileWrite switch when the caller marks itself as the agent. Reads are open, so
// the agent can still see the project it is working on, and the owner's own UI is never gated.
// (This sentence used to claim the gate without one existing; it does now.)
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
// Canonicalise before comparing. This guard used to compare raw strings, and that left two
// separate ways straight past it:
//
//   CASE — macOS ships APFS case-INSENSITIVE by default, so `~/.SSH/id_ed25519` and
//     `~/.ssh/id_ed25519` are the SAME FILE to the kernel and two different strings here.
//     An audit walked out with a real private key through `~/.SSH/`, read the Google token
//     store through `~/.CLONE-FRAME-HUB/oauth.json`, and listed `~/.Clone-Frame-Hub/` entry
//     by entry — while SECURITY.md promised all three were blocked server-side.
//   SYMLINK — a link placed anywhere the agent may write, pointing into `~/.ssh`, was just
//     as invisible to a string compare.
//
// realpathSync.native answers both: it returns the on-disk casing AND resolves links.
//
// Paths that do not exist yet have no realpath, and those matter — `write` and `mkdir` are
// exactly how a new file appears inside a secret directory. So walk up to the nearest
// ancestor that does exist, canonicalise that, and re-attach the tail.
function canon(f) {
  let head = String(f), tail = '';
  for (;;) {
    try { return tail ? path.join(fs.realpathSync.native(head), tail) : fs.realpathSync.native(head); }
    catch { /* not on disk yet — try the parent */ }
    const up = path.dirname(head);
    if (up === head) return String(f); // reached the root and found nothing real
    tail = tail ? path.join(path.basename(head), tail) : path.basename(head);
    head = up;
  }
}
// Fold case only where the filesystem does. Folding on Linux would refuse a genuinely
// distinct path that the owner is entitled to read.
const FOLD = process.platform === 'darwin' || process.platform === 'win32';
const norm = (s) => (FOLD ? String(s).toLowerCase() : String(s));
// Canonicalised once at load: the protected locations do not move while the daemon runs.
const CANON_SECRET_DIRS = SECRET_DIRS.map((d) => norm(canon(d)));
const CANON_SECRET_FILES = new Set([...SECRET_FILES].map((f) => norm(canon(f))));
function isSecret(f) {
  if (!f) return false;
  const c = norm(canon(f));
  if (CANON_SECRET_FILES.has(c)) return true;
  return CANON_SECRET_DIRS.some((b) => c === b || c.startsWith(b + path.sep));
}
const SECRET_ERR = { ok: false, error: 'refused: protected location (keys/tokens/secrets)' };

// The two field guides mirrored into ~/.clone-frame-hub are PUBLIC docs — they ship in the
// public repo, and the agent's own system prompt tells it to `read_file` them for depth.
// Everything else in that dir is secret (tokens, JSON stores, logs). Allow READS of exactly
// these two files, nothing more (list/write/delete stay fully blocked).
const PUBLIC_HUB_FILES = new Set([
  path.join(HOME, '.clone-frame-hub', 'AGENTS.md'),
  path.join(HOME, '.clone-frame-hub', 'APP-MAP.md'),
]);
const CANON_PUBLIC_HUB_FILES = new Set([...PUBLIC_HUB_FILES].map((f) => norm(canon(f))));
const isPublicHubFile = (f) => CANON_PUBLIC_HUB_FILES.has(norm(canon(f)));

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

// macOS TCC denies whole folders (Desktop, Documents, Downloads…) to a process that
// was launched before the permission existed — and reports it as a bare EPERM, which
// reads like a broken app. Name the real cause, and the fact that a restart is part
// of the fix (TCC is evaluated at process start).
function fsErr(e, target) {
  const m = (e && e.message) || String(e);
  if (e && (e.code === 'EPERM' || e.code === 'EACCES'))
    return `macOS is blocking access to ${target} — grant Full Disk Access to node in System Settings → Privacy & Security, then relaunch the app (permissions apply at start-up)`;
  return m;
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
    } catch (e) { return { ok: false, error: fsErr(e, d) }; }
  },
  read(p, opts = {}) {
    // Default stays modest for agent/tool callers; the iT/FOLDERS file viewer passes its
    // own big maxKB (65536) — the owner reads and edits large source files in-app.
    const f = resolve(p, opts.cwd); const maxKB = opts.maxKB || 512;
    // The allowlist is canonicalised the same way the guard is: a reader asking for
    // ~/.CLONE-FRAME-HUB/AGENTS.md means the same file, and should get the same answer.
    if (!isPublicHubFile(f) && isSecret(f)) return SECRET_ERR;
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
    // 64MB — must at least match what the file viewer can OPEN, or a big file becomes
    // read-only by accident (open at 64MB, fail to save at 8MB).
    if (s.length > 64 * 1024 * 1024) return { ok: false, error: 'content too large (>64MB)' };
    // CREATING a file and SAVING one are different intentions, and only the second may
    // destroy what is there. Callers that mean "make a new one" pass noClobber; the editor's
    // save and the agent's write do not, so nothing else changes. Opt-in deliberately:
    // defaulting to refuse would silently break every save path in the app.
    if (opts.noClobber && fs.existsSync(f)) return { ok: false, error: path.basename(f) + ' is already here — pick another name' };
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

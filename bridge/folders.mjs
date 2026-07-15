// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — folders
// The Folder System: a visible ~/CloneFrame directory the user can edit both
// in-app and in Finder. Holds models, agents (neural_soul.md), data, caches,
// harnesses, server pointers, downloads, logs. Secrets NEVER live here — they
// stay in ~/.clone-frame-hub. This module never deletes anything.
// ─────────────────────────────────────────────────────────────────────────────
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const HOME = homedir();
const DIR = path.join(HOME, '.clone-frame-hub');
const FILE = path.join(DIR, 'folders.json');
const DEFAULT_ROOT = path.join(HOME, 'CloneFrame');
const FORBIDDEN_ROOTS = new Set(['/', '/System', '/usr', '/bin', '/etc', '/sbin', '/var', '/private', HOME]);
const MARKER = '.clone-frame';
const TREE_CAP = 500;
const STATS_CAP = 5000;

// Single source of truth for the canonical skeleton (POSIX relative paths).
const TREE = [
  { rel: 'Models', desc: 'AI models managed by the app' },
  { rel: 'Models/local', desc: 'local weights (exo / MLX / GGUF)' },
  { rel: 'Models/remote', desc: 'manifests / pointers to hosted/remote models' },
  { rel: 'Agents', desc: 'one folder per agent/iNFT (neural_soul.md, memory/, config.json — created on demand)' },
  { rel: 'Data', desc: 'user data the app produces' },
  { rel: 'Data/research', desc: 'saved research runs' },
  { rel: 'Data/gallery', desc: 'generated images' },
  { rel: 'Data/exports', desc: 'exports' },
  { rel: 'Cache', desc: 'safe-to-clear caches' },
  { rel: 'Cache/web', desc: 'browser/reader cache' },
  { rel: 'Cache/models', desc: 'model download cache' },
  { rel: 'Harnesses', desc: 'harness definitions' },
  { rel: 'Servers', desc: 'non-secret pointers to online servers (secrets live in ~/.clone-frame-hub, never here)' },
  { rel: 'Downloads', desc: 'things the app downloads' },
  { rel: 'Logs', desc: 'logs' },
  { rel: 'Workspaces', desc: 'one folder per CLONE FRAME surface — drop files here and they appear in that tab' },
  { rel: 'Workspaces/CODE', desc: 'files & projects the CODE tab works on' },
  { rel: 'Workspaces/CODE/projects', desc: 'projects the CODE tab works on' },
  { rel: 'Workspaces/CODE/sessions', desc: 'exported transcripts' },
  { rel: 'Workspaces/CODE/scratch', desc: 'scratch space' },
  { rel: 'Workspaces/Terminal', desc: 'working dirs for standalone terminals' },
  { rel: 'Workspaces/Terminal/workdirs', desc: 'terminal working directories' },
  { rel: 'Workspaces/Terminal/logs', desc: 'terminal logs' },
  { rel: 'Workspaces/HARNESS', desc: 'harness crews & runs' },
  { rel: 'Workspaces/HARNESS/crews', desc: 'harness crews' },
  { rel: 'Workspaces/HARNESS/runs', desc: 'harness runs' },
  { rel: 'Workspaces/LAB', desc: 'exo clusters, chats, models' },
  { rel: 'Workspaces/LAB/clusters', desc: 'exo clusters' },
  { rel: 'Workspaces/LAB/chats', desc: 'lab chats' },
  { rel: 'Workspaces/LAB/models', desc: 'lab models' },
  { rel: 'Workspaces/CLI-EconomyOS', desc: 'agents built & deployed on each network' },
  { rel: 'Workspaces/CLI-EconomyOS/Virtuals', desc: 'Virtuals network' },
  { rel: 'Workspaces/CLI-EconomyOS/Virtuals/agents', desc: 'Virtuals agents' },
  { rel: 'Workspaces/CLI-EconomyOS/Virtuals/drafts', desc: 'Virtuals drafts' },
  { rel: 'Workspaces/CLI-EconomyOS/Robinhood', desc: 'Robinhood network' },
  { rel: 'Workspaces/CLI-EconomyOS/Robinhood/agents', desc: 'Robinhood agents' },
  { rel: 'Workspaces/CLI-EconomyOS/Robinhood/launches', desc: 'Robinhood launches' },
  { rel: 'Workspaces/CLI-EconomyOS/Robinhood/drafts', desc: 'Robinhood drafts' },
  { rel: 'Workspaces/CLI-EconomyOS/OKX-AI', desc: 'OKX-AI network' },
  { rel: 'Workspaces/CLI-EconomyOS/OKX-AI/listings', desc: 'OKX-AI listings' },
  { rel: 'Workspaces/CLI-EconomyOS/OKX-AI/drafts', desc: 'OKX-AI drafts' },
  { rel: 'Workspaces/CLI-EconomyOS/OKX-AI/tasks', desc: 'OKX-AI tasks' },
  { rel: 'Workspaces/INTEGRATIONS', desc: 'external tools you bring into CLONE FRAME' },
  { rel: 'Workspaces/INTEGRATIONS/EXO-LAB', desc: 'EXO-LAB integration' },
  { rel: 'Workspaces/INTEGRATIONS/Manaflow', desc: 'Manaflow integration' },
  { rel: 'Workspaces/INTEGRATIONS/TMUX', desc: 'TMUX integration' },
  { rel: 'Workspaces/Browser', desc: 'browser downloads & bookmarks' },
  { rel: 'Workspaces/Browser/downloads', desc: 'browser downloads' },
  { rel: 'Workspaces/Browser/bookmarks', desc: 'browser bookmarks' },
];

// App panel TYPE KEYS → the Workspaces rel path that belongs to that surface.
const SURFACES = {
  terminal: 'Workspaces/CODE',
  shell: 'Workspaces/Terminal',
  harness: 'Workspaces/HARNESS',
  lab: 'Workspaces/LAB',
  economyos: 'Workspaces/CLI-EconomyOS',
  virtuals: 'Workspaces/CLI-EconomyOS/Virtuals',
  robinhood: 'Workspaces/CLI-EconomyOS/Robinhood',
  okxai: 'Workspaces/CLI-EconomyOS/OKX-AI',
  integrate: 'Workspaces/INTEGRATIONS',
  research: 'Workspaces/Browser',
};

function loadConf() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function saveConf(o) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const t = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(t, JSON.stringify(o), { mode: 0o600 });
  fs.renameSync(t, FILE);
}
function expandHome(p) {
  let s = String(p);
  if (s === '~') return HOME;
  if (s.startsWith('~/') || s.startsWith('~' + path.sep)) return path.join(HOME, s.slice(2));
  return s;
}
function rootPath() {
  const c = loadConf();
  if (typeof c.root === 'string' && c.root.trim()) {
    const r = path.resolve(expandHome(c.root.trim()));
    if (path.isAbsolute(r)) return r;
  }
  return DEFAULT_ROOT;
}
// Escape-proof resolution: canonicalize rel against root, assert containment.
function resolveWithin(root, rel) {
  const r = String(rel == null ? '' : rel);
  if (r.includes('\0')) return null;
  if (r.split(/[\\/]+/).includes('..')) return null;
  const abs = path.resolve(root, r);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}
function readmeText() {
  const lines = TREE.map(n => `- \`${n.rel}\` — ${n.desc}`).join('\n');
  return `# CloneFrame\n\nThis folder is managed by CLONE FRAME HUB. Everything the app installs or\nproduces lives here. You can edit these files directly in Finder — the app\nsees the same files.\n\n## Layout\n\n${lines}\n\nSecrets are never stored in this folder — they live in \`~/.clone-frame-hub\`.\nDeleting \`Cache\` contents is always safe.\n`;
}
// Shallow-recursive du with a hard visit budget; never throws.
function du(dir, budget) {
  let items = 0, bytes = 0;
  const stack = [dir];
  while (stack.length && budget > 0) {
    const d = stack.pop();
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (budget-- <= 0) return { items, bytes };
      const full = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      items++;
      try { bytes += fs.statSync(full).size; } catch {}
    }
  }
  return { items, bytes };
}

export const Folders = {
  root() {
    try {
      const root = rootPath();
      return { ok: true, root, exists: fs.existsSync(root) };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  setRoot(p) {
    try {
      if (!p || !String(p).trim()) return { ok: false, error: 'no path' };
      const s = String(p).trim();
      if (s.includes('\0')) return { ok: false, error: 'invalid path' };
      const abs = path.resolve(expandHome(s));
      if (!path.isAbsolute(abs)) return { ok: false, error: 'path must be absolute or ~-relative' };
      if (FORBIDDEN_ROOTS.has(abs)) return { ok: false, error: `refused: ${abs} cannot be the CloneFrame root` };
      if ((HOME + path.sep).startsWith(abs + path.sep)) return { ok: false, error: 'refused: root cannot be above the home folder' };
      const conf = loadConf(); conf.root = abs; saveConf(conf);
      return { ok: true, root: abs };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  structure() {
    try {
      const root = rootPath();
      const nodes = TREE.map(n => ({
        rel: n.rel, desc: n.desc, kind: 'dir',
        exists: fs.existsSync(path.join(root, ...n.rel.split('/'))),
      }));
      return { ok: true, root, nodes };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  ensure() {
    try {
      const root = rootPath();
      const created = [], already = [];
      if (fs.existsSync(root)) already.push('.'); else { fs.mkdirSync(root, { recursive: true, mode: 0o755 }); created.push('.'); }
      for (const n of TREE) {
        const abs = path.join(root, ...n.rel.split('/'));
        if (fs.existsSync(abs)) { already.push(n.rel); continue; }
        fs.mkdirSync(abs, { recursive: true, mode: 0o755 });
        created.push(n.rel);
      }
      const readme = path.join(root, 'README.md');
      if (!fs.existsSync(readme)) fs.writeFileSync(readme, readmeText());
      const marker = path.join(root, MARKER);
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify({ app: 'clone-frame-hub', created: Date.now() }));
      return { ok: true, root, created, already };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  tree(rel = '') {
    try {
      const root = rootPath();
      const abs = resolveWithin(root, rel);
      if (!abs) return { ok: false, error: 'refused: path escapes the CloneFrame root' };
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const items = [];
      for (const e of entries) {
        if (items.length >= TREE_CAP) break;
        const full = path.join(abs, e.name);
        let size = 0, mtime = 0, dir = e.isDirectory();
        try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; dir = st.isDirectory(); } catch {}
        items.push({ name: e.name, type: dir ? 'dir' : 'file', size, mtime, rel: path.posix.join(String(rel || ''), e.name) });
      }
      items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
      return { ok: true, rel: String(rel || ''), abs, items };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  stats() {
    try {
      const root = rootPath();
      const totals = TREE.filter(n => !n.rel.includes('/')).map(n => {
        const { items, bytes } = du(path.join(root, n.rel), STATS_CAP);
        return { rel: n.rel, label: n.desc, items, bytes };
      });
      return { ok: true, root, totals };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  agentDir(name) {
    try {
      const clean = String(name == null ? '' : name).replace(/[^\w .-]/g, '').trim().slice(0, 64);
      if (!clean || /^[. ]+$/.test(clean)) return { ok: false, error: 'invalid agent name' };
      const root = rootPath();
      const dir = resolveWithin(root, path.posix.join('Agents', clean));
      if (!dir) return { ok: false, error: 'refused: path escapes the CloneFrame root' };
      fs.mkdirSync(path.join(dir, 'memory'), { recursive: true, mode: 0o755 });
      const soul = path.join(dir, 'neural_soul.md');
      if (!fs.existsSync(soul)) fs.writeFileSync(soul, `# ${clean} — Neural Soul\n\n## Identity\n\n## Lobes\n\n## Limits\n`);
      const config = path.join(dir, 'config.json');
      if (!fs.existsSync(config)) fs.writeFileSync(config, '{}');
      return { ok: true, dir, soul };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  revealPath(rel = '') {
    try {
      const abs = resolveWithin(rootPath(), rel);
      if (!abs) return { ok: false, error: 'refused: path escapes the CloneFrame root' };
      return { ok: true, abs };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  surfaces() {
    try {
      const root = rootPath();
      const surfaces = [];
      for (const [key, rel] of Object.entries(SURFACES)) {
        const abs = resolveWithin(root, rel);
        if (!abs) continue;
        surfaces.push({ key, rel, abs, exists: fs.existsSync(abs) });
      }
      return { ok: true, root, surfaces };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  surfaceRel(key) {
    try {
      const rel = Object.prototype.hasOwnProperty.call(SURFACES, key) ? SURFACES[key] : null;
      if (!rel) return { ok: false, error: 'unknown surface' };
      const abs = resolveWithin(rootPath(), rel);
      if (!abs) return { ok: false, error: 'refused: path escapes the CloneFrame root' };
      return { ok: true, rel, abs };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  surfaceTree(key) {
    const rel = Object.prototype.hasOwnProperty.call(SURFACES, key) ? SURFACES[key] : null;
    if (!rel) return { ok: false, error: 'unknown surface' };
    return this.tree(rel);
  },

  addFolder(parentRel, name) {
    try {
      const clean = String(name == null ? '' : name).replace(/[^\w .-]/g, '').trim().slice(0, 64);
      if (!clean || clean === '.' || clean === '..' || /^[. ]+$/.test(clean)) return { ok: false, error: 'invalid folder name' };
      const root = rootPath();
      const parentAbs = resolveWithin(root, parentRel);
      if (!parentAbs) return { ok: false, error: 'refused: path escapes the CloneFrame root' };
      const rel = path.posix.join(String(parentRel || ''), clean);
      const abs = resolveWithin(root, rel);
      if (!abs) return { ok: false, error: 'refused: path escapes the CloneFrame root' };
      fs.mkdirSync(abs, { recursive: true, mode: 0o755 });
      return { ok: true, rel, abs };
    } catch (e) { return { ok: false, error: e.message }; }
  },
};
export default Folders;
